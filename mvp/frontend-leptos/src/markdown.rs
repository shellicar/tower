//! Assistant-text markdown — mirrors mvp/frontend-svelte's `core/markdown.ts`
//! (marked + DOMPurify): pulldown-cmark for GFM+breaks, ammonia to sanitize
//! the resulting HTML before it reaches `inner_html`. Only assistant-role
//! text blocks call this (see `ui/block.rs::render_block`); user and tool
//! text stay raw, same split as `BlockView.svelte`'s `markdown` prop. A plain
//! module, not under `ui/`: pure logic, no DOM — compiled and tested on the
//! host like `pricing.rs`/`time.rs`, same split main.rs's own doc comment
//! draws between the concern/decode layer and the browser-only render layer.

use pulldown_cmark::{Event, Options, Parser, html};

/// Renders untrusted markdown to sanitized HTML, safe for `inner_html`.
/// Links are forced to `target="_blank" rel="noopener noreferrer"` (mirrors
/// `markdown.ts`'s custom `Renderer.link`), then the whole document is run
/// through ammonia, which strips `<script>`, disallowed attributes (e.g.
/// `onerror`), and disallowed URL schemes (e.g. `javascript:`) — the same
/// acceptance bar DOMPurify enforces on the Svelte side.
pub fn render_markdown(text: &str) -> String {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);

    // marked's `breaks: true` turns a single newline into a line break;
    // pulldown-cmark's CommonMark default treats a soft break as plain
    // whitespace, so promote every SoftBreak to a HardBreak to match.
    let parser = Parser::new_ext(text, options).map(|event| match event {
        Event::SoftBreak => Event::HardBreak,
        other => other,
    });

    let mut unsafe_html = String::new();
    html::push_html(&mut unsafe_html, parser);

    // pulldown-cmark emits plain `<a href="...">`; force target=_blank the
    // way marked's custom renderer does. `rel` isn't injected here — ammonia
    // manages that attribute itself (below) and rejects it being also listed
    // as a plain allowed attribute.
    let unsafe_html = unsafe_html.replace("<a href=\"", "<a target=\"_blank\" href=\"");

    ammonia::Builder::default()
        .add_tag_attributes("a", &["target"])
        // ammonia's own default already stamps every link with this rel
        // value; naming it explicitly keeps the guarantee legible instead
        // of resting on the library default silently matching what marked's
        // renderer forces on the Svelte side.
        .link_rel(Some("noopener noreferrer"))
        .clean(&unsafe_html)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::render_markdown;

    // Ported verbatim (behaviourally) from mvp/frontend-svelte/src/lib/core/markdown.test.ts's
    // hostile-payload cases — the acceptance check for this port.
    #[test]
    fn strips_a_script_tag_entirely() {
        let html = render_markdown("before<script>alert(1)</script>after");
        assert!(!html.contains("<script"));
        assert!(!html.contains("alert(1)"));
    }

    #[test]
    fn strips_an_onerror_handler_from_an_image_tag() {
        let html = render_markdown("<img src=x onerror=\"alert(1)\">");
        assert!(!html.contains("onerror"));
    }

    #[test]
    fn strips_a_javascript_link_href() {
        let html = render_markdown("[click me](javascript:alert(1))");
        assert!(!html.contains("javascript:"));
    }

    #[test]
    fn renders_inline_emphasis_strike_and_code_spans() {
        let html = render_markdown("**bold** *italic* ~~gone~~ `code`");
        assert!(html.contains("<strong>bold</strong>"));
        assert!(html.contains("<em>italic</em>"));
        assert!(html.contains("<del>gone</del>"));
        assert!(html.contains("<code>code</code>"));
    }

    #[test]
    fn opens_links_in_a_new_tab_without_leaking_window_opener() {
        let html = render_markdown("[click me](https://example.com)");
        assert!(html.contains("target=\"_blank\""));
        assert!(html.contains("rel=\"noopener noreferrer\""));
    }
}
