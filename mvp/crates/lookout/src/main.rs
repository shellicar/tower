//! The lookout daemon's composition root: read the environment once, connect,
//! cold start, then wait.
//!
//! Cold start reads the registry for the workers that exist now, takes each
//! one up, and ticks once. That first tick relays whatever is already stale,
//! which is the recovery path: a worker that died while nothing was watching
//! publishes no event ever, so only a tick can find it. It will also repeat
//! anything the previous process had already said, because what was said dies
//! with that process. That is the cheaper side of the trade.
//!
//! After that the daemon waits on three things at once. An event folds into
//! the facts and says nothing. A change to the registry takes up a worker or
//! lets one go, so a worker commissioned after boot is watched like any other.
//! The clock classifies everything, delivers one digest per handler, and acks.

use bridge::broker::{Broker, BrokerDurable, BrokerKvWatch, BrokerMessage, KvChange, NatsBroker};
use lookout::daemon::Lookout;
use lookout::watch::{Config, read_lines};
use std::time::Duration;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let url = std::env::var("NATS_URL").unwrap_or_else(|_| "nats://127.0.0.1:4222".into());
    let config = Config {
        stream: std::env::var("LOOKOUT_STREAM").unwrap_or_else(|_| "conv-approval".into()),
        telemetry_stream: std::env::var("LOOKOUT_TELEMETRY_STREAM")
            .unwrap_or_else(|_| "conv-diagnostic".into()),
        bucket: std::env::var("LOOKOUT_REPORTING_BUCKET")
            .unwrap_or_else(|_| "reporting-lines".into()),
        thresholds: lookout::classify::Thresholds {
            quiet_after_ms: env_seconds("LOOKOUT_QUIET_AFTER_S", 600) * 1_000,
            // Fifteen minutes because that is the agent host's hard maximum
            // for a tool run: past it a tool has not finished late, it has not
            // finished at all. It is configurable because that limit is the
            // host's and can move, and the two drifting apart silently is how
            // a live worker gets reported or a dead one gets missed.
            tool_max_ms: env_seconds("LOOKOUT_TOOL_MAX_S", 900) * 1_000,
        },
        say_timeout: Duration::from_secs(env_seconds("LOOKOUT_SAY_TIMEOUT_S", 5) as u64),
    };
    // The tick is both the poll for absence and the batch boundary: events
    // arriving between ticks become one delivery, and a delivery a handler
    // rejected is retried on the next one against a freshly read tip.
    let tick_every = Duration::from_secs(env_seconds("LOOKOUT_TICK_S", 15) as u64);
    let durable_prefix =
        std::env::var("LOOKOUT_DURABLE_PREFIX").unwrap_or_else(|_| "lookout".into());

    let broker = NatsBroker {
        client: async_nats::connect(&url).await?,
    };
    eprintln!("lookout watching {} on {url}", config.bucket);

    let mut lookout = Lookout::<NatsBroker>::new(durable_prefix);

    // The watch opens before the read, so a line written between the two
    // arrives as a change rather than falling into the gap.
    //
    // Neither is fatal. Nothing in this repo writes the bucket, and watching
    // nothing is a valid state for a daemon whose registry has not been
    // created yet: it stays up, says so, and picks the bucket up when the
    // clock next comes round.
    let mut registry = match broker.kv_watch(config.bucket.clone()).await {
        Ok(watch) => Some(watch),
        Err(e) => {
            eprintln!(
                "lookout: not watching {} for changes: {:#}",
                config.bucket,
                anyhow::Error::new(e)
            );
            None
        }
    };
    match read_lines(&broker, &config.bucket).await {
        Ok((lines, complaints)) => {
            for complaint in &complaints {
                eprintln!("lookout: {complaint}");
            }
            for line in lines {
                report(lookout.take_up(&broker, &config, line).await);
            }
        }
        Err(e) => eprintln!(
            "lookout: {} could not be read, so nothing is being watched yet: {:#}",
            config.bucket,
            anyhow::Error::new(e)
        ),
    }
    eprintln!("lookout: watching {} worker(s)", lookout.watching().len());

    tick(&broker, &config, &mut lookout).await;

    let mut interval = tokio::time::interval(tick_every);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    interval.tick().await;
    loop {
        match next_wake(&mut interval, &mut lookout, &mut registry).await {
            Wake::Tick => tick(&broker, &config, &mut lookout).await,
            Wake::Event { index, frame } => {
                if let Some(complaint) = lookout.observe(index, &frame.subject, &frame.payload) {
                    eprintln!("lookout: {complaint}");
                }
            }
            Wake::Line(change) => {
                let complaints = lookout
                    .line_changed(&broker, &config, &change.key, change.value.as_deref())
                    .await;
                for complaint in complaints {
                    eprintln!("lookout: {complaint}");
                }
            }
            Wake::Failed { index, error } => {
                eprintln!(
                    "lookout: {} tail failed: {:#}",
                    lookout.worker_at(index),
                    anyhow::Error::new(error)
                );
            }
            // A tail that ends has nothing more to say, and dropping it keeps
            // the select from spinning on an exhausted stream. The worker's
            // facts stay, so the clock still covers it.
            Wake::Ended { index } => {
                eprintln!("lookout: {} tail ended", lookout.source_ended(index));
            }
            // The registry watch ending leaves the daemon on what it already
            // holds. It keeps watching those workers rather than exiting.
            Wake::RegistryEnded => {
                eprintln!("lookout: the registry watch ended; no new workers will be picked up");
                registry = None;
            }
        }
    }
}

enum Wake {
    Tick,
    Event {
        index: usize,
        frame: BrokerMessage,
    },
    Line(KvChange),
    Failed {
        index: usize,
        error: bridge::broker::BrokerError,
    },
    Ended {
        index: usize,
    },
    RegistryEnded,
}

/// Wait for whichever comes first: the clock, a change to the registry, or an
/// event on any worker's tail. The unfinished reads are dropped when one wins,
/// which costs nothing — a pull consumer's next read resumes where it was.
async fn next_wake(
    interval: &mut tokio::time::Interval,
    lookout: &mut Lookout<NatsBroker>,
    registry: &mut Option<<NatsBroker as Broker>::KvWatch>,
) -> Wake {
    let sources = lookout.sources_mut();
    let mut tails: Vec<_> = sources
        .iter_mut()
        .map(|source| Box::pin(source.tail.next()))
        .collect();
    let lines = async {
        match registry {
            Some(registry) => registry.next().await,
            None => std::future::pending().await,
        }
    };
    tokio::select! {
        _ = interval.tick() => Wake::Tick,
        change = lines => match change {
            Some(Ok(change)) => Wake::Line(change),
            Some(Err(e)) => {
                eprintln!("lookout: registry watch failed: {:#}", anyhow::Error::new(e));
                Wake::RegistryEnded
            }
            None => Wake::RegistryEnded,
        },
        (frame, index, _) = select_tails(&mut tails) => match frame {
            Some(Ok(frame)) => Wake::Event { index, frame },
            Some(Err(error)) => Wake::Failed { index, error },
            None => Wake::Ended { index },
        },
    }
}

/// `select_all` panics on an empty set, and a lookout watching nobody is an
/// ordinary state — it waits for its first line.
async fn select_tails<F: std::future::Future + Unpin>(tails: &mut [F]) -> (F::Output, usize, ()) {
    if tails.is_empty() {
        return std::future::pending().await;
    }
    let (output, index, _) = futures::future::select_all(tails.iter_mut()).await;
    (output, index, ())
}

async fn tick(broker: &NatsBroker, config: &Config, lookout: &mut Lookout<NatsBroker>) {
    let now = wire::now_iso();
    let Some(now_ms) = wire::parse_ts(&now) else {
        eprintln!("lookout: the clock produced an unreadable timestamp {now:?}");
        return;
    };
    let outcome = lookout.tick(broker, config, now_ms, &now).await;
    for complaint in &outcome.complaints {
        eprintln!("lookout: {complaint}");
    }
}

fn report(outcome: Result<Vec<String>, bridge::broker::BrokerError>) {
    match outcome {
        Ok(complaints) => {
            for complaint in complaints {
                eprintln!("lookout: {complaint}");
            }
        }
        Err(e) => eprintln!("lookout: {:#}", anyhow::Error::new(e)),
    }
}

fn env_seconds(name: &str, default: i64) -> i64 {
    std::env::var(name)
        .ok()
        .and_then(|raw| raw.parse::<i64>().ok())
        .filter(|seconds| *seconds > 0)
        .unwrap_or(default)
}
