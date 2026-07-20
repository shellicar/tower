//! Layout only (tui-architecture.md layer 3/4): pure functions from the
//! concerns' state to lines, plus the hit map that makes the screen
//! clickable. Present and platform are ratatui's; nothing here touches the
//! terminal. Wrapping is done here, not by ratatui, because a hit test needs
//! every visual row to map back to the block that produced it — the claim
//! claude-sdk-cli could never make once sealed content left for native
//! scrollback.

use std::collections::HashSet;

use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph};

use crate::approvals::Approvals;
use crate::conversation::{Conversation, QueryState};
use crate::usage::Usage;

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
}

impl ViewState {
    pub fn toggle(&mut self, key: BlockKey) {
        if !self.expanded.remove(&key) {
            self.expanded.insert(key);
        }
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
struct Row {
    line: Line<'static>,
    hit: Option<BlockKey>,
}

/// Naive char-count wrap. Good enough until measurement needs to be
/// grapheme-accurate; the hit map is what must never be wrong, and chunked
/// rows inherit their source's key so it can't be.
fn wrap_into(rows: &mut Vec<Row>, text: &str, width: usize, style: Option<Style>, hit: Option<BlockKey>) {
    let width = width.max(1);
    for source_line in text.lines() {
        let chars: Vec<char> = source_line.chars().collect();
        if chars.is_empty() {
            rows.push(Row {
                line: Line::raw(""),
                hit: hit.clone(),
            });
            continue;
        }
        for chunk in chars.chunks(width) {
            let s: String = chunk.iter().collect();
            rows.push(Row {
                line: match style {
                    Some(style) => Line::styled(s, style),
                    None => Line::raw(s),
                },
                hit: hit.clone(),
            });
        }
    }
}

fn dim() -> Style {
    Style::default().fg(Color::DarkGray)
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

fn lay(conv: &Conversation, approvals: &Approvals, view: &ViewState, width: usize, now_ms: i64) -> Vec<Row> {
    let mut rows: Vec<Row> = Vec::new();
    for message in &conv.messages {
        rows.push(Row {
            line: role_line(&message.role),
            hit: None,
        });
        for (index, block) in message.content.iter().enumerate() {
            let key: BlockKey = (message.id.0.clone(), index);
            match summary(block) {
                None => {
                    // Whole-rendered text block: never a click target.
                    wrap_into(&mut rows, block["text"].as_str().unwrap_or_default(), width, None, None);
                }
                Some((line, style)) => {
                    let open = view.expanded.contains(&key);
                    let marker = if open { line.replacen('▸', "▾", 1) } else { line };
                    rows.push(Row {
                        line: Line::styled(marker, style),
                        hit: Some(key.clone()),
                    });
                    if open {
                        wrap_into(&mut rows, &expanded_body(block), width, Some(dim()), Some(key));
                    }
                }
            }
        }
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
                Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD),
            ),
            hit: None,
        });
    }
    rows
}

/// Lay out and render one frame. Returns the geometry and hit map the mouse
/// handler translates the next click/wheel against.
pub fn draw(
    frame: &mut Frame,
    conv_id: &str,
    conv: &Conversation,
    usage: &Usage,
    approvals: &Approvals,
    view: &mut ViewState,
    now_ms: i64,
) -> (Geometry, Vec<Option<BlockKey>>) {
    let [main, status] =
        Layout::vertical([Constraint::Min(1), Constraint::Length(1)]).areas(frame.area());
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
    status_spans.push(Span::raw(" · click expands · q quits"));
    frame.render_widget(Paragraph::new(Line::from(status_spans)), status);

    (Geometry { inner }, hits)
}
