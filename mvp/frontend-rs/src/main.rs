//! WASM entry point: find the canvas, derive the WebSocket URL from the page's
//! own location, and hand off to the egui app. The concern folds and the
//! transport decode live in plain modules, compiled and tested on the host; the
//! render loop (app) is browser-only.

// On native this bin's `main` is a stub — the real entry is wasm, so the
// transport and render are unreachable from native `main` (they exist to build
// and, for the folds, to test). Dead-code stays enforced on the wasm build.
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

mod concerns;
mod time;
mod transport;

// Browser-only: it drives eframe's canvas and reads the JS wall clock.
#[cfg(target_arch = "wasm32")]
mod app;

#[cfg(target_arch = "wasm32")]
fn main() {
    wasm_bindgen_futures::spawn_local(async {
        if let Err(error) = start().await {
            web_sys::console::error_1(&error);
        }
    });
}

#[cfg(target_arch = "wasm32")]
async fn start() -> Result<(), wasm_bindgen::JsValue> {
    use wasm_bindgen::JsCast as _;

    let window = web_sys::window().ok_or("no window")?;
    let document = window.document().ok_or("no document")?;
    let canvas = document
        .get_element_by_id("tower_canvas")
        .ok_or("no #tower_canvas element")?
        .dyn_into::<web_sys::HtmlCanvasElement>()?;

    let location = window.location();
    let scheme = if location.protocol()? == "https:" {
        "wss"
    } else {
        "ws"
    };
    let ws_url = format!("{scheme}://{}/ws", location.host()?);

    let app = app::TowerApp::new(&ws_url).map_err(wasm_bindgen::JsValue::from)?;
    eframe::WebRunner::new()
        .start(
            canvas,
            eframe::WebOptions::default(),
            Box::new(|_cc| Ok(Box::new(app))),
        )
        .await
}

// The app targets wasm32; a native build exists only so the folds and decode
// compile and test on the host.
#[cfg(not(target_arch = "wasm32"))]
fn main() {
    eprintln!("the tower-frontend app targets wasm32; build it with trunk");
}
