//! The turn loop: owns the in-memory conversation and runs one turn per the
//! spec's turn semantics. Events go out through a channel; the bridge owns
//! publishing them to NATS, so this logic is testable without a broker.

use futures::StreamExt;
use tokio::sync::mpsc;

use crate::model::{ModelClient, ModelError};
use crate::protocol::{ChatMessage, Event, Role, StopReason, UserInput};

pub struct AgentCore<M> {
    model: M,
    conversation: Vec<ChatMessage>,
    turns_started: u64,
}

impl<M: ModelClient> AgentCore<M> {
    pub fn new(model: M) -> Self {
        Self {
            model,
            conversation: Vec::new(),
            turns_started: 0,
        }
    }

    pub fn conversation(&self) -> &[ChatMessage] {
        &self.conversation
    }

    /// Run one full turn: `turn_started` → deltas → `turn_ended`. Model failures
    /// are not `Err`s here — per the spec they become `error` + `turn_ended`
    /// with `stopReason: "error"`.
    pub async fn run_turn(&mut self, input: UserInput, events: &mpsc::Sender<Event>) {
        self.turns_started += 1;
        let turn_id = format!("t-{}", self.turns_started);
        send(
            events,
            Event::TurnStarted {
                turn_id: turn_id.clone(),
                text: input.text.clone(),
                from: input.from,
            },
        )
        .await;
        self.conversation.push(ChatMessage {
            role: Role::User,
            content: input.text,
        });

        let mut stream = match self.model.stream_reply(self.conversation.clone()).await {
            Ok(stream) => stream,
            Err(e) => return self.fail(turn_id, e, events).await,
        };

        let mut reply = String::new();
        loop {
            match stream.next().await {
                Some(Ok(text)) => {
                    reply.push_str(&text);
                    send(
                        events,
                        Event::TextDelta {
                            turn_id: turn_id.clone(),
                            text,
                        },
                    )
                    .await;
                }
                Some(Err(e)) => return self.fail(turn_id, e, events).await,
                None => break,
            }
        }

        self.conversation.push(ChatMessage {
            role: Role::Assistant,
            content: reply,
        });
        send(
            events,
            Event::TurnEnded {
                turn_id,
                stop_reason: StopReason::EndTurn,
            },
        )
        .await;
    }

    /// A failed turn gets no assistant reply, so the user message that started it
    /// is dropped too — keeping the conversation's user/assistant alternation
    /// valid for the next model request. (The spec is silent on this; alternation
    /// is its stated invariant.)
    async fn fail(&mut self, turn_id: String, error: ModelError, events: &mpsc::Sender<Event>) {
        self.conversation.pop();
        send(
            events,
            Event::Error {
                turn_id: Some(turn_id.clone()),
                message: error.to_string(),
            },
        )
        .await;
        send(
            events,
            Event::TurnEnded {
                turn_id,
                stop_reason: StopReason::Error,
            },
        )
        .await;
    }
}

/// A closed receiver only happens at shutdown; there is nowhere left to report to.
async fn send(events: &mpsc::Sender<Event>, event: Event) {
    let _ = events.send(event).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::TextStream;
    use crate::protocol::{Origin, OriginKind};
    use futures::StreamExt;

    enum Script {
        Reply(Vec<&'static str>),
        FailAtStart,
        FailAfter(Vec<&'static str>),
    }

    struct ScriptedModel(Script);

    impl ModelClient for ScriptedModel {
        async fn stream_reply(&self, _: Vec<ChatMessage>) -> Result<TextStream, ModelError> {
            match &self.0 {
                Script::Reply(chunks) => {
                    let items: Vec<Result<String, ModelError>> =
                        chunks.iter().map(|c| Ok((*c).to_string())).collect();
                    Ok(futures::stream::iter(items).boxed())
                }
                Script::FailAtStart => Err(ModelError::Status(500)),
                Script::FailAfter(chunks) => {
                    let mut items: Vec<Result<String, ModelError>> =
                        chunks.iter().map(|c| Ok((*c).to_string())).collect();
                    items.push(Err(ModelError::Protocol("connection dropped".into())));
                    Ok(futures::stream::iter(items).boxed())
                }
            }
        }
    }

    fn input(text: &str) -> UserInput {
        UserInput {
            from: Origin {
                kind: OriginKind::Human,
            },
            text: text.into(),
        }
    }

    async fn collect(core: &mut AgentCore<ScriptedModel>, text: &str) -> Vec<Event> {
        let (tx, mut rx) = mpsc::channel(64);
        core.run_turn(input(text), &tx).await;
        drop(tx);
        let mut events = Vec::new();
        while let Some(e) = rx.recv().await {
            events.push(e);
        }
        events
    }

    #[tokio::test]
    async fn happy_turn_emits_started_deltas_ended() {
        let mut core = AgentCore::new(ScriptedModel(Script::Reply(vec!["4", " is", " right"])));
        let events = collect(&mut core, "What's 2+2?").await;

        assert_eq!(events.len(), 5);
        assert!(
            matches!(&events[0], Event::TurnStarted { turn_id, text, .. }
            if turn_id == "t-1" && text == "What's 2+2?")
        );
        assert!(matches!(&events[1], Event::TextDelta { text, .. } if text == "4"));
        assert!(
            matches!(&events[4], Event::TurnEnded { turn_id, stop_reason }
            if turn_id == "t-1" && *stop_reason == StopReason::EndTurn)
        );

        let conv = core.conversation();
        assert_eq!(conv.len(), 2);
        assert_eq!(conv[1].content, "4 is right");
    }

    #[tokio::test]
    async fn failure_at_start_emits_error_then_ended() {
        let mut core = AgentCore::new(ScriptedModel(Script::FailAtStart));
        let events = collect(&mut core, "hi").await;

        assert_eq!(events.len(), 3);
        assert!(matches!(&events[1], Event::Error { turn_id: Some(id), .. } if id == "t-1"));
        assert!(matches!(&events[2], Event::TurnEnded { stop_reason, .. }
            if *stop_reason == StopReason::Error));
        assert!(core.conversation().is_empty());
    }

    #[tokio::test]
    async fn failure_mid_stream_emits_deltas_then_error_then_ended() {
        let mut core = AgentCore::new(ScriptedModel(Script::FailAfter(vec!["partial"])));
        let events = collect(&mut core, "hi").await;

        assert_eq!(events.len(), 4);
        assert!(matches!(&events[1], Event::TextDelta { text, .. } if text == "partial"));
        assert!(matches!(
            &events[2],
            Event::Error {
                turn_id: Some(_),
                ..
            }
        ));
        assert!(matches!(&events[3], Event::TurnEnded { stop_reason, .. }
            if *stop_reason == StopReason::Error));
        assert!(core.conversation().is_empty());
    }

    #[tokio::test]
    async fn turn_ids_increment_across_turns() {
        let mut core = AgentCore::new(ScriptedModel(Script::Reply(vec!["ok"])));
        collect(&mut core, "one").await;
        let events = collect(&mut core, "two").await;
        assert!(matches!(&events[0], Event::TurnStarted { turn_id, .. } if turn_id == "t-2"));
        assert_eq!(core.conversation().len(), 4);
    }
}
