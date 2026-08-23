//! helm: the standalone terminal client. Spawns its own bridge, dials its
//! attach fd, folds the event stream into the concerns (conversation, usage,
//! approvals), and renders them through ratatui. Typing goes to the editor;
//! Enter says (with the true tip as premise), Alt+Enter breaks the line,
//! Esc re-pins the scroll or cancels the live query, Ctrl+Y/Ctrl+N answer
//! the oldest live approval, Ctrl+C quits. Wheel scrolls; click
//! expands/collapses a thinking/tool block.

mod approvals;
mod clipboard;
mod command;
mod config;
mod conversation;
mod markdown;
mod submit;
mod transport;
mod usage;
mod view;

use approvals::Approvals;
use command::CommandMode;
use conversation::Conversation;
use crossterm::event::{
    DisableMouseCapture, EnableMouseCapture, Event as TermEvent, KeyCode, KeyEventKind,
    KeyModifiers, KeyboardEnhancementFlags, MouseButton, MouseEventKind,
    PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
};
use submit::{Chip, FileKind, build_submit};
use transport::Session;
use tui_textarea::TextArea;
use usage::Usage;
use view::{Geometry, ViewState};

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

/// `HELM_BRIDGE_PATH` wins outright. Otherwise, since cargo puts every
/// workspace binary in the same `target/{debug,release}/`, a `bridge` next
/// to helm's own executable is almost always the one meant — checked before
/// falling back to bare `"bridge"` on `$PATH`, which only development's
/// `just dev` (or an installed bridge) satisfies.
fn resolve_bridge_path() -> String {
    if let Ok(path) = std::env::var("HELM_BRIDGE_PATH") {
        return path;
    }
    let sibling = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("bridge")));
    match sibling {
        Some(path) if path.is_file() => path.to_string_lossy().into_owned(),
        _ => "bridge".into(),
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let bridge_path = resolve_bridge_path();

    // Args: `--adopt <conv-id>` resumes an existing conversation (history
    // replayed over the attach fd); `-c <batch>` is bridge's own startup-config
    // grammar one layer up (config.rs) — one JSON object per line, applied in
    // order BEFORE the spawn/adopt, since bridge will not serve a conversation
    // until a `model` line has named a model and a maxTokens, and nothing
    // defaults them; a free argument is a one-shot say.
    let mut adopt: Option<String> = None;
    let mut one_shot: Option<String> = None;
    let mut config_batch: Option<String> = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--adopt" {
            adopt = args.next();
        } else if arg == "-c" {
            config_batch = args.next();
        } else {
            one_shot = Some(arg);
        }
    }

    let mut session = Session::spawn(&bridge_path).await?;

    // Created here, before the alt screen, so the -c batch's outcomes have
    // somewhere to land (`l` reopens this later in-session) as well as
    // printing to stderr — the one moment this process can still write to
    // the real terminal directly, before ratatui::init() claims the screen.
    let mut view_state = ViewState::default();
    if let Some(batch) = config_batch {
        for outcome in config::apply_config_batch(&mut session, &batch).await {
            let line = format_config_outcome(&outcome);
            eprintln!("helm: {line}");
            view_state.log_config(&line);
        }
    }

    let conv_id = match &adopt {
        Some(conv) => session.adopt_conversation(conv).await?,
        None => session.spawn_conversation().await?,
    };

    if let Some(text) = one_shot {
        session
            .requester()
            .say(&conv_id, &text, None, Vec::new())
            .await?;
    }

    let requester = session.requester();
    // Request outcomes fold back through this channel: the render loop never
    // awaits a round-trip (the frontend's async-say shape — optimistic
    // state, reconciled when the outcome lands).
    let (done_tx, mut done_rx) = tokio::sync::mpsc::unbounded_channel::<Done>();

    let mut terminal = ratatui::init(); // alt screen + raw mode, restored by ratatui::restore
    let _ = crossterm::execute!(std::io::stdout(), EnableMouseCapture);
    // Windows' console always reports a genuine key-up independently of any
    // of this — it isn't a VT/kitty-protocol thing there, it's how the
    // native console API works. Everywhere else, a release/repeat only ever
    // arrives if the terminal actually honours REPORT_EVENT_TYPES; ask for
    // it only where `supports_keyboard_enhancement` confirms that's true, or
    // Ctrl+/'s hold-latch below would set once on the first press and never
    // see the release that's supposed to clear it.
    #[cfg(windows)]
    let reliable_key_release = true;
    #[cfg(not(windows))]
    let reliable_key_release =
        crossterm::terminal::supports_keyboard_enhancement().unwrap_or(false);
    let mut enhancement_flags = KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES;
    if reliable_key_release {
        enhancement_flags |= KeyboardEnhancementFlags::REPORT_EVENT_TYPES;
    }
    // Kitty keyboard protocol, where the terminal supports it: without it,
    // Cmd+Enter never reaches the app at all. Ctrl+Enter is the fallback
    // everywhere else. Best-effort push, popped on exit.
    let _ = crossterm::execute!(
        std::io::stdout(),
        PushKeyboardEnhancementFlags(enhancement_flags)
    );
    let mut input = spawn_input_thread();

    let mut conv = Conversation::default();
    let mut usage = Usage::default();
    // Edge-triggered latch for Ctrl+/: set on the press that actually opens
    // or closes command mode, cleared only by that same combo's release, so
    // holding the key repeats nothing — a terminal's own key-repeat stream
    // (Windows always, others only with REPORT_EVENT_TYPES) resends Press
    // without a Release in between, and this latch swallows every one of
    // those until the physical key actually comes up. Where the terminal
    // never sends a release at all (`reliable_key_release` false), the latch
    // never engages and every observed Press is treated as its own event,
    // matching this terminal's only available signal.
    let mut ctrl_slash_held = false;
    let mut approvals = Approvals::default();
    let mut editor = new_editor();
    let mut note: Option<String> = None;
    // Attachments pinned to the next say (submit.rs: the format contract).
    let mut attachments: Vec<Chip> = Vec::new();
    let mut geometry = Geometry::default();
    let mut hits: Vec<view::HitRow> = Vec::new();
    // The href under the pointer, surfaced in the status line so a link's
    // destination is visible before the click.
    let mut hover: Option<String> = None;

    let result: anyhow::Result<()> = async {
        loop {
            let chip_labels: Vec<String> = attachments.iter().map(Chip::label).collect();
            terminal.draw(|frame| {
                let screen = view::Screen {
                    conv_id: &conv_id.0,
                    conv: &conv,
                    usage: &usage,
                    approvals: &approvals,
                    editor: &editor,
                    note: note.as_deref(),
                    hover: hover.as_deref(),
                    attachments: &chip_labels,
                };
                let (g, h) = view::draw(frame, &screen, &mut view_state, now_ms());
                geometry = g;
                hits = h;
            })?;

            tokio::select! {
                done = done_rx.recv() => {
                    let Some(done) = done else { break };
                    match done {
                        Done::Say { typed, chips, outcome } => match outcome {
                            Ok(wire::SayOutcome::Accepted { .. }) => {
                                note = None;
                                conv.say_accepted = true;
                            }
                            Ok(wire::SayOutcome::Rejected { reason }) => {
                                note = Some(format!("say rejected: {reason}"));
                                conv.pending_say = None;
                                editor.insert_str(&typed);
                                attachments.extend(chips);
                            }
                            Ok(wire::SayOutcome::Unreachable) => {
                                note = Some("say unreachable".into());
                                conv.pending_say = None;
                                editor.insert_str(&typed);
                                attachments.extend(chips);
                            }
                            Err(e) => {
                                note = Some(format!("say failed: {e}"));
                                conv.pending_say = None;
                                editor.insert_str(&typed);
                                attachments.extend(chips);
                            }
                        },
                        Done::Cancel(outcome) => {
                            note = match outcome {
                                Ok(wire::CancelOutcome::Accepted) => None,
                                Ok(wire::CancelOutcome::Rejected { reason }) => {
                                    Some(format!("cancel rejected: {reason}"))
                                }
                                Ok(wire::CancelOutcome::Unreachable) => {
                                    Some("cancel unreachable".into())
                                }
                                Err(e) => Some(format!("cancel failed: {e}")),
                            };
                        }
                        Done::Answer(outcome) => {
                            note = match outcome {
                                Ok(wire::AnswerOutcome::Accepted) => None,
                                Ok(wire::AnswerOutcome::Rejected { reason }) => {
                                    Some(format!("answer rejected: {reason}"))
                                }
                                Ok(wire::AnswerOutcome::Unreachable) => {
                                    Some("answer unreachable — the holder is gone".into())
                                }
                                Err(e) => Some(format!("answer failed: {e}")),
                            };
                        }
                        Done::Upload(result) => match result {
                            Ok((label, block)) => {
                                attachments.push(Chip::Image { label, block });
                                note = None;
                            }
                            Err(e) => note = Some(format!("attach failed: {e}")),
                        },
                    }
                }
                event = session.next_event() => {
                    let Some(event) = event else {
                        break; // attach fd closed: bridge is gone
                    };
                    match wire::parse_wire(&event.subject, &event.payload) {
                        Some(wire::WireEvent::Conv(decoded)) => {
                            // A revision rewrites a sealed block in place —
                            // the one event the layout cache can't see coming.
                            if matches!(
                                decoded.kind,
                                wire::EventKind::Change(wire::ConvChange::Revision(_))
                            ) {
                                view_state.invalidate_layout();
                            }
                            conv.fold(&decoded.kind);
                            usage.fold(&decoded.kind);
                            // A revoked say comes home: words to the editor.
                            if let Some(text) = conv.restore_say.take() {
                                editor.insert_str(&text);
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
                        //
                        // The press/release split is the held-latch (see
                        // `ctrl_slash_held` above): Repeat is neither, and is
                        // ignored outright rather than falling through.
                        TermEvent::Key(key)
                            if matches!(
                                key.code,
                                KeyCode::Char('/') | KeyCode::Char('_') | KeyCode::Char('7')
                            ) && key.modifiers.contains(KeyModifiers::CONTROL) =>
                        {
                            match key.kind {
                                KeyEventKind::Press => {
                                    if !ctrl_slash_held {
                                        // Ctrl+/ closes the secondary view first if
                                        // it's open — command mode stays closed while
                                        // the log is up (opening it sets command to
                                        // Closed), so toggle() would otherwise open
                                        // Root instead of closing what's actually
                                        // showing.
                                        if view_state.secondary_open {
                                            view_state.secondary_open = false;
                                        } else {
                                            view_state.command.toggle();
                                        }
                                    }
                                    ctrl_slash_held = true;
                                }
                                KeyEventKind::Release => ctrl_slash_held = false,
                                KeyEventKind::Repeat => {}
                            }
                        }
                        // The secondary view claims keys the same way command mode
                        // does while it's open: esc closes it, everything else here
                        // scrolls its own position, never the conversation's. Only
                        // Press — see the command-mode arm above for why.
                        TermEvent::Key(key)
                            if view_state.secondary_open && key.kind == KeyEventKind::Press =>
                        {
                            match key.code {
                            KeyCode::Esc => view_state.secondary_open = false,
                            KeyCode::Up | KeyCode::Char('k') => {
                                view_state.secondary_scroll += 1;
                            }
                            KeyCode::Down | KeyCode::Char('j') => {
                                view_state.secondary_scroll =
                                    view_state.secondary_scroll.saturating_sub(1);
                            }
                            KeyCode::PageUp => view_state.secondary_scroll += 10,
                            KeyCode::PageDown => {
                                view_state.secondary_scroll =
                                    view_state.secondary_scroll.saturating_sub(10);
                            }
                            _ => {}
                            }
                        }
                        // While command mode is open it claims every key:
                        // bound ones fire intents, the rest are swallowed.
                        // Only Press: Release/Repeat only ever reach here on
                        // a terminal that also reports them (Windows always,
                        // others only with REPORT_EVENT_TYPES), and neither
                        // is a fresh keystroke.
                        TermEvent::Key(key)
                            if view_state.command.is_open() && key.kind == KeyEventKind::Press =>
                        {
                            match &mut view_state.command {
                                CommandMode::Root => match key.code {
                                    KeyCode::Esc => view_state.command.escape(),
                                    KeyCode::Char('t') => {
                                        // Clipboard text becomes an ATTACHMENT chip
                                        // (the reference's addText), not an editor
                                        // insert: it rides the say as a verbatim
                                        // text block, which bridge folds into the
                                        // message content untouched.
                                        match clipboard::read_text().await {
                                            Some(text) => {
                                                attachments.push(Chip::Text { text });
                                                note = None;
                                            }
                                            None => note = Some("clipboard: no text".into()),
                                        }
                                        // Command mode stays open: only the user
                                        // exits it (Ctrl+/ or Esc), never an intent.
                                    }
                                    KeyCode::Char('i') => {
                                        // Clipboard image → upload → chip, off-loop:
                                        // pngpaste and the upload both take real time.
                                        let req = requester.clone();
                                        let tx = done_tx.clone();
                                        tokio::spawn(async move {
                                            let result = async {
                                                let (bytes, media_type) =
                                                    clipboard::read_image().await.ok_or_else(|| {
                                                        anyhow::anyhow!(
                                                            "clipboard: no image (pngpaste installed?)"
                                                        )
                                                    })?;
                                                let name =
                                                    format!("clipboard.{}", &media_type[6..]);
                                                req.upload_bytes(&name, "image", media_type, bytes)
                                                    .await
                                            }
                                            .await;
                                            let _ = tx.send(Done::Upload(result));
                                        });
                                    }
                                    KeyCode::Char('f') => {
                                        // Prefill the path editor from the clipboard
                                        // when it holds a path (terminal, VS Code,
                                        // Finder — the reference's three stages).
                                        let mut path_editor = new_editor();
                                        if let Some(path) = clipboard::read_path().await {
                                            path_editor.insert_str(&path);
                                        }
                                        view_state.command = CommandMode::AttachEdit(path_editor);
                                    }
                                    KeyCode::Char('d') => {
                                        attachments.pop();
                                    }
                                    KeyCode::Char('m') => {
                                        view_state.command = CommandMode::ModelEdit(new_editor());
                                    }
                                    KeyCode::Char('c') => {
                                        view_state.command = CommandMode::CwdEdit(new_editor());
                                    }
                                    KeyCode::Char('j') => {
                                        view_state.command = CommandMode::ConfigEdit(new_editor());
                                    }
                                    KeyCode::Char('l') => {
                                        view_state.secondary_open = true;
                                        view_state.command = CommandMode::Closed;
                                    }
                                    KeyCode::Char(answer @ ('y' | 'n')) => {
                                        let target = approvals
                                            .live(now_ms())
                                            .first()
                                            .map(|(id, _)| id.to_string());
                                        if let Some(id) = target {
                                            let req = requester.clone();
                                            let tx = done_tx.clone();
                                            tokio::spawn(async move {
                                                let _ = tx.send(Done::Answer(
                                                    req.answer(&id, answer == 'y').await,
                                                ));
                                            });
                                        }
                                    }
                                    _ => {}
                                },
                                CommandMode::AttachEdit(overlay) => match (key.code, key.modifiers) {
                                    (KeyCode::Esc, _) => view_state.command.escape(),
                                    (KeyCode::Enter, _) => {
                                        // The reference's pasteFile: metadata only,
                                        // never bytes — the agent reads the path
                                        // with its own tools.
                                        let path = drain(overlay).trim().to_string();
                                        if !path.is_empty() {
                                            let expanded = expand_home(&path);
                                            let kind = match tokio::fs::metadata(&expanded).await {
                                                Ok(m) if m.is_dir() => FileKind::Dir,
                                                Ok(m) => FileKind::File { size: m.len() },
                                                Err(_) => FileKind::Missing,
                                            };
                                            attachments.push(Chip::File {
                                                path: expanded,
                                                kind,
                                            });
                                            note = None;
                                        }
                                        // Back to root, still in command mode.
                                        view_state.command.escape();
                                    }
                                    _ => forward_key(overlay, key),
                                },
                                CommandMode::ModelEdit(overlay) => match (key.code, key.modifiers) {
                                    (KeyCode::Esc, _) => view_state.command.escape(),
                                    (KeyCode::Enter, _) => {
                                        let model = drain(overlay).trim().to_string();
                                        if !model.is_empty() {
                                            // A partial object: the line merges, so this
                                            // names the model and leaves maxTokens,
                                            // thinking and effort as configured. `j`
                                            // paste mode is how the rest is set.
                                            let reply = session
                                                .control(&serde_json::json!({
                                                    "model": { "name": model }
                                                }))
                                                .await?;
                                            // A conversation's model is fixed when it is
                                            // served, and helm serves one, at startup. So
                                            // this reaches the host's cell and never the
                                            // conversation on screen, and saying otherwise
                                            // would be a lie.
                                            note = match reply["model"]["name"].as_str() {
                                                Some(m) => Some(format!(
                                                    "host model → {m}; this conversation keeps the one it started on"
                                                )),
                                                None => Some(format!("model change failed: {reply}")),
                                            };
                                        }
                                        view_state.command.escape();
                                    }
                                    _ => forward_key(overlay, key),
                                },
                                CommandMode::CwdEdit(overlay) => match (key.code, key.modifiers) {
                                    (KeyCode::Esc, _) => view_state.command.escape(),
                                    (KeyCode::Enter, _) => {
                                        let path = drain(overlay).trim().to_string();
                                        if !path.is_empty() {
                                            // chdir, not the instance-wide cwd line: this
                                            // moves helm's own live conversation, not just
                                            // the default a future spawn would take.
                                            let reply = session
                                                .control(&serde_json::json!({
                                                    "chdir": {
                                                        "conversationId": conv_id.0,
                                                        "cwd": path,
                                                    }
                                                }))
                                                .await?;
                                            note = match reply["cwd"].as_str() {
                                                Some(cwd) => Some(format!("cwd → {cwd}")),
                                                None => Some(format!(
                                                    "cwd change failed: {}",
                                                    reply["error"].as_str().unwrap_or("?")
                                                )),
                                            };
                                        }
                                        view_state.command.escape();
                                    }
                                    _ => forward_key(overlay, key),
                                },
                                CommandMode::ConfigEdit(overlay) => match (key.code, key.modifiers) {
                                    (KeyCode::Esc, _) => view_state.command.escape(),
                                    // Ctrl/Cmd+Enter submits (the same convention as the
                                    // main say editor) — plain Enter has to stay a newline
                                    // insert, unlike ModelEdit/CwdEdit's single-line editors,
                                    // because a config batch is routinely multi-line.
                                    (KeyCode::Enter, m)
                                        if m.contains(KeyModifiers::SUPER)
                                            || m.contains(KeyModifiers::CONTROL) =>
                                    {
                                        let batch = drain(overlay);
                                        if !batch.trim().is_empty() {
                                            let outcomes =
                                                config::apply_config_batch(&mut session, &batch)
                                                    .await;
                                            for outcome in &outcomes {
                                                view_state.log_config(&format_config_outcome(outcome));
                                            }
                                            note = Some(summarize_config_outcomes(&outcomes));
                                        }
                                        view_state.command.escape();
                                    }
                                    _ => forward_key(overlay, key),
                                },
                                CommandMode::Closed => unreachable!("guarded by is_open"),
                            }
                        }
                        // Only Press — see the command-mode arm above for why.
                        TermEvent::Key(key) if key.kind == KeyEventKind::Press => {
                            match (key.code, key.modifiers) {
                            (KeyCode::Char('c'), KeyModifiers::CONTROL) => break,
                            (KeyCode::Enter, m)
                                if m.contains(KeyModifiers::SUPER)
                                    || m.contains(KeyModifiers::CONTROL) =>
                            {
                                // An empty say resumes a standing premise
                                // (tip is a dangling user message) — same
                                // rule as the reference and both frontends.
                                if !is_blank(&editor)
                                    || !attachments.is_empty()
                                    || conv.tip_is_dangling_user()
                                {
                                    // Optimistic: pending say and cleared chips now,
                                    // reconciled when the outcome folds back.
                                    let typed = drain(&mut editor);
                                    let (text, blocks) = build_submit(&typed, &attachments);
                                    let tip = conv.messages.last().map(|m| m.id.clone());
                                    let chips = std::mem::take(&mut attachments);
                                    conv.pending_say = Some(text.clone());
                                    conv.say_accepted = false;
                                    view_state.scroll_from_bottom = 0; // a say re-pins to the tail
                                    let req = requester.clone();
                                    let tx = done_tx.clone();
                                    let conv_target = conv_id.clone();
                                    tokio::spawn(async move {
                                        let outcome =
                                            req.say(&conv_target, &text, tip, blocks).await;
                                        let _ = tx.send(Done::Say { typed, chips, outcome });
                                    });
                                }
                            }
                            (KeyCode::Enter, _) => editor.insert_newline(),
                            (KeyCode::Esc, _) => {
                                // Scrolled: re-pin. Pinned with a live query: cancel it.
                                if view_state.scroll_from_bottom > 0 {
                                    view_state.scroll_from_bottom = 0;
                                } else if let Some(query) = conv.live_query.clone() {
                                    let req = requester.clone();
                                    let tx = done_tx.clone();
                                    let conv_target = conv_id.clone();
                                    tokio::spawn(async move {
                                        let _ = tx.send(Done::Cancel(
                                            req.cancel(&conv_target, &query).await,
                                        ));
                                    });
                                }
                            }
                            (KeyCode::PageUp, _) => view_state.scroll_from_bottom += geometry.inner.height as usize,
                            (KeyCode::PageDown, _) => {
                                view_state.scroll_from_bottom = view_state
                                    .scroll_from_bottom
                                    .saturating_sub(geometry.inner.height as usize);
                            }
                            _ => forward_key(&mut editor, key),
                            }
                        }
                        TermEvent::Mouse(mouse) => match mouse.kind {
                            MouseEventKind::ScrollUp if view_state.secondary_open => {
                                view_state.secondary_scroll += WHEEL_LINES;
                            }
                            MouseEventKind::ScrollDown if view_state.secondary_open => {
                                view_state.secondary_scroll =
                                    view_state.secondary_scroll.saturating_sub(WHEEL_LINES);
                            }
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
                                    let column = (mouse.column - inner.x) as usize;
                                    if let Some(hit) = hits.get(index) {
                                        // Links open on a modified click only — a bare
                                        // click must never fire a browser. The mouse
                                        // protocol's meta bit is what macOS terminals
                                        // report for the cmd key; crossterm labels that
                                        // bit ALT, so this catches cmd+click (SC-verified
                                        // live in iTerm2+tmux) and option+click alike.
                                        let alt_held = mouse.modifiers.contains(KeyModifiers::ALT);
                                        let link = hit
                                            .links
                                            .iter()
                                            .find(|l| column >= l.start && column < l.end);
                                        match link {
                                            Some(link) if alt_held => {
                                                note = open_link(&link.href)
                                                    .err()
                                                    .map(|e| e.to_string());
                                            }
                                            _ => {
                                                if let Some(key) = &hit.block {
                                                    view_state.toggle(key.clone());
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            MouseEventKind::Moved => {
                                let inner = geometry.inner;
                                let inside = mouse.column >= inner.x
                                    && mouse.column < inner.x + inner.width
                                    && mouse.row >= inner.y
                                    && mouse.row < inner.y + inner.height;
                                hover = inside
                                    .then(|| {
                                        let index = (mouse.row - inner.y) as usize;
                                        let column = (mouse.column - inner.x) as usize;
                                        hits.get(index).and_then(|hit| {
                                            hit.links
                                                .iter()
                                                .find(|l| column >= l.start && column < l.end)
                                                .map(|l| l.href.clone())
                                        })
                                    })
                                    .flatten();
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

/// Open a clicked link in the system browser. Scheme-gated to web URLs so a
/// crafted href can't point `open` at files or app schemes.
fn open_link(href: &str) -> anyhow::Result<()> {
    if !(href.starts_with("https://") || href.starts_with("http://")) {
        anyhow::bail!("not a web link: {href}");
    }
    std::process::Command::new("open")
        .arg(href)
        .status()
        .map_err(|e| anyhow::anyhow!("failed to run 'open' to launch {href}: {e}"))?;
    Ok(())
}

/// One outcome, pretty-printed — shared by both entry points (`-c`'s
/// startup batch and the live `j` editor) so the config log reads the
/// same regardless of which one produced a line.
fn format_config_outcome(outcome: &config::Applied) -> String {
    match outcome {
        config::Applied::Local(msg) => format!("config (local): {msg}"),
        config::Applied::Forwarded(reply) => format!(
            "config (bridge): {}",
            serde_json::to_string_pretty(reply).unwrap_or_else(|_| reply.to_string())
        ),
        config::Applied::Invalid(err) => format!("config error: {err}"),
    }
}

/// The status bar is one fixed-height line (view.rs's `Constraint::Length(1)`)
/// — nowhere near readable for a full `{"settings":{}}` reply. Every outcome
/// already went into `view_state.config_log` (`l` opens it, scrollable, in
/// the TUI); this is just a short pointer, not the content itself.
fn summarize_config_outcomes(outcomes: &[config::Applied]) -> String {
    let failed = outcomes
        .iter()
        .filter(|o| matches!(o, config::Applied::Invalid(_)))
        .count();
    let ok = outcomes.len() - failed;
    if failed == 0 {
        format!("config: {ok} line(s) applied — l to view")
    } else {
        format!("config: {ok} applied, {failed} failed — l to view")
    }
}

/// A fresh editor with the widget defaults helm doesn't want: the default
/// cursor-line underline smears across wide glyphs in tmux, so it goes.
fn new_editor() -> TextArea<'static> {
    let mut editor = TextArea::default();
    editor.set_cursor_line_style(ratatui::style::Style::default());
    editor
}

/// Forward a key to a textarea. The widget's own emacs-flavoured map covers
/// the word ops in every terminal spelling except macOS's bare-option ∂
/// (option+d with "alt sends escape" off), pre-mapped here. VS16 passes
/// through: the vendored unicode-width patch measures it at base width, so
/// the buffer and every renderer agree.
fn forward_key(editor: &mut TextArea<'static>, key: crossterm::event::KeyEvent) {
    match key.code {
        KeyCode::Char('∂') => {
            editor.delete_next_word();
        }
        _ => {
            editor.input(key);
        }
    }
}

/// Take the whole buffer for a submit, resetting the editor.
fn drain(editor: &mut TextArea<'static>) -> String {
    let text = editor.lines().join("\n");
    *editor = new_editor();
    text
}

fn is_blank(editor: &TextArea<'static>) -> bool {
    editor.lines().iter().all(|l| l.trim().is_empty())
}

/// One spawned request's outcome, folded back into the loop's state — the
/// reconcile half of the optimistic submit.
enum Done {
    Say {
        typed: String,
        chips: Vec<Chip>,
        outcome: anyhow::Result<wire::SayOutcome>,
    },
    Cancel(anyhow::Result<wire::CancelOutcome>),
    Answer(anyhow::Result<wire::AnswerOutcome>),
    Upload(anyhow::Result<(String, serde_json::Value)>),
}

/// `~`/`~/...` → $HOME, the reference's own expansion; anything else passes
/// through untouched.
fn expand_home(path: &str) -> String {
    let Ok(home) = std::env::var("HOME") else {
        return path.to_string();
    };
    if path == "~" {
        return home;
    }
    match path.strip_prefix("~/") {
        Some(rest) => format!("{home}/{rest}"),
        None => path.to_string(),
    }
}
