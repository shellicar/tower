//! The lookout daemon's composition root: read the environment once, connect,
//! cold start, then tail.
//!
//! Cold start is ordered, and the order is the point. The durable consumers
//! open first, so nothing published while the replay runs is missed. The
//! replay rebuilds each worker's two facts and relays nothing. Then one tick,
//! which is the recovery path: anything genuinely stale surfaces immediately,
//! including a worker that died mid-turn and will never publish again.
//!
//! After that the loop has two mouths. An event folds into the facts and says
//! nothing; the tick classifies everything, delivers one digest per handler,
//! and only then acks. Ack after the relay, never before: a crash between an
//! ack and a say loses the event silently.

use bridge::broker::{Broker, BrokerDurable, BrokerError, NatsBroker};
use lookout::lines::ReportingLine;
use lookout::watch::{Config, Watch, read_lines};
use std::time::Duration;

/// A worker's tail, and which worker it belongs to.
struct Tail {
    worker: String,
    durable: <NatsBroker as Broker>::Durable,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let url = std::env::var("NATS_URL").unwrap_or_else(|_| "nats://127.0.0.1:4222".into());
    // The same variable spawn.mts reads, so an override points both halves at
    // the same bucket and a test never touches the one the fleet runs on.
    let bucket =
        std::env::var("NATS_REPORTING_BUCKET").unwrap_or_else(|_| "reporting-lines".into());
    let config = Config {
        stream: std::env::var("LOOKOUT_STREAM").unwrap_or_else(|_| "conv-approval".into()),
        bucket,
        quiet_after_ms: env_seconds("LOOKOUT_QUIET_AFTER_S", 600) * 1_000,
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

    let (lines, complaints) = read_lines(&broker, &config.bucket).await?;
    for complaint in &complaints {
        eprintln!("lookout: {complaint}");
    }

    let mut watch = Watch::default();
    let mut tails = Vec::new();
    for line in lines {
        match take_up(&broker, &config, &durable_prefix, &mut watch, line).await {
            Ok(tail) => tails.push(tail),
            Err(e) => eprintln!("lookout: {:#}", anyhow::Error::new(e)),
        }
    }
    eprintln!("lookout: watching {} worker(s)", tails.len());

    tick(&broker, &config, &mut watch, &mut tails).await;

    let mut interval = tokio::time::interval(tick_every);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    interval.tick().await;
    loop {
        let wake = next_wake(&mut interval, &mut tails).await;
        match wake {
            Wake::Tick => tick(&broker, &config, &mut watch, &mut tails).await,
            Wake::Event { index, frame } => {
                let worker = tails[index].worker.clone();
                if let Some(complaint) = watch.observe(&worker, &frame.subject, &frame.payload) {
                    eprintln!("lookout: {complaint}");
                }
            }
            Wake::Failed { index, error } => {
                eprintln!(
                    "lookout: {} tail failed: {:#}",
                    tails[index].worker,
                    anyhow::Error::new(error)
                );
            }
            // A tail that ends has nothing more to say, and dropping it keeps
            // the select from spinning on an exhausted stream. The worker's
            // facts stay, so the clock still covers it.
            Wake::Ended { index } => {
                eprintln!("lookout: {} tail ended", tails[index].worker);
                tails.remove(index);
            }
        }
    }
}

enum Wake {
    Tick,
    Event {
        index: usize,
        frame: bridge::broker::BrokerMessage,
    },
    Failed {
        index: usize,
        error: BrokerError,
    },
    Ended {
        index: usize,
    },
}

/// Wait for whichever comes first: the clock, or an event on any worker's
/// tail. The unfinished reads are dropped when one wins, which costs nothing
/// — a pull consumer's next read resumes where it was.
async fn next_wake(interval: &mut tokio::time::Interval, tails: &mut [Tail]) -> Wake {
    if tails.is_empty() {
        interval.tick().await;
        return Wake::Tick;
    }
    let polls: Vec<_> = tails
        .iter_mut()
        .map(|tail| Box::pin(tail.durable.next()))
        .collect();
    tokio::select! {
        _ = interval.tick() => Wake::Tick,
        (frame, index, _) = futures::future::select_all(polls) => match frame {
            Some(Ok(frame)) => Wake::Event { index, frame },
            Some(Err(error)) => Wake::Failed { index, error },
            None => Wake::Ended { index },
        },
    }
}

/// Open a worker's tail before replaying its history, so an event published
/// during the replay is delivered rather than lost between the two.
async fn take_up(
    broker: &NatsBroker,
    config: &Config,
    durable_prefix: &str,
    watch: &mut Watch,
    line: ReportingLine,
) -> Result<Tail, BrokerError> {
    let worker = line.worker.clone();
    let durable = broker
        .durable(
            config.stream.clone(),
            format!("conv.v2.{worker}.changes.>"),
            format!("{durable_prefix}-{worker}"),
        )
        .await?;
    for complaint in watch.seed(broker, config, line).await? {
        eprintln!("lookout: {complaint}");
    }
    Ok(Tail { worker, durable })
}

async fn tick(broker: &NatsBroker, config: &Config, watch: &mut Watch, tails: &mut [Tail]) {
    let now = wire::now_iso();
    let Some(now_ms) = wire::parse_ts(&now) else {
        eprintln!("lookout: the clock produced an unreadable timestamp {now:?}");
        return;
    };
    let outcome = watch.tick(broker, config, now_ms, &now).await;
    for complaint in &outcome.complaints {
        eprintln!("lookout: {complaint}");
    }
    for tail in tails.iter_mut() {
        if !watch.may_ack(&tail.worker, &outcome) {
            continue;
        }
        if let Err(e) = tail.durable.ack_delivered().await {
            eprintln!(
                "lookout: {} could not ack: {:#}",
                tail.worker,
                anyhow::Error::new(e)
            );
        }
    }
}

fn env_seconds(name: &str, default: i64) -> i64 {
    std::env::var(name)
        .ok()
        .and_then(|raw| raw.parse::<i64>().ok())
        .filter(|seconds| *seconds > 0)
        .unwrap_or(default)
}
