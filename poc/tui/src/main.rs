//! Wiring only: parse args, connect, run the loop. Logic lives in the library.

use std::io::IsTerminal;

use anyhow::{Context, Result, bail};
use crossterm::event::{Event as TermEvent, EventStream, KeyCode, KeyEventKind, KeyModifiers};
use futures::StreamExt;
use tokio::sync::mpsc;

use tui::bridge::Bridge;
use tui::protocol::Event;
use tui::state::{Conversation, Entry};
use tui::ui;

struct Args {
    agent_id: String,
    nats_url: String,
}

fn parse_args() -> Result<Args> {
    let mut args = std::env::args().skip(1);
    let Some(agent_id) = args.next() else {
        bail!("usage: tui <agent-id> [nats-url]");
    };
    let nats_url = args
        .next()
        .unwrap_or_else(|| "nats://localhost:4222".to_string());
    Ok(Args { agent_id, nats_url })
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = parse_args()?;
    let bridge = Bridge::connect(&args.nats_url, &args.agent_id)
        .await
        .with_context(|| format!("connecting to NATS at {}", args.nats_url))?;
    let events = bridge.subscribe_events().await?;

    if std::io::stdin().is_terminal() {
        run_terminal(bridge, events).await
    } else {
        // Piped-stdin fallback: lines in, folded conversation out. Exists so a
        // harness can drive a round trip without a PTY.
        run_headless(bridge, events).await
    }
}

async fn run_terminal(bridge: Bridge, mut events: mpsc::UnboundedReceiver<Event>) -> Result<()> {
    let mut terminal = ratatui::init();
    let result = terminal_loop(&mut terminal, &bridge, &mut events).await;
    ratatui::restore();
    result
}

async fn terminal_loop(
    terminal: &mut ratatui::DefaultTerminal,
    bridge: &Bridge,
    events: &mut mpsc::UnboundedReceiver<Event>,
) -> Result<()> {
    let mut conversation = Conversation::default();
    let mut input = String::new();
    let mut term_events = EventStream::new();

    loop {
        terminal.draw(|frame| ui::draw(frame, &conversation, &input))?;

        tokio::select! {
            event = events.recv() => {
                let Some(event) = event else { bail!("event stream closed") };
                conversation.apply(event);
            }
            term_event = term_events.next() => {
                let Some(term_event) = term_event else { return Ok(()) };
                match term_event? {
                    TermEvent::Key(key) if key.kind == KeyEventKind::Press => match key.code {
                        KeyCode::Esc => return Ok(()),
                        KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                            return Ok(());
                        }
                        KeyCode::Enter => {
                            let text = input.trim().to_string();
                            if !text.is_empty() {
                                bridge.send_input(&text).await?;
                                input.clear();
                            }
                        }
                        KeyCode::Backspace => {
                            input.pop();
                        }
                        KeyCode::Char(character) => input.push(character),
                        _ => {}
                    },
                    _ => {}
                }
            }
        }
    }
}

/// Headless mode: read input lines from piped stdin, print state transitions to
/// stdout. Same fold, no terminal — the wire proof drives this.
async fn run_headless(bridge: Bridge, mut events: mpsc::UnboundedReceiver<Event>) -> Result<()> {
    use tokio::io::{AsyncBufReadExt, BufReader};

    let stdin = BufReader::new(tokio::io::stdin());
    let mut input_lines = stdin.lines();
    let mut conversation = Conversation::default();
    let mut stdin_open = true;

    loop {
        tokio::select! {
            event = events.recv() => {
                let Some(event) = event else { bail!("event stream closed") };
                conversation.apply(event);
                print_tail(&conversation);
                // Once stdin is done and no turn is running, the round trip is over.
                if !stdin_open && !conversation.turn_in_progress() {
                    return Ok(());
                }
            }
            line = input_lines.next_line(), if stdin_open => {
                match line? {
                    Some(line) if !line.trim().is_empty() => {
                        bridge.send_input(line.trim()).await?;
                        println!("[sent] {}", line.trim());
                    }
                    Some(_) => {}
                    None => {
                        stdin_open = false;
                        // Stdin may close after the turn already sealed; without this
                        // check no further event arrives to trigger the exit above.
                        if !conversation.turn_in_progress() {
                            return Ok(());
                        }
                    }
                }
            }
        }
    }
}

fn print_tail(conversation: &Conversation) {
    if let Some(entry) = conversation.entries().last() {
        match entry {
            Entry::User(text) => println!("[user] {text}"),
            Entry::Assistant {
                text,
                complete,
                failed,
            } => {
                let state = match (complete, failed) {
                    (false, _) => "streaming",
                    (true, false) => "complete",
                    (true, true) => "failed",
                };
                println!("[assistant {state}] {text}");
            }
            Entry::Error(message) => println!("[error] {message}"),
        }
    }
}
