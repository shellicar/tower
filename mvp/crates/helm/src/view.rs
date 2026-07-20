//! Layout only (tui-architecture.md layer 3/4): pure functions from the
//! concerns' state to ratatui widgets. Present and platform are ratatui's;
//! nothing here touches the terminal. Rendering is deliberately plain —
//! looking decent beats replicating claude-sdk-cli's visuals, and per-type
//! richness is add-only later.

use ratatui::Frame;
use ratatui::layout::{Constraint, Layout};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph, Wrap};

use crate::approvals::Approvals;
use crate::conversation::{Conversation, QueryState};
use crate::usage::Usage;

/// One content block, one line class: text blocks render whole, everything
/// else renders as a named summary. Unknown types fall back to their name —
/// the open-set tolerance the wire demands of every consumer.
fn block_lines(block: &serde_json::Value) -> Vec<Line<'static>> {
    let block_type = block["type"].as_str().unwrap_or("?");
    match block_type {
        "text" => block["text"]
            .as_str()
            .unwrap_or_default()
            .lines()
            .map(|l| Line::raw(l.to_string()))
            .collect(),
        "thinking" => vec![Line::styled(
            "[thinking]",
            Style::default().fg(Color::DarkGray).add_modifier(Modifier::ITALIC),
        )],
        "tool_use" => vec![Line::styled(
            format!("[tool: {}]", block["name"].as_str().unwrap_or("?")),
            Style::default().fg(Color::Cyan),
        )],
        "tool_result" => vec![Line::styled(
            "[tool result]",
            Style::default().fg(Color::DarkGray),
        )],
        other => vec![Line::styled(
            format!("[{other}]"),
            Style::default().fg(Color::DarkGray),
        )],
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

pub fn draw(
    frame: &mut Frame,
    conv_id: &str,
    conv: &Conversation,
    usage: &Usage,
    approvals: &Approvals,
    now_ms: i64,
) {
    let [main, status] =
        Layout::vertical([Constraint::Min(1), Constraint::Length(1)]).areas(frame.area());

    // Conversation: committed messages, then the in-flight stream, then any
    // live pending asks. Scroll state is a later concern; for now the tail
    // wins (the newest content is what a watcher needs).
    let mut lines: Vec<Line> = Vec::new();
    for message in &conv.messages {
        lines.push(role_line(&message.role));
        for block in &message.content {
            lines.extend(block_lines(block));
        }
        lines.push(Line::raw(""));
    }
    for segment in &conv.streaming {
        if segment.text.is_empty() {
            continue;
        }
        lines.push(Line::styled(
            format!("[{}…]", segment.block_type),
            Style::default().fg(Color::DarkGray),
        ));
        for l in segment.text.lines() {
            lines.push(Line::raw(l.to_string()));
        }
    }
    for (id, ask) in approvals.live(now_ms) {
        lines.push(Line::styled(
            format!(
                "APPROVAL {id}: {} — y approve / n deny",
                ask.ask["name"].as_str().unwrap_or("?")
            ),
            Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD),
        ));
    }

    // Tail-follow: show the last lines that fit.
    let height = main.height.saturating_sub(2) as usize; // borders
    let skip = lines.len().saturating_sub(height);
    let visible: Vec<Line> = lines.into_iter().skip(skip).collect();
    frame.render_widget(
        Paragraph::new(visible)
            .wrap(Wrap { trim: false })
            .block(Block::default().borders(Borders::ALL).title(format!(" {conv_id} "))),
        main,
    );

    // Status: query state, tokens, cost — the usage concern's facts, priced
    // nowhere (cost only when a frame carried one).
    let state = match conv.query_state {
        QueryState::Unknown => Span::styled("unknown", Style::default().fg(Color::DarkGray)),
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
    status_spans.push(Span::raw(" · q quits"));
    frame.render_widget(Paragraph::new(Line::from(status_spans)), status);
}
