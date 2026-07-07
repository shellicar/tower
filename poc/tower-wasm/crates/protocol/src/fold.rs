//! Pure event folding: envelopes in, per-agent conversation state out.
//!
//! No I/O — the frontend calls [`Dashboard::apply`] per WebSocket message,
//! and the unit tests drive it directly.

use std::collections::BTreeMap;

use crate::{AgentEvent, Envelope};

/// One settled line of a conversation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Entry {
    User(String),
    Assistant(String),
    Error(String),
}

/// An assistant reply still streaming in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamingTurn {
    pub turn_id: String,
    pub text: String,
}

/// Everything the dashboard shows for one agent.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AgentView {
    /// Raw event feed, one line per event, newest last.
    pub feed: Vec<String>,
    /// The folded conversation.
    pub conversation: Vec<Entry>,
    /// The turn currently streaming, if any.
    pub streaming: Option<StreamingTurn>,
}

/// All discovered agents, keyed by id.
///
/// Discovery per the spec: any envelope from an unknown agent id creates the
/// agent — whether it arrived via `agent.announce` or the events wildcard.
#[derive(Debug, Default)]
pub struct Dashboard {
    pub agents: BTreeMap<String, AgentView>,
}

impl Dashboard {
    pub fn apply(&mut self, envelope: &Envelope) {
        let view = self.agents.entry(envelope.agent_id.clone()).or_default();
        match serde_json::from_value::<AgentEvent>(envelope.event.clone()) {
            Ok(event) => view.apply(event),
            Err(_) => view.apply_unknown(&envelope.event),
        }
    }
}

impl AgentView {
    fn apply(&mut self, event: AgentEvent) {
        self.feed.push(feed_line(&event));
        match event {
            AgentEvent::AgentReady { .. } => {}
            AgentEvent::TurnStarted { turn_id, text, .. } => {
                self.conversation.push(Entry::User(text));
                self.streaming = Some(StreamingTurn {
                    turn_id,
                    text: String::new(),
                });
            }
            AgentEvent::TextDelta { turn_id, text } => match &mut self.streaming {
                Some(streaming) if streaming.turn_id == turn_id => {
                    streaming.text.push_str(&text);
                }
                // A delta for a turn we never saw start (late attach): begin
                // streaming from here rather than lose the text.
                _ => {
                    self.streaming = Some(StreamingTurn { turn_id, text });
                }
            },
            AgentEvent::TurnEnded { turn_id, .. } => {
                if let Some(streaming) = self.streaming.take_if(|s| s.turn_id == turn_id)
                    && !streaming.text.is_empty()
                {
                    self.conversation.push(Entry::Assistant(streaming.text));
                }
            }
            AgentEvent::Error { message, .. } => {
                self.conversation.push(Entry::Error(message));
            }
        }
    }

    /// Unknown event types are shown generically, not dropped (spec rule).
    fn apply_unknown(&mut self, event: &serde_json::Value) {
        let kind = event
            .get("type")
            .and_then(|t| t.as_str())
            .unwrap_or("<untyped>");
        self.feed.push(format!("unknown event `{kind}`: {event}"));
    }
}

fn feed_line(event: &AgentEvent) -> String {
    match event {
        AgentEvent::AgentReady { agent_id } => format!("agent_ready {agent_id}"),
        AgentEvent::TurnStarted { turn_id, text, .. } => {
            format!("turn_started {turn_id}: {text}")
        }
        AgentEvent::TextDelta { turn_id, text } => format!("text_delta {turn_id}: {text:?}"),
        AgentEvent::TurnEnded {
            turn_id,
            stop_reason,
        } => format!("turn_ended {turn_id}: {stop_reason:?}"),
        AgentEvent::Error { turn_id, message } => match turn_id {
            Some(turn_id) => format!("error ({turn_id}): {message}"),
            None => format!("error: {message}"),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn envelope(agent_id: &str, json: &str) -> Envelope {
        Envelope {
            agent_id: agent_id.to_owned(),
            event: serde_json::from_str(json).unwrap(),
        }
    }

    #[test]
    fn full_turn_folds_into_user_and_assistant_entries() {
        let mut dash = Dashboard::default();
        for json in [
            r#"{ "type": "agent_ready", "agentId": "a1" }"#,
            r#"{ "type": "turn_started", "turnId": "t-1", "text": "What's 2+2?", "from": { "kind": "human" } }"#,
            r#"{ "type": "text_delta", "turnId": "t-1", "text": "The answer " }"#,
            r#"{ "type": "text_delta", "turnId": "t-1", "text": "is 4." }"#,
            r#"{ "type": "turn_ended", "turnId": "t-1", "stopReason": "end_turn" }"#,
        ] {
            dash.apply(&envelope("a1", json));
        }
        let view = &dash.agents["a1"];
        assert_eq!(
            view.conversation,
            vec![
                Entry::User("What's 2+2?".into()),
                Entry::Assistant("The answer is 4.".into()),
            ]
        );
        assert!(view.streaming.is_none());
        assert_eq!(view.feed.len(), 5);
    }

    #[test]
    fn streaming_text_accumulates_until_turn_ends() {
        let mut dash = Dashboard::default();
        dash.apply(&envelope(
            "a1",
            r#"{ "type": "turn_started", "turnId": "t-1", "text": "hi", "from": { "kind": "human" } }"#,
        ));
        dash.apply(&envelope(
            "a1",
            r#"{ "type": "text_delta", "turnId": "t-1", "text": "hel" }"#,
        ));
        dash.apply(&envelope(
            "a1",
            r#"{ "type": "text_delta", "turnId": "t-1", "text": "lo" }"#,
        ));
        let streaming = dash.agents["a1"].streaming.as_ref().unwrap();
        assert_eq!(streaming.text, "hello");
    }

    #[test]
    fn error_mid_turn_is_visible_and_turn_still_closes() {
        let mut dash = Dashboard::default();
        for json in [
            r#"{ "type": "turn_started", "turnId": "t-1", "text": "hi", "from": { "kind": "human" } }"#,
            r#"{ "type": "text_delta", "turnId": "t-1", "text": "par" }"#,
            r#"{ "type": "error", "turnId": "t-1", "message": "model call failed" }"#,
            r#"{ "type": "turn_ended", "turnId": "t-1", "stopReason": "error" }"#,
        ] {
            dash.apply(&envelope("a1", json));
        }
        let view = &dash.agents["a1"];
        assert_eq!(
            view.conversation,
            vec![
                Entry::User("hi".into()),
                Entry::Error("model call failed".into()),
                Entry::Assistant("par".into()),
            ]
        );
        assert!(view.streaming.is_none());
    }

    #[test]
    fn rejected_input_error_has_no_turn_and_shows() {
        let mut dash = Dashboard::default();
        dash.apply(&envelope(
            "a1",
            r#"{ "type": "error", "message": "turn already in progress" }"#,
        ));
        assert_eq!(
            dash.agents["a1"].conversation,
            vec![Entry::Error("turn already in progress".into())]
        );
    }

    #[test]
    fn unknown_event_type_is_shown_generically() {
        let mut dash = Dashboard::default();
        dash.apply(&envelope("a1", r#"{ "type": "telemetry", "cpu": 0.5 }"#));
        let view = &dash.agents["a1"];
        assert_eq!(view.feed.len(), 1);
        assert!(view.feed[0].contains("unknown event `telemetry`"));
    }

    #[test]
    fn events_from_unknown_agent_discover_it() {
        let mut dash = Dashboard::default();
        dash.apply(&envelope(
            "late-agent",
            r#"{ "type": "text_delta", "turnId": "t-9", "text": "mid" }"#,
        ));
        let view = &dash.agents["late-agent"];
        assert_eq!(view.streaming.as_ref().unwrap().text, "mid");
    }
}
