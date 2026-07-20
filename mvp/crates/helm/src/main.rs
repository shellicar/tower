//! helm: the standalone terminal client. Spawns its own bridge, dials its
//! attach fd, folds the event stream into the concerns (conversation, usage,
//! approvals), and renders them through ratatui. Input: q quits, y/n answers
//! the oldest live approval, wheel scrolls, click expands/collapses a
//! thinking/tool block. The editor concern (typing a say) is the next slice;
//! a one-shot say still rides argv.

mod approvals;
mod conversation;
mod transport;
mod usage;
mod view;

use approvals::Approvals;
use conversation::Conversation;
use crossterm::event::{
    DisableMouseCapture, EnableMouseCapture, Event as TermEvent, KeyCode, KeyModifiers,
    MouseButton, MouseEventKind,
};
use transport::Session;
use usage::Usage;
use view::{BlockKey, Geometry, ViewState};

const WHEEL_LINES: usize = 3;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Blocking crossterm reads on a plain thread, forwarded into the async
/// select loop. Key and mouse both; resize is handled by ratatui's next draw.
fn spawn_input_thread() -> tokio::sync::mpsc::UnboundedReceiver<TermEvent> {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    std::thread::spawn(move || {
        loop {
            match crossterm::event::read() {
                Ok(event @ (TermEvent::Key(_) | TermEvent::Mouse(_))) => {
                    if tx.send(event).is_err() {
                        return;
                    }
                }
                Ok(_) => {}
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
    let _ = crossterm::execute!(std::io::stdout(), EnableMouseCapture);
    let mut input = spawn_input_thread();

    let mut conv = Conversation::default();
    let mut usage = Usage::default();
    let mut approvals = Approvals::default();
    let mut view_state = ViewState::default();
    let mut geometry = Geometry::default();
    let mut hits: Vec<Option<BlockKey>> = Vec::new();

    let result: anyhow::Result<()> = async {
        loop {
            terminal.draw(|frame| {
                let (g, h) = view::draw(
                    frame,
                    &conv_id.0,
                    &conv,
                    &usage,
                    &approvals,
                    &mut view_state,
                    now_ms(),
                );
                geometry = g;
                hits = h;
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
                event = input.recv() => {
                    let Some(event) = event else { break };
                    match event {
                        TermEvent::Key(key) => match (key.code, key.modifiers) {
                            (KeyCode::Char('q'), _) | (KeyCode::Char('c'), KeyModifiers::CONTROL) => break,
                            (KeyCode::Char(answer @ ('y' | 'n')), _) => {
                                let target = approvals
                                    .live(now_ms())
                                    .first()
                                    .map(|(id, _)| id.to_string());
                                if let Some(id) = target {
                                    session.answer(&id, answer == 'y').await?;
                                }
                            }
                            (KeyCode::End, _) | (KeyCode::Esc, _) => view_state.scroll_from_bottom = 0,
                            (KeyCode::PageUp, _) => view_state.scroll_from_bottom += geometry.inner.height as usize,
                            (KeyCode::PageDown, _) => {
                                view_state.scroll_from_bottom = view_state
                                    .scroll_from_bottom
                                    .saturating_sub(geometry.inner.height as usize);
                            }
                            _ => {}
                        },
                        TermEvent::Mouse(mouse) => match mouse.kind {
                            MouseEventKind::ScrollUp => view_state.scroll_from_bottom += WHEEL_LINES,
                            MouseEventKind::ScrollDown => {
                                view_state.scroll_from_bottom =
                                    view_state.scroll_from_bottom.saturating_sub(WHEEL_LINES);
                            }
                            MouseEventKind::Down(MouseButton::Left) => {
                                let inner = geometry.inner;
                                let inside = mouse.column >= inner.x
                                    && mouse.column < inner.x + inner.width
                                    && mouse.row >= inner.y
                                    && mouse.row < inner.y + inner.height;
                                if inside {
                                    let index = (mouse.row - inner.y) as usize;
                                    if let Some(Some(key)) = hits.get(index) {
                                        view_state.toggle(key.clone());
                                    }
                                }
                            }
                            _ => {}
                        },
                        _ => {}
                    }
                }
            }
        }
        Ok(())
    }
    .await;

    let _ = crossterm::execute!(std::io::stdout(), DisableMouseCapture);
    ratatui::restore();
    result
}
