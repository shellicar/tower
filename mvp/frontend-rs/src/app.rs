//! The composition root: it owns the transport and every concern, and it is the
//! only place that knows they all exist. Each frame it drains the socket and
//! offers every decoded frame to each concern's `apply` (the fan-out), then
//! renders by *reading* the concerns — reads are `&`, so it can read several at
//! once while drawing, and no draw can mutate a concern.
//!
//! Actions (open a conversation, say, cancel) are gathered during the render
//! (which only reads) and applied after: the concern mutates and returns the
//! `ClientMsg`, and the app — sole owner of the transport and the id mint —
//! sends it. So a concern never touches the socket.
//!
//! Wasm-only in practice: the render loop runs in the browser. The concern
//! folds and the transport decode are native-testable without any of this.

use std::sync::mpsc::{Receiver, Sender};

use eframe::egui;
use serde_json::Value;

use crate::concerns::approvals::{Approvals, ask_input, ask_label, conv_of};
use crate::concerns::conversation::{ConversationState, Conversations, QueryState};
use crate::concerns::rail::Rail;
use crate::time::{Liveness, Millis, age};
use crate::transport::{Status, Transport};
use crate::uploads::{self, Upload};

pub struct TowerApp {
    transport: Transport,
    rail: Rail,
    conversations: Conversations,
    approvals: Approvals,
    /// The one conversation the panel shows — the view concern (tabs) will own
    /// this later; for now the panel holds one open at a time.
    open_conv: Option<String>,
    /// Local UI state: the say editor's buffer.
    draft: String,
    /// The upload boundary's return channel: an async upload sends its ref
    /// here, drained each frame and folded into the conversation concern.
    uploads_tx: Sender<Upload>,
    uploads_rx: Receiver<Upload>,
}

impl TowerApp {
    pub fn new(ws_url: &str) -> Result<Self, String> {
        let (uploads_tx, uploads_rx) = std::sync::mpsc::channel();
        Ok(Self {
            transport: Transport::connect(ws_url)?,
            rail: Rail::default(),
            conversations: Conversations::default(),
            approvals: Approvals::default(),
            open_conv: None,
            draft: String::new(),
            uploads_tx,
            uploads_rx,
        })
    }

    /// Switch the panel to a conversation: close the previous (only the active
    /// one stays open), open the new. Each action mints an id and sends.
    fn open_conversation(&mut self, conv: &str) {
        if self.open_conv.as_deref() == Some(conv) {
            return;
        }
        if let Some(prev) = self.open_conv.take() {
            let id = self.transport.next_id();
            if let Some(msg) = self.conversations.close(&prev, id) {
                self.transport.send(&msg);
            }
        }
        let id = self.transport.next_id();
        if let Some(msg) = self.conversations.open(conv, id) {
            self.transport.send(&msg);
        }
        self.open_conv = Some(conv.to_owned());
        self.draft.clear();
    }

    fn send_current(&mut self) {
        let Some(conv) = self.open_conv.clone() else {
            return;
        };
        let text = std::mem::take(&mut self.draft);
        if text.trim().is_empty() {
            self.draft = text; // nothing to send; keep whatever was there
            return;
        }
        let id = self.transport.next_id();
        if let Some(msg) = self.conversations.say(&conv, text, id) {
            self.transport.send(&msg);
        }
    }

    fn cancel_current(&mut self) {
        let Some(conv) = self.open_conv.clone() else {
            return;
        };
        let id = self.transport.next_id();
        if let Some(msg) = self.conversations.cancel(&conv, id) {
            self.transport.send(&msg);
        }
    }

    fn answer_approval(&mut self, approval_id: &str, approved: bool) {
        let id = self.transport.next_id();
        let msg = self.approvals.answer(approval_id, approved, id);
        self.transport.send(&msg);
    }

    fn dismiss_approval(&mut self, approval_id: &str) {
        self.approvals.dismiss(approval_id);
    }
}

impl eframe::App for TowerApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        // Fan-out: one owned Vec, transport borrow ends, then each concern folds
        // its own slice. A concern reaches only itself — the signature says so.
        for msg in self.transport.drain() {
            self.rail.apply(&msg);
            self.conversations.apply(&msg);
            self.approvals.apply(&msg);
        }

        // Completed uploads arrive over the channel — the async boundary reaches
        // the app as a message; fold each into its conversation.
        while let Ok(upload) = self.uploads_rx.try_recv() {
            self.conversations
                .attach(&upload.conv, vec![upload.attachment]);
        }

        // A rejected or revoked say comes home to the editor: pull its words
        // back into the draft if the box is empty, then consume the restore.
        if self.draft.is_empty()
            && let Some(conv) = self.open_conv.clone()
            && let Some(restore) = self
                .conversations
                .get(&conv)
                .and_then(|oc| oc.restore_say.clone())
        {
            self.draft = restore;
            self.conversations.consume_restore(&conv);
        }

        let now = now_millis();

        let mut to_open: Option<String> = None;
        egui::SidePanel::left("rail")
            .default_width(300.0)
            .show(ctx, |ui| {
                ui.heading("Tower");
                ui.label(status_label(self.transport.status()));
                let awaiting = self.approvals.live(now).len();
                if awaiting > 0 {
                    ui.colored_label(
                        egui::Color32::from_rgb(234, 179, 8),
                        format!("\u{26A0} {awaiting} awaiting approval"),
                    );
                }
                ui.separator();

                let pending = self.rail.pending_by_conv(now);
                egui::ScrollArea::vertical().show(ui, |ui| {
                    for row in self.rail.ordered() {
                        let selected = self.open_conv.as_deref() == Some(&row.conv);
                        ui.horizontal(|ui| {
                            ui.colored_label(heat_color(now, row.last_event), "\u{25CF}");
                            if let Some(liveness) = self.rail.verdict(&row.conv, now) {
                                ui.colored_label(liveness_color(liveness), "\u{25C6}");
                            }
                            if pending.contains(&row.conv) {
                                ui.colored_label(egui::Color32::from_rgb(234, 179, 8), "\u{26A0}");
                            }
                            let label = row.title.clone().unwrap_or_else(|| short(&row.conv));
                            if ui.selectable_label(selected, label).clicked() {
                                to_open = Some(row.conv.clone());
                            }
                            ui.with_layout(
                                egui::Layout::right_to_left(egui::Align::Center),
                                |ui| ui.weak(age(now, row.last_event)),
                            );
                        });
                    }

                    let potential = self.rail.attached_only();
                    if !potential.is_empty() {
                        ui.separator();
                        ui.weak("potential");
                        for conv in potential {
                            if ui.selectable_label(false, short(conv)).clicked() {
                                to_open = Some(conv.to_owned());
                            }
                        }
                    }
                });
            });

        // The approvals VIEW — the whole live set across conversations, each
        // read with its conversation label from the RAIL concern (both `&`,
        // Decision 2's shared value via events, no shared store). Added before
        // the central panel so it claims the bottom strip.
        let mut answer: Option<(String, bool)> = None;
        let mut dismiss: Option<String> = None;
        let live = self.approvals.live(now);
        let voided: Vec<_> = self
            .approvals
            .pending()
            .into_iter()
            .filter(|a| self.approvals.is_void(a, now))
            .collect();
        if !live.is_empty() || !voided.is_empty() {
            egui::TopBottomPanel::bottom("approvals").show(ctx, |ui| {
                ui.heading("Approvals");
                for a in &live {
                    let conv = conv_of(a).unwrap_or("");
                    let clabel = self
                        .rail
                        .row(conv)
                        .and_then(|r| r.title.clone())
                        .unwrap_or_else(|| short(conv));
                    ui.group(|ui| {
                        ui.horizontal(|ui| {
                            ui.colored_label(egui::Color32::from_rgb(234, 179, 8), "\u{26A0}");
                            ui.strong(ask_label(a));
                            ui.weak(format!("\u{00B7} {clabel}"));
                            if ui.button("Approve").clicked() {
                                answer = Some((a.id.clone(), true));
                            }
                            if ui.button("Deny").clicked() {
                                answer = Some((a.id.clone(), false));
                            }
                            if let Some(note) = self.approvals.answer_note(&a.id) {
                                ui.weak(note);
                            }
                        });
                        if let Some(input) = ask_input(a) {
                            ui.monospace(truncate(&input, 600));
                        }
                    });
                }
                for a in &voided {
                    ui.horizontal(|ui| {
                        ui.weak(format!("{} \u{00B7} holder gone", ask_label(a)));
                        if ui.button("Dismiss").clicked() {
                            dismiss = Some(a.id.clone());
                        }
                    });
                }
            });
        }

        // The conversation panel: reads the conversation concern and the rail
        // (its header title) at once — both `&`, the annotations-shared read
        // that needs no shared store in Rust.
        let mut send = false;
        let mut cancel = false;
        egui::CentralPanel::default().show(ctx, |ui| {
            let Some(conv) = self.open_conv.clone() else {
                ui.weak("Open a conversation from the rail.");
                return;
            };
            let header = self
                .rail
                .row(&conv)
                .and_then(|r| r.title.clone())
                .unwrap_or_else(|| short(&conv));
            ui.heading(header);

            let Some(oc) = self.conversations.get(&conv) else {
                ui.weak("opening\u{2026}");
                return;
            };
            if !oc.loaded {
                ui.weak("loading\u{2026}");
            }

            egui::ScrollArea::vertical()
                .auto_shrink([false, false])
                .stick_to_bottom(true)
                .max_height(ui.available_height() - 64.0)
                .show(ui, |ui| {
                    for m in &oc.messages {
                        render_message(ui, &m.role, &m.content);
                    }
                    render_streaming(ui, oc);
                    if let Some(pending) = &oc.pending_say {
                        ui.weak(format!("you (sending\u{2026}) \u{203A} {pending}"));
                    }
                });

            // In-context answer surface: this conversation's live asks (also
            // in the global view below — each surface folds its own slice).
            for a in self.approvals.live_for_conv(&conv, now) {
                ui.group(|ui| {
                    ui.horizontal(|ui| {
                        ui.colored_label(egui::Color32::from_rgb(234, 179, 8), "\u{26A0}");
                        ui.strong(ask_label(a));
                        if ui.button("Approve").clicked() {
                            answer = Some((a.id.clone(), true));
                        }
                        if ui.button("Deny").clicked() {
                            answer = Some((a.id.clone(), false));
                        }
                    });
                    if let Some(input) = ask_input(a) {
                        ui.monospace(truncate(&input, 600));
                    }
                });
            }

            ui.separator();
            if let Some(note) = &oc.last_say {
                ui.weak(note);
            }
            let live = oc.query_state == QueryState::Live;
            if !oc.pending_attachments.is_empty() {
                ui.weak(format!("{} attached", oc.pending_attachments.len()));
            }
            ui.horizontal(|ui| {
                let editor = ui.add(
                    egui::TextEdit::singleline(&mut self.draft)
                        .hint_text("say something\u{2026}")
                        .desired_width(ui.available_width() - 200.0),
                );
                let entered = editor.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));
                if ui.button("Send").clicked() || entered {
                    send = true;
                }
                if ui.button("Attach").clicked() {
                    uploads::pick_and_upload(conv.clone(), self.uploads_tx.clone());
                }
                if live && ui.button("Cancel").clicked() {
                    cancel = true;
                }
            });
        });

        if let Some(conv) = to_open {
            self.open_conversation(&conv);
        }
        if send {
            self.send_current();
        }
        if cancel {
            self.cancel_current();
        }
        if let Some((id, approved)) = answer {
            self.answer_approval(&id, approved);
        }
        if let Some(id) = dismiss {
            self.dismiss_approval(&id);
        }

        // New socket data must show without user input.
        ctx.request_repaint_after(std::time::Duration::from_millis(100));
    }
}

/// Render one committed message: role tint, then its text; non-text blocks
/// collapse to a labelled placeholder (the full content vocabulary is later).
fn render_message(ui: &mut egui::Ui, role: &str, content: &[Value]) {
    let (who, tint) = match role {
        "user" => ("you", egui::Color32::from_rgb(125, 211, 252)),
        "assistant" => ("agent", egui::Color32::from_rgb(196, 181, 253)),
        other => (other, egui::Color32::GRAY),
    };
    ui.horizontal_wrapped(|ui| {
        ui.colored_label(tint, format!("{who} \u{203A}"));
        ui.label(message_text(content));
    });
}

fn render_streaming(ui: &mut egui::Ui, oc: &ConversationState) {
    if oc.streaming.is_empty() {
        return;
    }
    for (i, seg) in oc.streaming.iter().enumerate() {
        let last = i + 1 == oc.streaming.len();
        ui.horizontal_wrapped(|ui| {
            ui.colored_label(egui::Color32::from_rgb(196, 181, 253), "agent \u{203A}");
            // The block marker is an open set — labelled, never branched on;
            // `text` stays plain.
            if seg.block_type != "text" {
                ui.weak(format!("[{}]", seg.block_type));
            }
            // A cursor on the segment being streamed into (the last one).
            let body = if last {
                format!("{}\u{2588}", seg.text)
            } else {
                seg.text.clone()
            };
            ui.label(body);
        });
    }
}

/// Join the text blocks; anything else (tool_use, tool_result, image, $ref)
/// shows as a placeholder line — interim until the content vocabulary lands.
fn message_text(content: &[Value]) -> String {
    let mut parts: Vec<String> = Vec::new();
    for block in content {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(t) = block.get("text").and_then(Value::as_str) {
                    parts.push(t.to_owned());
                }
            }
            Some("tool_use") => {
                let name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
                parts.push(format!("[tool_use: {name}]"));
            }
            Some(other) => parts.push(format!("[{other}]")),
            None => parts.push("[block]".to_owned()),
        }
    }
    parts.join("\n")
}

fn status_label(status: Status) -> &'static str {
    match status {
        Status::Connecting => "connecting\u{2026}",
        Status::Connected => "connected",
        Status::Closed => "disconnected",
    }
}

/// The staleness id, shortened for the rail. Titled rows never reach here.
fn short(conv: &str) -> String {
    conv.chars().take(8).collect()
}

/// Cap a long value for a compact display — the raw input is the interim
/// reviewable primitive (approval-spec); the content vocabulary is later.
fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_owned()
    } else {
        let head: String = s.chars().take(max).collect();
        format!("{head}\u{2026}")
    }
}

/// Staleness heat: fresh green, cooling yellow, cold grey — the control's
/// `heat` thresholds (1h, 6h).
fn heat_color(now: Millis, ts: Millis) -> egui::Color32 {
    let d = now - ts;
    if d < 3_600_000 {
        egui::Color32::from_rgb(74, 222, 128)
    } else if d < 21_600_000 {
        egui::Color32::from_rgb(234, 179, 8)
    } else {
        egui::Color32::from_rgb(115, 115, 115)
    }
}

fn liveness_color(liveness: Liveness) -> egui::Color32 {
    match liveness {
        Liveness::Alive => egui::Color32::from_rgb(74, 222, 128),
        Liveness::Stranded => egui::Color32::from_rgb(248, 113, 113),
    }
}

/// Epoch milliseconds — the unit the wire's `ts`/`lastEvent` carry. The browser
/// wall clock; the app is the clock owner (Decision 1) and passes `now` into
/// each concern's read.
fn now_millis() -> Millis {
    #[cfg(target_arch = "wasm32")]
    {
        js_sys::Date::now() as Millis
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        0
    }
}
