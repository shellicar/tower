//! WASM entry point: find the canvas, work out the WebSocket URL from the
//! page's own location, and hand off to the egui app.

// The app only ever runs in the browser; gating it keeps the native
// build (tests, clippy) from seeing it as dead code.
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

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    eprintln!("the tower-wasm frontend targets wasm32; build it with trunk");
}
