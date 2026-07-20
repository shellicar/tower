//! helm: the standalone terminal client. Spawns its own bridge, dials its
//! attach fd, folds the event stream into the concerns (conversation, usage,
//! approvals), and renders them through ratatui. Typing goes to the editor;
//! Enter says (with the true tip as premise), Alt+Enter breaks the line,
//! Esc re-pins the scroll or cancels the live query, Ctrl+Y/Ctrl+N answer
//! the oldest live approval, Ctrl+C quits. Wheel scrolls; click
//! expands/collapses a thinking/tool block.

mod approvals;
mod conversation;
mod editor;
mod transport;
mod usage;
mod view;

use approvals::Approvals;
use conversation::Conversation;
use crossterm::event::{
    DisableMouseCapture, EnableMouseCapture, Event as TermEvent, KeyCode, KeyModifiers,
    MouseButton, MouseEventKind,
};
use editor::Editor;
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
        session.say(&conv_id, &text, None).await?;
    }

    let mut terminal = ratatui::init(); // alt screen + raw mode, restored by ratatui::restore
    let _ = crossterm::execute!(std::io::stdout(), EnableMouseCapture);
    let mut input = spawn_input_thread();

    let mut conv = Conversation::default();
    let mut usage = Usage::default();
    let mut approvals = Approvals::default();
    let mut view_state = ViewState::default();
    let mut editor = Editor::default();
    let mut note: Option<String> = None;
    let mut geometry = Geometry::default();
    let mut hits: Vec<Option<BlockKey>> = Vec::new();

    let result: anyhow::Result<()> = async {
        loop {
            terminal.draw(|frame| {
                let screen = view::Screen {
                    conv_id: &conv_id.0,
                    conv: &conv,
                    usage: &usage,
                    approvals: &approvals,
                    editor: &editor,
                    note: note.as_deref(),
                };
                let (g, h) = view::draw(frame, &screen, &mut view_state, now_ms());
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
                            (KeyCode::Char('c'), KeyModifiers::CONTROL) => break,
                            (KeyCode::Char(answer @ ('y' | 'n')), KeyModifiers::CONTROL) => {
                                let target = approvals
                                    .live(now_ms())
                                    .first()
                                    .map(|(id, _)| id.to_string());
                                if let Some(id) = target {
                                    session.answer(&id, answer == 'y').await?;
                                }
                            }
                            (KeyCode::Enter, KeyModifiers::ALT) => editor.newline(),
                            (KeyCode::Enter, _) => {
                                if !editor.is_empty() {
                                    let text = editor.take();
                                    let tip = conv.messages.last().map(|m| m.id.clone());
                                    note = match session.say(&conv_id, &text, tip).await? {
                                        wire::SayOutcome::Accepted { .. } => None,
                                        wire::SayOutcome::Rejected { reason } => {
                                            Some(format!("say rejected: {reason}"))
                                        }
                                        wire::SayOutcome::Unreachable => {
                                            Some("say unreachable".into())
                                        }
                                    };
                                    view_state.scroll_from_bottom = 0; // a say re-pins to the tail
                                }
                            }
                            (KeyCode::Esc, _) => {
                                // Scrolled: re-pin. Pinned with a live query: cancel it.
                                if view_state.scroll_from_bottom > 0 {
                                    view_state.scroll_from_bottom = 0;
                                } else if let Some(query) = conv.live_query.clone() {
                                    note = match session.cancel(&conv_id, &query).await? {
                                        wire::CancelOutcome::Accepted => None,
                                        wire::CancelOutcome::Rejected { reason } => {
                                            Some(format!("cancel rejected: {reason}"))
                                        }
                                        wire::CancelOutcome::Unreachable => {
                                            Some("cancel unreachable".into())
                                        }
                                    };
                                }
                            }
                            (KeyCode::Backspace, _) => editor.backspace(),
                            (KeyCode::Delete, _) => editor.delete(),
                            (KeyCode::Left, _) => editor.left(),
                            (KeyCode::Right, _) => editor.right(),
                            (KeyCode::Home, _) => editor.home(),
                            (KeyCode::End, _) => editor.end(),
                            (KeyCode::PageUp, _) => view_state.scroll_from_bottom += geometry.inner.height as usize,
                            (KeyCode::PageDown, _) => {
                                view_state.scroll_from_bottom = view_state
                                    .scroll_from_bottom
                                    .saturating_sub(geometry.inner.height as usize);
                            }
                            (KeyCode::Char(c), KeyModifiers::NONE | KeyModifiers::SHIFT) => {
                                editor.insert(c);
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
