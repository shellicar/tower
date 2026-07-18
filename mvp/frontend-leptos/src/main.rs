//! WASM entry point: derive the WebSocket URL from the page's own location
//! and mount the Leptos app. The concern folds and transport decode live in
//! plain modules, compiled and tested on the host; the render is browser-only.

#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

mod concerns;
mod time;
mod transport;

#[cfg(target_arch = "wasm32")]
mod app;

#[cfg(target_arch = "wasm32")]
fn main() {
    console_error_panic_hook::set_once();

    let window = web_sys::window().expect("no window");
    let location = window.location();
    let scheme = if location.protocol().expect("protocol") == "https:" {
        "wss"
    } else {
        "ws"
    };
    let ws_url = format!("{scheme}://{}/ws", location.host().expect("host"));

    leptos::mount::mount_to_body(move || leptos::view! { <app::App ws_url=ws_url.clone() /> });
}

// The app targets wasm32; a native build exists only so the folds and decode
// compile and test on the host.
#[cfg(not(target_arch = "wasm32"))]
fn main() {
    eprintln!("the tower-frontend-leptos app targets wasm32; build it with trunk");
}
