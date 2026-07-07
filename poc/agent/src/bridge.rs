//! The NATS bridge: subjects, the startup announce, and the receive loop that
//! enforces one turn at a time. Ownership of the [`AgentCore`] moves into the
//! running turn's task and comes back when it finishes; an input that arrives
//! while it is away is rejected with a broadcast `error` event.
//!
//! Also carries the spec's two desirables: request/reply history on
//! `agent.{id}.history`, and an `agent_ready` heartbeat on `agent.announce`
//! every 10 seconds.

use std::time::Duration;

use anyhow::{Context, Result};
use futures::StreamExt;
use tokio::sync::mpsc;
use tokio::task::{JoinError, JoinHandle};
use tokio::time::{Instant, interval_at};

use crate::agent::AgentCore;
use crate::model::ModelClient;
use crate::protocol::{ChatMessage, ClientMessage, Event, HistoryReply};

const HEARTBEAT: Duration = Duration::from_secs(10);

pub struct Subjects {
    pub announce: String,
    pub events: String,
    pub messages: String,
    pub history: String,
}

impl Subjects {
    pub fn for_agent(id: &str) -> Self {
        Self {
            announce: "agent.announce".into(),
            events: format!("agent.{id}.events"),
            messages: format!("agent.{id}.messages"),
            history: format!("agent.{id}.history"),
        }
    }
}

pub async fn run<M: ModelClient>(
    nats: async_nats::Client,
    agent_id: String,
    core: AgentCore<M>,
) -> Result<()> {
    let subjects = Subjects::for_agent(&agent_id);
    let mut inbox = nats
        .subscribe(subjects.messages.clone())
        .await
        .context("subscribing to messages subject")?;
    let mut history_inbox = nats
        .subscribe(subjects.history.clone())
        .await
        .context("subscribing to history subject")?;

    // The turn task and the reject path both emit events through this channel;
    // a single forwarding task owns publishing, so event order is preserved.
    let (events_tx, mut events_rx) = mpsc::channel::<Event>(64);
    let publisher: JoinHandle<Result<()>> = {
        let nats = nats.clone();
        let subject = subjects.events.clone();
        tokio::spawn(async move {
            while let Some(event) = events_rx.recv().await {
                let payload = serde_json::to_vec(&event)?;
                nats.publish(subject.clone(), payload.into())
                    .await
                    .context("publishing event")?;
            }
            Ok(())
        })
    };

    // Announce on both subjects per the spec: discovery on `agent.announce`,
    // and a copy on the events subject for anyone already watching it.
    let ready = serde_json::to_vec(&Event::AgentReady {
        agent_id: agent_id.clone(),
    })?;
    nats.publish(subjects.announce.clone(), ready.clone().into())
        .await
        .context("announcing on agent.announce")?;
    nats.publish(subjects.events.clone(), ready.clone().into())
        .await
        .context("announcing on events subject")?;
    nats.flush().await.context("flushing announce")?;

    // First heartbeat one period from now — the announce above already covered
    // the immediate tick an `interval` would fire.
    let mut heartbeat = interval_at(Instant::now() + HEARTBEAT, HEARTBEAT);

    // History is served from a snapshot taken at turn boundaries, because the
    // core is away in the turn task while a turn runs. Mid-turn requests see
    // the conversation as of the last completed turn.
    let mut snapshot: Vec<ChatMessage> = core.conversation().to_vec();
    let mut idle: Option<AgentCore<M>> = Some(core);
    let mut running: Option<JoinHandle<AgentCore<M>>> = None;

    loop {
        tokio::select! {
            maybe = inbox.next() => {
                let Some(msg) = maybe else {
                    break; // Subscription closed: the NATS connection is gone.
                };
                match ClientMessage::parse(&msg.payload) {
                    Ok(ClientMessage::UserInput(input)) => {
                        if running.is_some() {
                            let _ = events_tx.send(Event::Error {
                                turn_id: None,
                                message: "turn already in progress".into(),
                            }).await;
                        } else if let Some(mut core) = idle.take() {
                            let tx = events_tx.clone();
                            running = Some(tokio::spawn(async move {
                                core.run_turn(input, &tx).await;
                                core
                            }));
                        }
                    }
                    // Unknown `type` values are skipped without error, per the spec.
                    Ok(ClientMessage::Unknown) => {}
                    Err(e) => {
                        let _ = events_tx.send(Event::Error {
                            turn_id: None,
                            message: format!("unparseable message: {e}"),
                        }).await;
                    }
                }
            }
            Some(request) = history_inbox.next() => {
                if let Some(reply_to) = request.reply {
                    let payload = serde_json::to_vec(&HistoryReply {
                        messages: snapshot.clone(),
                    })?;
                    nats.publish(reply_to, payload.into())
                        .await
                        .context("replying to history request")?;
                }
            }
            _ = heartbeat.tick() => {
                nats.publish(subjects.announce.clone(), ready.clone().into())
                    .await
                    .context("publishing heartbeat")?;
            }
            finished = wait(&mut running), if running.is_some() => {
                running = None;
                let core = finished.context("turn task panicked")?;
                snapshot = core.conversation().to_vec();
                idle = Some(core);
            }
        }
    }

    drop(events_tx);
    publisher.await.context("publisher task panicked")??;
    Ok(())
}

/// Await the running turn's task. The `pending()` arm is unreachable — the
/// select guard requires `running.is_some()` — but keeps the code unwrap-free.
async fn wait<M>(
    running: &mut Option<JoinHandle<AgentCore<M>>>,
) -> Result<AgentCore<M>, JoinError> {
    match running.as_mut() {
        Some(handle) => handle.await,
        None => std::future::pending().await,
    }
}
