//! Layout only (tui-architecture.md layer 3/4): pure functions from the
//! concerns' state to lines, plus the hit map that makes the screen
//! clickable. Present and platform are ratatui's; nothing here touches the
//! terminal. Wrapping is done here, not by ratatui, because a hit test needs
//! every visual row to map back to the block that produced it — the claim
//! claude-sdk-cli could never make once sealed content left for native
//! scrollback.

use std::collections::{HashMap, HashSet};

use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph};

use crate::approvals::Approvals;
use crate::command::CommandMode;
use crate::conversation::{Conversation, QueryState};
use crate::usage::Usage;
use tui_textarea::TextArea;

/// A block's stable identity for disclosure: the message that carries it and
/// its index within that message's content.
pub type BlockKey = (String, usize);

/// What the user is looking at and doing (tui-architecture.md layer 2):
/// scroll and per-block disclosure. 0 scroll = pinned to the tail, following
/// new content; clicking a summary toggles its key here.
#[derive(Debug, Default)]
pub struct ViewState {
    pub scroll_from_bottom: usize,
    pub expanded: HashSet<BlockKey>,
    /// Command mode — Ctrl+/ the one door in (command.rs).
    pub command: CommandMode,
    /// Wrapped rows per sealed block, keyed by (message, block, expanded).
    /// Sound by construction: sealed messages are immutable, a revision
    /// invalidates explicitly, and a width change clears the lot. Purely a
    /// CPU saving — ratatui's diff already keeps the terminal writes minimal.
    layout_cache: HashMap<(String, usize, bool), Vec<Row>>,
    cache_width: usize,
}

impl ViewState {
    pub fn toggle(&mut self, key: BlockKey) {
        if !self.expanded.remove(&key) {
            self.expanded.insert(key);
        }
    }

    /// A revision replaced a message's content under its stable id — the
    /// one way a sealed block changes, so the one external invalidation.
    pub fn invalidate_layout(&mut self) {
        self.layout_cache.clear();
    }
}

/// Where the last frame put the conversation panel, so a mouse event can be
/// translated back. The hit map is already windowed to the visible rows, so
/// the rect is all a click needs.
#[derive(Debug, Clone, Copy, Default)]
pub struct Geometry {
    pub inner: Rect,
}

/// One laid visual row: the line to draw and the block it belongs to, if
/// that block is disclosable. Wrapped continuations carry the same key.
#[derive(Clone, Debug, PartialEq)]
struct Row {
    line: Line<'static>,
    hit: Option<BlockKey>,
}

/// Split one logical line into display rows of at most `width` columns,
/// measuring grapheme clusters at their East Asian / emoji widths — the
/// same measurement the renderer applies, so a wrapped row never overflows
/// its cells. Pure, so the measurement is testable on its own.
fn wrap_segments(line: &str, width: usize) -> Vec<String> {
    use unicode_segmentation::UnicodeSegmentation;
    use unicode_width::UnicodeWidthStr;
    let width = width.max(1);
    let mut segments = Vec::new();
    let mut current = String::new();
    let mut current_width = 0usize;
    for grapheme in line.graphemes(true) {
        // str-width — the same call ratatui places cells by, so helm's wrap
        // and the renderer always agree. The vendored unicode-width patch
        // makes VS16 clusters measure at base width, matching tmux
        // (variation-selector-always-wide off) and wcwidth.
        let grapheme_width = grapheme.width();
        if current_width + grapheme_width > width && !current.is_empty() {
            segments.push(std::mem::take(&mut current));
            current_width = 0;
        }
        current.push_str(grapheme);
        current_width += grapheme_width;
    }
    if !current.is_empty() || segments.is_empty() {
        segments.push(current);
    }
    segments
}

/// Strip VS16 (U+FE0F, emoji presentation) so ambiguous-width characters
/// render text-presentation — width 1 by every table. VS16 width is where
/// tmux's internal grid, the outer terminal, and wcwidth disagree most
/// (ℹ️ was the archetype), and tmux repaints panes from its own grid, so
/// the only defence is never emitting a contested sequence. True wide emoji
/// carry no VS16 and pass untouched.
///
/// Default: VS16 passes through — the vendored unicode-width patch measures
/// it at base width, agreeing with tmux (variation-selector-always-wide
/// off), wcwidth, and Node, so full-colour emoji render without corruption.
/// `HELM_EMOJI=strip` re-enables the strip for stacks where even base-width
/// VS16 misbehaves.
fn strip_enabled() -> bool {
    static STRIP: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *STRIP.get_or_init(|| std::env::var("HELM_EMOJI").is_ok_and(|v| v == "strip"))
}

fn strip_vs16(text: &str) -> String {
    text.replace('\u{FE0F}', "")
}

/// The terminal-colour accent for a stripped emoji base: colour the glyph
/// the emoji would have been, without the width-contested artwork. The
/// glyph itself never changes, so this cannot corrupt — it only stops the
/// stripped forms reading as grey ghosts.
fn accent_for(grapheme: &str) -> Option<Color> {
    match grapheme.chars().next()? {
        '\u{2139}' => Some(Color::Blue),               // ℹ information
        '\u{26A0}' => Some(Color::Yellow),             // ⚠ warning
        '\u{2764}' | '\u{2665}' => Some(Color::Red),   // ❤ ♥ hearts
        '\u{2733}' | '\u{2714}' => Some(Color::Green), // ✳ ✔ marks
        '\u{25B6}' | '\u{25C0}' => Some(Color::Cyan),  // ▶ ◀ arrows
        '\u{2716}' | '\u{274C}' => Some(Color::Red),   // ✖ crosses
        _ => None,
    }
}

/// One wrapped segment as a line, accent glyphs coloured, everything else
/// in the row's base style.
fn styled_segment(segment: String, base: Option<Style>) -> Line<'static> {
    use unicode_segmentation::UnicodeSegmentation;
    let base = base.unwrap_or_default();
    if !segment.graphemes(true).any(|g| accent_for(g).is_some()) {
        return Line::styled(segment, base);
    }
    let mut spans: Vec<Span> = Vec::new();
    let mut run = String::new();
    for grapheme in segment.graphemes(true) {
        match accent_for(grapheme) {
            Some(color) => {
                if !run.is_empty() {
                    spans.push(Span::styled(std::mem::take(&mut run), base));
                }
                spans.push(Span::styled(grapheme.to_string(), base.fg(color)));
            }
            None => run.push_str(grapheme),
        }
    }
    if !run.is_empty() {
        spans.push(Span::styled(run, base));
    }
    Line::from(spans)
}

/// Wrap a block of text into rows; chunked rows inherit their source's hit
/// key, so the click map stays exact through the wrap.
fn wrap_into(
    rows: &mut Vec<Row>,
    text: &str,
    width: usize,
    style: Option<Style>,
    hit: Option<BlockKey>,
) {
    let text = if strip_enabled() {
        strip_vs16(text)
    } else {
        text.to_string()
    };
    for source_line in text.lines() {
        for segment in wrap_segments(source_line, width) {
            rows.push(Row {
                line: styled_segment(segment, style),
                hit: hit.clone(),
            });
        }
    }
}

fn dim() -> Style {
    Style::default().fg(Color::DarkGray)
}

/// A text block rendered as markdown: the module returns pre-wrapped styled
/// lines, so they slot straight into rows. Text blocks are never click
/// targets, so every row carries no hit key.
fn lay_markdown(rows: &mut Vec<Row>, text: &str, width: usize) {
    let text = if strip_enabled() {
        strip_vs16(text)
    } else {
        text.to_string()
    };
    for line in crate::markdown::lay(&text, width) {
        rows.push(Row { line, hit: None });
    }
}

/// A collapsed block's one-line summary, or None for a type that renders
/// whole (text). The summary is the click target.
fn summary(block: &serde_json::Value) -> Option<(String, Style)> {
    match block["type"].as_str().unwrap_or("?") {
        "text" => None,
        "thinking" => Some(("▸ [thinking]".into(), dim().add_modifier(Modifier::ITALIC))),
        "tool_use" => Some((
            format!("▸ [tool: {}]", block["name"].as_str().unwrap_or("?")),
            Style::default().fg(Color::Cyan),
        )),
        "tool_result" => Some(("▸ [tool result]".into(), dim())),
        other => Some((format!("▸ [{other}]"), dim())),
    }
}

/// The expanded body for a disclosable block: the text a click revealed.
fn expanded_body(block: &serde_json::Value) -> String {
    match block["type"].as_str().unwrap_or("?") {
        "thinking" => block["thinking"].as_str().unwrap_or_default().to_string(),
        "tool_use" => serde_json::to_string_pretty(&block["input"]).unwrap_or_default(),
        "tool_result" => match &block["content"] {
            serde_json::Value::String(s) => s.clone(),
            other => serde_json::to_string_pretty(other).unwrap_or_default(),
        },
        _ => serde_json::to_string_pretty(block).unwrap_or_default(),
    }
}

fn role_line(role: &str) -> Line<'static> {
    let (label, color) = match role {
        "user" => ("you", Color::Green),
        "assistant" => ("claude", Color::Blue),
        other => (other, Color::Magenta),
    };
    Line::styled(
        format!("── {label} ──"),
        Style::default().fg(color).add_modifier(Modifier::BOLD),
    )
}

fn lay(
    conv: &Conversation,
    approvals: &Approvals,
    view: &mut ViewState,
    width: usize,
    now_ms: i64,
) -> Vec<Row> {
    if view.cache_width != width {
        view.layout_cache.clear();
        view.cache_width = width;
    }
    let mut rows: Vec<Row> = Vec::new();
    for message in &conv.messages {
        rows.push(Row {
            line: role_line(&message.role),
            hit: None,
        });
        for (index, block) in message.content.iter().enumerate() {
            let key: BlockKey = (message.id.0.clone(), index);
            let open = view.expanded.contains(&key);
            let cache_key = (key.0.clone(), index, open);
            if let Some(cached) = view.layout_cache.get(&cache_key) {
                rows.extend(cached.iter().cloned());
                continue;
            }
            let mut block_rows: Vec<Row> = Vec::new();
            match summary(block) {
                None => {
                    // Whole-rendered text block: never a click target.
                    lay_markdown(
                        &mut block_rows,
                        block["text"].as_str().unwrap_or_default(),
                        width,
                    );
                }
                Some((line, style)) => {
                    let marker = if open {
                        line.replacen('▸', "▾", 1)
                    } else {
                        line
                    };
                    block_rows.push(Row {
                        line: Line::styled(marker, style),
                        hit: Some(key.clone()),
                    });
                    if open {
                        wrap_into(
                            &mut block_rows,
                            &expanded_body(block),
                            width,
                            Some(dim()),
                            Some(key),
                        );
                    }
                }
            }
            view.layout_cache.insert(cache_key, block_rows.clone());
            rows.extend(block_rows);
        }
        rows.push(Row {
            line: Line::raw(""),
            hit: None,
        });
    }
    // The say in flight: accepted, not yet committed — greyed until its
    // committed message supersedes it (or a revoke sends it home).
    if let Some(pending) = &conv.pending_say {
        rows.push(Row {
            line: role_line("user"),
            hit: None,
        });
        wrap_into(&mut rows, pending, width, Some(dim()), None);
        rows.push(Row {
            line: Line::raw(""),
            hit: None,
        });
    }
    for segment in &conv.streaming {
        if segment.text.is_empty() {
            continue;
        }
        rows.push(Row {
            line: Line::styled(format!("[{}…]", segment.block_type), dim()),
            hit: None,
        });
        wrap_into(&mut rows, &segment.text, width, None, None);
    }
    for (id, ask) in approvals.live(now_ms) {
        rows.push(Row {
            line: Line::styled(
                format!(
                    "APPROVAL {id}: {} — y approve / n deny",
                    ask.ask["name"].as_str().unwrap_or("?")
                ),
                Style::default()
                    .fg(Color::Yellow)
                    .add_modifier(Modifier::BOLD),
            ),
            hit: None,
        });
    }
    rows
}

/// Everything one frame reads: the concerns' state, borrowed together so the
/// draw call stays one argument per axis (what to show / where / when).
pub struct Screen<'a> {
    pub conv_id: &'a str,
    pub conv: &'a Conversation,
    pub usage: &'a Usage,
    pub approvals: &'a Approvals,
    pub editor: &'a TextArea<'static>,
    pub note: Option<&'a str>,
    /// Chip labels for the attachments pinned to the next say.
    pub attachments: &'a [String],
}

/// Lay out and render one frame. Returns the geometry and hit map the mouse
/// handler translates the next click/wheel against.
pub fn draw(
    frame: &mut Frame,
    screen: &Screen<'_>,
    view: &mut ViewState,
    now_ms: i64,
) -> (Geometry, Vec<Option<BlockKey>>) {
    let Screen {
        conv_id,
        conv,
        usage,
        approvals,
        editor,
        note,
        attachments,
    } = *screen;
    // Command mode's active editor owns the input box while open; otherwise
    // the say editor does. The box grows with its content, up to 5 lines —
    // the widget scrolls its own viewport to follow the cursor beyond that.
    // (Height first as a short borrow: `lay` below needs `view` mutably.)
    let input_lines = match &view.command {
        CommandMode::AttachEdit(overlay)
        | CommandMode::ModelEdit(overlay)
        | CommandMode::CwdEdit(overlay) => overlay.lines().len(),
        _ => editor.lines().len(),
    };
    let input_height = (input_lines.min(5) + 2) as u16;
    let chips_height = u16::from(!attachments.is_empty());
    let [main, chips, input, status] = Layout::vertical([
        Constraint::Min(1),
        Constraint::Length(chips_height),
        Constraint::Length(input_height),
        Constraint::Length(1),
    ])
    .areas(frame.area());
    let block = Block::default()
        .borders(Borders::ALL)
        .title(format!(" {conv_id} "));
    let inner = block.inner(main);

    let rows = lay(conv, approvals, view, inner.width as usize, now_ms);
    let height = inner.height as usize;
    // Clamp the scroll to the content, then window from the bottom.
    let max_scroll = rows.len().saturating_sub(height);
    view.scroll_from_bottom = view.scroll_from_bottom.min(max_scroll);
    let skip = max_scroll - view.scroll_from_bottom;

    let mut lines = Vec::with_capacity(height.min(rows.len()));
    let mut hits = Vec::with_capacity(height.min(rows.len()));
    for row in rows.into_iter().skip(skip).take(height) {
        lines.push(row.line);
        hits.push(row.hit);
    }
    frame.render_widget(Paragraph::new(lines).block(block), main);

    let (input_title, active_editor) = match &view.command {
        CommandMode::AttachEdit(attach) => {
            (" attach file path (enter adds · esc backs out) ", attach)
        }
        CommandMode::ModelEdit(model) => (" model (enter sets · esc backs out) ", model),
        CommandMode::CwdEdit(cwd) => (" cwd (enter changes · esc backs out) ", cwd),
        _ => ("", editor),
    };

    if !attachments.is_empty() {
        frame.render_widget(
            Paragraph::new(Line::styled(
                format!(" 📎 {}", attachments.join(" · ")),
                Style::default().fg(Color::Cyan),
            )),
            chips,
        );
    }

    // Input: the widget draws its own content, cursor, and viewport scroll.
    let input_block = Block::default().borders(Borders::ALL).title(input_title);
    let input_inner = input_block.inner(input);
    frame.render_widget(input_block, input);
    frame.render_widget(active_editor, input_inner);

    let state = match conv.query_state {
        QueryState::Unknown => Span::styled("unknown", dim()),
        QueryState::Idle => Span::styled("idle", Style::default().fg(Color::Green)),
        QueryState::Live => Span::styled("live", Style::default().fg(Color::Yellow)),
    };
    let mut status_spans = vec![
        Span::raw(" "),
        state,
        Span::raw(format!(
            " · {} in / {} out",
            usage.input_tokens + usage.cache_creation_tokens + usage.cache_read_tokens,
            usage.output_tokens
        )),
    ];
    if let Some(cost) = usage.cost_usd {
        status_spans.push(Span::raw(format!(" · ${cost:.4}")));
    }
    if view.scroll_from_bottom > 0 {
        status_spans.push(Span::styled(
            format!(" · ↑{}", view.scroll_from_bottom),
            Style::default().fg(Color::Yellow),
        ));
    }
    if let Some(note) = note {
        status_spans.push(Span::styled(
            format!(" · {note}"),
            Style::default().fg(Color::Red),
        ));
    }
    status_spans.push(match view.command {
        CommandMode::Root => Span::styled(
            " · command: t text · i image · f file · d drop · y/n approval · m model · c cwd · esc/^/ exit",
            Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD),
        ),
        CommandMode::AttachEdit(_) | CommandMode::ModelEdit(_) | CommandMode::CwdEdit(_) => {
            Span::styled(
                " · ↵ submits · esc backs out · ^/ closes",
                Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD),
            )
        }
        CommandMode::Closed => {
            Span::raw(" · ^/ commands · ⌘↵/^↵ says · ↵ breaks · esc cancels · ^c quits")
        }
    });
    frame.render_widget(Paragraph::new(Line::from(status_spans)), status);

    (Geometry { inner }, hits)
}

#[cfg(test)]
mod tests {
    use super::wrap_segments;

    #[test]
    fn ascii_wraps_at_the_column_width() {
        let expected = vec!["abcde", "fgh"];

        let actual = wrap_segments("abcdefgh", 5);

        assert_eq!(actual, expected);
    }

    #[test]
    fn wide_cjk_counts_two_columns_per_glyph() {
        // Four ideographs are eight columns: a width of 4 fits two per row.
        let expected = vec!["日本", "語漢"];

        let actual = wrap_segments("日本語漢", 4);

        assert_eq!(actual, expected);
    }

    #[test]
    fn a_multi_codepoint_emoji_stays_one_cluster() {
        // The family emoji is many codepoints, one grapheme — a wrap must
        // never split inside it.
        let family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";
        let text = format!("ab{family}cd");

        let actual = wrap_segments(&text, 4);

        assert!(actual.iter().any(|segment| segment.contains(family)));
    }

    #[test]
    fn vs16_is_stripped_so_ambiguous_emoji_render_text_presentation() {
        // ℹ️ = U+2139 + VS16: the width-contested sequence that corrupted
        // tmux. Stripped, it is plain U+2139, width 1 by every table.
        let expected = "\u{2139}";

        let actual = super::strip_vs16("\u{2139}\u{FE0F}");

        assert_eq!(actual, expected);
    }

    #[test]
    fn true_wide_emoji_pass_the_strip_untouched() {
        let expected = "🎉👍";

        let actual = super::strip_vs16("🎉👍");

        assert_eq!(actual, expected);
    }

    #[test]
    fn stripped_emoji_bases_get_their_colour_as_an_accent() {
        let line = super::styled_segment("a \u{2764} b".into(), None);

        let heart_span = line
            .spans
            .iter()
            .find(|s| s.content.contains('\u{2764}'))
            .expect("the heart has its own span");
        assert_eq!(heart_span.style.fg, Some(super::Color::Red));
    }

    #[test]
    fn accent_spans_preserve_the_text_exactly() {
        let text = "x \u{2139}\u{26A0}\u{2764} y";

        let line = super::styled_segment(text.into(), None);
        let rejoined: String = line.spans.iter().map(|s| s.content.as_ref()).collect();

        assert_eq!(rejoined, text);
    }

    #[test]
    fn an_empty_line_is_one_blank_row() {
        let expected = vec![""];

        let actual = wrap_segments("", 10);

        assert_eq!(actual, expected);
    }
}
