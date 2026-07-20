//! helm: the standalone terminal client. Spawns its own bridge, dials its
//! attach fd, folds the event stream into the concerns (conversation, usage,
//! approvals), and renders them through ratatui. Typing goes to the editor;
//! Enter says (with the true tip as premise), Alt+Enter breaks the line,
//! Esc re-pins the scroll or cancels the live query, Ctrl+Y/Ctrl+N answer
//! the oldest live approval, Ctrl+C quits. Wheel scrolls; click
//! expands/collapses a thinking/tool block.

mod approvals;
mod command;
mod conversation;
mod editor;
mod transport;
mod usage;
mod view;

use approvals::Approvals;
use command::CommandMode;
use conversation::Conversation;
use crossterm::event::{
    DisableMouseCapture, EnableMouseCapture, Event as TermEvent, KeyCode, KeyModifiers,
    KeyboardEnhancementFlags, MouseButton, MouseEventKind, PopKeyboardEnhancementFlags,
    PushKeyboardEnhancementFlags,
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

    // Args: `--adopt <conv-id>` resumes an existing conversation (history
    // replayed over the attach fd); a free argument is a one-shot say.
    let mut adopt: Option<String> = None;
    let mut one_shot: Option<String> = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--adopt" {
            adopt = args.next();
        } else {
            one_shot = Some(arg);
        }
    }

    let mut session = Session::spawn(&bridge_path, nats_url.as_deref()).await?;
    let conv_id = match &adopt {
        Some(conv) => session.adopt_conversation(conv).await?,
        None => session.spawn_conversation().await?,
    };

    if let Some(text) = one_shot {
        session.say(&conv_id, &text, None, Vec::new()).await?;
    }

    let mut terminal = ratatui::init(); // alt screen + raw mode, restored by ratatui::restore
    let _ = crossterm::execute!(std::io::stdout(), EnableMouseCapture);
    // Kitty keyboard protocol, where the terminal supports it: without it,
    // Cmd+Enter never reaches the app at all. Ctrl+Enter is the fallback
    // everywhere else. Best-effort push, popped on exit.
    let _ = crossterm::execute!(
        std::io::stdout(),
        PushKeyboardEnhancementFlags(KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES)
    );
    let mut input = spawn_input_thread();

    let mut conv = Conversation::default();
    let mut usage = Usage::default();
    let mut approvals = Approvals::default();
    let mut view_state = ViewState::default();
    let mut editor = Editor::default();
    let mut note: Option<String> = None;
    // Attachments pinned to the next say: (chip label, reference block).
    let mut attachments: Vec<(String, serde_json::Value)> = Vec::new();
    let mut geometry = Geometry::default();
    let mut hits: Vec<Option<BlockKey>> = Vec::new();

    let result: anyhow::Result<()> = async {
        loop {
            let chip_labels: Vec<String> = attachments.iter().map(|(l, _)| l.clone()).collect();
            terminal.draw(|frame| {
                let screen = view::Screen {
                    conv_id: &conv_id.0,
                    conv: &conv,
                    usage: &usage,
                    approvals: &approvals,
                    editor: &editor,
                    note: note.as_deref(),
                    attachments: &chip_labels,
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
                            // A revoked say comes home: words to the editor.
                            if let Some(text) = conv.restore_say.take() {
                                restore_to(&mut editor, &text);
                                note = Some("say revoked — returned to the editor".into());
                            }
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
                        // Ctrl+/ is command mode's one door, from any state.
                        // Kitty-protocol terminals report it as ctrl+'/';
                        // the legacy byte is 0x1F, which crossterm decodes as
                        // ctrl+'7' (0x1C..=0x1F → '4'..='7') and xterm lore
                        // calls ctrl+'_' — all three spellings accepted,
                        // because tmux strips the kitty protocol back to
                        // legacy bytes regardless of the outer terminal.
                        TermEvent::Key(key)
                            if matches!(
                                key.code,
                                KeyCode::Char('/') | KeyCode::Char('_') | KeyCode::Char('7')
                            ) && key.modifiers.contains(KeyModifiers::CONTROL) =>
                        {
                            view_state.command.toggle();
                        }
                        // While command mode is open it claims every key:
                        // bound ones fire intents, the rest are swallowed.
                        TermEvent::Key(key) if view_state.command.is_open() => {
                            match &mut view_state.command {
                                CommandMode::Root => match key.code {
                                    KeyCode::Esc => view_state.command.escape(),
                                    KeyCode::Char('f') => {
                                        view_state.command = CommandMode::AttachEdit(Editor::default());
                                    }
                                    KeyCode::Char('d') => {
                                        attachments.pop();
                                    }
                                    KeyCode::Char(answer @ ('y' | 'n')) => {
                                        let target = approvals
                                            .live(now_ms())
                                            .first()
                                            .map(|(id, _)| id.to_string());
                                        if let Some(id) = target {
                                            session.answer(&id, answer == 'y').await?;
                                            view_state.command = CommandMode::Closed;
                                        }
                                    }
                                    _ => {}
                                },
                                CommandMode::AttachEdit(overlay) => match (key.code, key.modifiers) {
                                    (KeyCode::Esc, _) => view_state.command.escape(),
                                    (KeyCode::Enter, _) => {
                                        let path = overlay.take();
                                        let path = path.trim().to_string();
                                        if !path.is_empty() {
                                            match session.upload_attachment(&path).await {
                                                Ok(chip) => {
                                                    attachments.push(chip);
                                                    note = None;
                                                }
                                                Err(e) => note = Some(format!("attach failed: {e}")),
                                            }
                                        }
                                        view_state.command = CommandMode::Closed;
                                    }
                                    (KeyCode::Backspace, _) => overlay.backspace(),
                                    (KeyCode::Delete, _) => overlay.delete(),
                                    (KeyCode::Left, _) => overlay.left(),
                                    (KeyCode::Right, _) => overlay.right(),
                                    (KeyCode::Home, _) => overlay.home(),
                                    (KeyCode::End, _) => overlay.end(),
                                    (KeyCode::Char(c), KeyModifiers::NONE | KeyModifiers::SHIFT) => {
                                        overlay.insert(c);
                                    }
                                    _ => {}
                                },
                                CommandMode::Closed => unreachable!("guarded by is_open"),
                            }
                        }
                        TermEvent::Key(key) => match (key.code, key.modifiers) {
                            (KeyCode::Char('c'), KeyModifiers::CONTROL) => break,
                            (KeyCode::Enter, m)
                                if m.contains(KeyModifiers::SUPER)
                                    || m.contains(KeyModifiers::CONTROL) =>
                            {
                                if !editor.is_empty() || !attachments.is_empty() {
                                    let text = editor.take();
                                    let tip = conv.messages.last().map(|m| m.id.clone());
                                    let blocks: Vec<serde_json::Value> =
                                        attachments.iter().map(|(_, b)| b.clone()).collect();
                                    match session.say(&conv_id, &text, tip, blocks).await? {
                                        wire::SayOutcome::Accepted { .. } => {
                                            note = None;
                                            conv.pending_say = Some(text);
                                            attachments.clear(); // committed with the say
                                        }
                                        wire::SayOutcome::Rejected { reason } => {
                                            note = Some(format!("say rejected: {reason}"));
                                            restore_to(&mut editor, &text);
                                        }
                                        wire::SayOutcome::Unreachable => {
                                            note = Some("say unreachable".into());
                                            restore_to(&mut editor, &text);
                                        }
                                    }
                                    view_state.scroll_from_bottom = 0; // a say re-pins to the tail
                                }
                            }
                            (KeyCode::Enter, _) => editor.newline(),
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

    let _ = crossterm::execute!(std::io::stdout(), PopKeyboardEnhancementFlags);
    let _ = crossterm::execute!(std::io::stdout(), DisableMouseCapture);
    ratatui::restore();
    result
}

/// Put a say's text back into the editor — the one path for every failure
/// shape (rejection, unreachable, revoked closure).
fn restore_to(editor: &mut Editor, text: &str) {
    for c in text.chars() {
        editor.insert(c);
    }
}
