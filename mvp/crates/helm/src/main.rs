//! helm: the standalone terminal client. Spawns its own bridge, dials its
//! attach fd, folds the event stream into the concerns (conversation, usage,
//! approvals), and renders them through ratatui. Input is minimal for now:
//! q quits, y/n answers the oldest live approval. The editor concern (typing
//! a say) is the next slice; a one-shot say still rides argv.

mod approvals;
mod conversation;
mod transport;
mod usage;
mod view;

use approvals::Approvals;
use conversation::Conversation;
use crossterm::event::{Event as TermEvent, KeyCode, KeyEvent, KeyModifiers};
use transport::Session;
use usage::Usage;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Blocking crossterm reads on a plain thread, forwarded into the async
/// select loop. Killed implicitly at exit: the thread is a daemon by drop.
fn spawn_input_thread() -> tokio::sync::mpsc::UnboundedReceiver<KeyEvent> {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    std::thread::spawn(move || {
        loop {
            match crossterm::event::read() {
                Ok(TermEvent::Key(key)) => {
                    if tx.send(key).is_err() {
                        return;
                    }
                }
                Ok(_) => {} // resize is handled by ratatui's next draw
                Err(_) => return,
            }
        }
    });
    rx
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let bridge_path = std::env::var("HELM_BRIDGE_PATH").unwrap_or_else(|_| "bridge".into());
    let nats_url = std::env::var("NATS_URL").ok();
    let mut session = Session::spawn(&bridge_path, nats_url.as_deref()).await?;
    let conv_id = session.spawn_conversation().await?;

    if let Some(text) = std::env::args().nth(1) {
        session.say(&conv_id, &text).await?;
    }

    let mut terminal = ratatui::init(); // alt screen + raw mode, restored by ratatui::restore
    let mut keys = spawn_input_thread();

    let mut conv = Conversation::default();
    let mut usage = Usage::default();
    let mut approvals = Approvals::default();

    let result: anyhow::Result<()> = async {
        loop {
            terminal.draw(|frame| {
                view::draw(frame, &conv_id.0, &conv, &usage, &approvals, now_ms());
            })?;

            tokio::select! {
                event = session.next_event() => {
                    let Some(event) = event? else {
                        break; // attach fd closed: bridge is gone
                    };
                    match wire::parse_wire(&event.subject, &event.payload) {
                        Some(wire::WireEvent::Conv(decoded)) => {
                            conv.fold(&decoded.kind);
                            usage.fold(&decoded.kind);
                        }
                        Some(wire::WireEvent::Approval(decoded)) => {
                            approvals.fold(&decoded.id.0, &decoded.kind);
                        }
                        _ => {}
                    }
                }
                key = keys.recv() => {
                    let Some(key) = key else { break };
                    match (key.code, key.modifiers) {
                        (KeyCode::Char('q'), _) | (KeyCode::Char('c'), KeyModifiers::CONTROL) => break,
                        (KeyCode::Char(answer @ ('y' | 'n')), _) => {
                            // The oldest live ask is the one a human is being
                            // asked about; the settlement folds back via the
                            // attach fd like any other event.
                            let target = approvals
                                .live(now_ms())
                                .first()
                                .map(|(id, _)| id.to_string());
                            if let Some(id) = target {
                                session.answer(&id, answer == 'y').await?;
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
        Ok(())
    }
    .await;

    ratatui::restore();
    result
}
