//! The dashboard app: drains the WebSocket, folds events via the shared
//! protocol crate, and renders one movable/resizable window per agent.
//!
//! The WebSocket sits behind `ewebsock`'s channel pair, so all the folding
//! logic stays in `protocol::fold`, testable without a socket.

use eframe::egui;
use protocol::Envelope;
use protocol::fold::{Dashboard, Entry};

pub struct TowerApp {
    /// Kept alive so the socket stays open; tower sends nothing.
    _sender: ewebsock::WsSender,
    receiver: ewebsock::WsReceiver,
    dashboard: Dashboard,
    status: String,
}

impl TowerApp {
    pub fn new(ws_url: &str) -> Result<Self, String> {
        let (sender, receiver) = ewebsock::connect(ws_url, ewebsock::Options::default())?;
        Ok(Self {
            _sender: sender,
            receiver,
            dashboard: Dashboard::default(),
            status: format!("connecting to {ws_url}…"),
        })
    }

    fn drain_socket(&mut self) {
        while let Some(event) = self.receiver.try_recv() {
            match event {
                ewebsock::WsEvent::Opened => self.status = "connected".to_owned(),
                ewebsock::WsEvent::Message(ewebsock::WsMessage::Text(text)) => {
                    if let Ok(envelope) = serde_json::from_str::<Envelope>(&text) {
                        self.dashboard.apply(&envelope);
                    }
                }
                ewebsock::WsEvent::Message(_) => {}
                ewebsock::WsEvent::Error(error) => self.status = format!("socket error: {error}"),
                ewebsock::WsEvent::Closed => self.status = "socket closed".to_owned(),
            }
        }
    }
}

impl eframe::App for TowerApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.drain_socket();

        egui::CentralPanel::default().show(ctx, |ui| {
            ui.heading("Tower");
            ui.label(&self.status);
            ui.label(format!(
                "{} agent(s) discovered",
                self.dashboard.agents.len()
            ));
        });

        for (agent_id, view) in &self.dashboard.agents {
            egui::Window::new(agent_id)
                .default_size([360.0, 300.0])
                .show(ctx, |ui| {
                    egui::ScrollArea::vertical()
                        .id_salt("conversation")
                        .max_height(170.0)
                        .stick_to_bottom(true)
                        .show(ui, |ui| {
                            for entry in &view.conversation {
                                match entry {
                                    Entry::User(text) => {
                                        ui.colored_label(
                                            egui::Color32::LIGHT_BLUE,
                                            format!("user ▸ {text}"),
                                        );
                                    }
                                    Entry::Assistant(text) => {
                                        ui.label(format!("agent ▸ {text}"));
                                    }
                                    Entry::Error(text) => {
                                        ui.colored_label(
                                            egui::Color32::LIGHT_RED,
                                            format!("error ▸ {text}"),
                                        );
                                    }
                                }
                            }
                            if let Some(streaming) = &view.streaming {
                                ui.label(format!("agent ▸ {}▍", streaming.text));
                            }
                        });
                    ui.separator();
                    egui::CollapsingHeader::new("event feed").show(ui, |ui| {
                        egui::ScrollArea::vertical()
                            .id_salt("feed")
                            .max_height(120.0)
                            .stick_to_bottom(true)
                            .show(ui, |ui| {
                                for line in &view.feed {
                                    ui.monospace(line);
                                }
                            });
                    });
                });
        }

        // Poll cadence: new WebSocket data must show without user input.
        ctx.request_repaint_after(std::time::Duration::from_millis(100));
    }
}
