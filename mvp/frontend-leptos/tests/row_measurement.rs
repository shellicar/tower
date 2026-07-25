//! The row-height cache in ui/conversation.rs is fed from two places: the
//! mount-time seed reads `getBoundingClientRect().height` (border box), the
//! per-row ResizeObserver update reads `entry.borderBoxSize[0].blockSize`,
//! falling back to `entry.contentRect.height` only if unsupported. This test
//! performs those exact two reads on a row styled like `.message` (style.css:
//! `padding: 6px 0 6px 8px; border-left: 2px`) and asserts they agree — the
//! invariant the cache depends on. The Svelte original keeps it the same way
//! (VirtualList.svelte:150, preferring `borderBoxSize`); preferring
//! `contentRect` instead disagrees with the seed by the row's vertical
//! padding, flapping the cached height on every mount.

#![cfg(target_arch = "wasm32")]

use wasm_bindgen::JsCast;
use wasm_bindgen::JsValue;
use wasm_bindgen::closure::Closure;
use wasm_bindgen_futures::JsFuture;
use wasm_bindgen_test::*;

wasm_bindgen_test_configure!(run_in_browser);

#[wasm_bindgen_test]
async fn the_observer_update_matches_the_mount_seed_for_a_padded_row() {
    let document = web_sys::window().unwrap().document().unwrap();
    let row = document.create_element("div").unwrap();
    row.set_attribute(
        "style",
        "padding: 6px 0 6px 8px; border-left: 2px solid #404040;",
    )
    .unwrap();
    row.set_text_content(Some("a message row"));
    document.body().unwrap().append_child(&row).unwrap();

    // conversation.rs mount seed: get_bounding_client_rect().height()
    let seed = row.get_bounding_client_rect().height();

    let observed_row = row.clone();
    let promise = js_sys::Promise::new(&mut move |resolve, _reject| {
        let closure = Closure::<dyn FnMut(js_sys::Array)>::new(move |entries: js_sys::Array| {
            let entry = entries
                .get(0)
                .dyn_into::<web_sys::ResizeObserverEntry>()
                .unwrap();
            // conversation.rs observer update: border box, matching the
            // mount seed below, falling back to contentRect (content box)
            // only if borderBoxSize is unsupported.
            let h = entry
                .border_box_size()
                .get(0)
                .dyn_into::<web_sys::ResizeObserverSize>()
                .map(|s| s.block_size())
                .unwrap_or_else(|_| entry.content_rect().height());
            resolve
                .call1(&JsValue::UNDEFINED, &JsValue::from_f64(h))
                .unwrap();
        });
        let ro = web_sys::ResizeObserver::new(closure.as_ref().unchecked_ref()).unwrap();
        ro.observe(&observed_row);
        closure.forget();
        std::mem::forget(ro);
    });
    let observed = JsFuture::from(promise).await.unwrap().as_f64().unwrap();

    assert_eq!(
        observed, seed,
        "the observer must report the same height the seed cached, or the \
         cache flaps by the row's vertical padding on every mount"
    );
}
