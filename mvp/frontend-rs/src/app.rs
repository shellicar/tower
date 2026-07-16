//! The composition root: it owns the transport and every concern, and it is the
//! only place that knows they all exist. Each frame it drains the socket and
//! offers every decoded frame to each concern's `apply` (the fan-out), then
//! renders by *reading* the concerns — reads are `&`, so it can read several at
//! once while drawing, and no draw can mutate a concern.
//!
//! Wasm-only in practice: the render loop runs in the browser. The concern
//! folds and the transport decode are native-testable without any of this.

use eframe::egui;

use crate::concerns::rail::Rail;
use crate::time::{Liveness, Millis, age};
use crate::transport::{Status, Transport};

pub struct TowerApp {
    transport: Transport,
    rail: Rail,
}

impl TowerApp {
    pub fn new(ws_url: &str) -> Result<Self, String> {
        Ok(Self {
            transport: Transport::connect(ws_url)?,
            rail: Rail::default(),
        })
    }
}

impl eframe::App for TowerApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        // Fan-out: one owned Vec, transport borrow ends, then each concern folds
        // its own slice. A concern reaches only itself — the signature says so.
        for msg in self.transport.drain() {
            self.rail.apply(&msg);
        }

        let now = now_millis();

        egui::SidePanel::left("rail")
            .default_width(300.0)
            .show(ctx, |ui| {
                ui.heading("Tower");
                ui.label(status_label(self.transport.status()));
                ui.separator();

                // Reading several facets of ONE concern here; all `&`, so the
                // render can hold them together without any of them being able
                // to mutate the rail.
                let pending = self.rail.pending_by_conv(now);

                egui::ScrollArea::vertical().show(ui, |ui| {
                    for row in self.rail.ordered() {
                        ui.horizontal(|ui| {
                            ui.colored_label(heat_color(now, row.last_event), "●");
                            if let Some(liveness) = self.rail.verdict(&row.conv, now) {
                                ui.colored_label(liveness_color(liveness), "◆");
                            }
                            if pending.contains(&row.conv) {
                                ui.colored_label(egui::Color32::from_rgb(234, 179, 8), "⚠");
                            }
                            ui.label(row.title.clone().unwrap_or_else(|| short(&row.conv)));
                            ui.with_layout(
                                egui::Layout::right_to_left(egui::Align::Center),
                                |ui| ui.weak(age(now, row.last_event)),
                            );
                        });
                    }

                    // Potential conversations: attached, no row yet — served,
                    // silent. Transient; they vanish with the attachment.
                    let potential = self.rail.attached_only();
                    if !potential.is_empty() {
                        ui.separator();
                        ui.weak("potential");
                        for conv in potential {
                            ui.weak(short(conv));
                        }
                    }
                });
            });

        egui::CentralPanel::default().show(ctx, |ui| {
            ui.weak("Open a conversation from the rail.");
        });

        // New socket data must show without user input.
        ctx.request_repaint_after(std::time::Duration::from_millis(100));
    }
}

fn status_label(status: Status) -> &'static str {
    match status {
        Status::Connecting => "connecting…",
        Status::Connected => "connected",
        Status::Closed => "disconnected",
    }
}

/// The staleness id, shortened for the rail. Titled rows never reach here.
fn short(conv: &str) -> String {
    conv.chars().take(8).collect()
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
