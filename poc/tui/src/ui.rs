//! Rendering: conversation state in, ratatui widgets out. Pure functions over
//! `Conversation` so the draw loop in `main` stays wiring.

use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph, Wrap};

use crate::state::{Conversation, Entry};

/// Draw the whole screen: conversation pane above, input line below.
pub fn draw(frame: &mut Frame, conversation: &Conversation, input: &str) {
    let [conversation_area, input_area] =
        Layout::vertical([Constraint::Min(1), Constraint::Length(3)]).areas(frame.area());
    draw_conversation(frame, conversation_area, conversation);
    draw_input(frame, input_area, input, conversation.turn_in_progress());
}

fn draw_conversation(frame: &mut Frame, area: Rect, conversation: &Conversation) {
    let title = match conversation.agent_id() {
        Some(id) => format!(" {id} "),
        None => " waiting for agent ".to_string(),
    };
    let lines = conversation_lines(conversation);
    // Keep the tail visible: scroll so the last lines fit in the pane.
    let inner_height = area.height.saturating_sub(2) as usize;
    let scroll = lines.len().saturating_sub(inner_height) as u16;
    let paragraph = Paragraph::new(lines)
        .wrap(Wrap { trim: false })
        .scroll((scroll, 0))
        .block(Block::default().borders(Borders::ALL).title(title));
    frame.render_widget(paragraph, area);
}

fn draw_input(frame: &mut Frame, area: Rect, input: &str, turn_in_progress: bool) {
    let title = if turn_in_progress {
        " turn in progress — input will be rejected "
    } else {
        " type, enter to send "
    };
    let paragraph =
        Paragraph::new(input).block(Block::default().borders(Borders::ALL).title(title));
    frame.render_widget(paragraph, area);
    frame.set_cursor_position((area.x + 1 + input.len() as u16, area.y + 1));
}

/// The conversation as styled lines. Separated from drawing so it is testable.
pub fn conversation_lines(conversation: &Conversation) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    for entry in conversation.entries() {
        match entry {
            Entry::User(text) => {
                lines.push(Line::from(vec![
                    Span::styled("you: ", Style::default().add_modifier(Modifier::BOLD)),
                    Span::raw(text.clone()),
                ]));
            }
            Entry::Assistant {
                text,
                complete,
                failed,
            } => {
                let marker = match (complete, failed) {
                    (false, _) => Span::styled("agent … ", Style::default().fg(Color::Yellow)),
                    (true, true) => Span::styled("agent ✗ ", Style::default().fg(Color::Red)),
                    (true, false) => Span::styled("agent: ", Style::default().fg(Color::Green)),
                };
                lines.push(Line::from(vec![marker, Span::raw(text.clone())]));
            }
            Entry::Error(message) => {
                lines.push(Line::from(Span::styled(
                    format!("error: {message}"),
                    Style::default().fg(Color::Red).add_modifier(Modifier::BOLD),
                )));
            }
        }
        lines.push(Line::default());
    }
    lines
}
