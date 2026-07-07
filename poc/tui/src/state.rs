//! Event folding: events in, conversation state out. No terminal, no NATS — this is
//! the logic the tests drive.

use crate::protocol::{Event, StopReason};

/// One rendered line-group in the conversation.
#[derive(Debug, Clone, PartialEq)]
pub enum Entry {
    /// The input that started a turn (`turn_started.text`).
    User(String),
    /// Assistant text, accumulated from `text_delta`s.
    Assistant {
        text: String,
        /// `true` once `turn_ended` sealed the turn.
        complete: bool,
        /// `true` when the turn ended with `stopReason: "error"`.
        failed: bool,
    },
    /// A broadcast `error` event.
    Error(String),
}

/// Conversation state folded from the agent's event stream.
#[derive(Debug, Default)]
pub struct Conversation {
    entries: Vec<Entry>,
    /// The turn currently streaming: its id and the index of its assistant entry.
    current: Option<(String, usize)>,
    /// Set once `agent_ready` is seen.
    agent_id: Option<String>,
}

impl Conversation {
    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    pub fn agent_id(&self) -> Option<&str> {
        self.agent_id.as_deref()
    }

    /// Whether a turn is streaming right now.
    pub fn turn_in_progress(&self) -> bool {
        self.current.is_some()
    }

    /// Fold one event into the state.
    pub fn apply(&mut self, event: Event) {
        match event {
            Event::AgentReady { agent_id } => {
                self.agent_id = Some(agent_id);
            }
            Event::TurnStarted { turn_id, text, .. } => {
                self.entries.push(Entry::User(text));
                self.entries.push(Entry::Assistant {
                    text: String::new(),
                    complete: false,
                    failed: false,
                });
                self.current = Some((turn_id, self.entries.len() - 1));
            }
            Event::TextDelta { turn_id, text } => {
                if let Some(index) = self.current_index(&turn_id)
                    && let Some(Entry::Assistant { text: acc, .. }) = self.entries.get_mut(index)
                {
                    acc.push_str(&text);
                }
            }
            Event::TurnEnded {
                turn_id,
                stop_reason,
            } => {
                if let Some(index) = self.current_index(&turn_id) {
                    if let Some(Entry::Assistant {
                        complete, failed, ..
                    }) = self.entries.get_mut(index)
                    {
                        *complete = true;
                        *failed = stop_reason == StopReason::Error;
                    }
                    self.current = None;
                }
            }
            Event::Error { message, .. } => {
                self.entries.push(Entry::Error(message));
            }
        }
    }

    fn current_index(&self, turn_id: &str) -> Option<usize> {
        match &self.current {
            Some((id, index)) if id == turn_id => Some(*index),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{From, Kind};

    fn started(turn_id: &str, text: &str) -> Event {
        Event::TurnStarted {
            turn_id: turn_id.into(),
            text: text.into(),
            from: From { kind: Kind::Human },
        }
    }

    fn delta(turn_id: &str, text: &str) -> Event {
        Event::TextDelta {
            turn_id: turn_id.into(),
            text: text.into(),
        }
    }

    fn ended(turn_id: &str, stop_reason: StopReason) -> Event {
        Event::TurnEnded {
            turn_id: turn_id.into(),
            stop_reason,
        }
    }

    #[test]
    fn deltas_accumulate_and_turn_seals() {
        let mut conversation = Conversation::default();
        conversation.apply(started("t-1", "What's 2+2?"));
        assert!(conversation.turn_in_progress());
        conversation.apply(delta("t-1", "It "));
        conversation.apply(delta("t-1", "is "));
        conversation.apply(delta("t-1", "4."));
        conversation.apply(ended("t-1", StopReason::EndTurn));

        assert!(!conversation.turn_in_progress());
        assert_eq!(
            conversation.entries(),
            &[
                Entry::User("What's 2+2?".into()),
                Entry::Assistant {
                    text: "It is 4.".into(),
                    complete: true,
                    failed: false,
                },
            ]
        );
    }

    #[test]
    fn error_stop_reason_marks_the_turn_failed() {
        let mut conversation = Conversation::default();
        conversation.apply(started("t-1", "hi"));
        conversation.apply(delta("t-1", "partial"));
        conversation.apply(Event::Error {
            turn_id: Some("t-1".into()),
            message: "model call failed".into(),
        });
        conversation.apply(ended("t-1", StopReason::Error));

        assert_eq!(
            conversation.entries(),
            &[
                Entry::User("hi".into()),
                Entry::Assistant {
                    text: "partial".into(),
                    complete: true,
                    failed: true,
                },
                Entry::Error("model call failed".into()),
            ]
        );
    }

    #[test]
    fn rejection_error_records_without_a_turn() {
        let mut conversation = Conversation::default();
        conversation.apply(Event::Error {
            turn_id: None,
            message: "turn already in progress".into(),
        });
        assert_eq!(
            conversation.entries(),
            &[Entry::Error("turn already in progress".into())]
        );
    }

    #[test]
    fn deltas_for_a_stale_turn_are_ignored() {
        let mut conversation = Conversation::default();
        conversation.apply(started("t-1", "hi"));
        conversation.apply(ended("t-1", StopReason::EndTurn));
        conversation.apply(delta("t-1", "late"));
        assert_eq!(
            conversation.entries()[1],
            Entry::Assistant {
                text: String::new(),
                complete: true,
                failed: false,
            }
        );
    }

    #[test]
    fn unknown_event_types_never_reach_the_fold() {
        // Event::parse is the gate: unknown types come back None and are dropped.
        assert_eq!(Event::parse(br#"{ "type": "telemetry", "v": 2 }"#), None);
    }

    #[test]
    fn agent_ready_records_the_agent_id() {
        let mut conversation = Conversation::default();
        conversation.apply(Event::AgentReady {
            agent_id: "agent-4f2a".into(),
        });
        assert_eq!(conversation.agent_id(), Some("agent-4f2a"));
    }
}
