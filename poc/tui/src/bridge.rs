//! The NATS side: subscribe to the agent's events, publish user input to its
//! messages subject.

use anyhow::Result;
use futures::StreamExt;
use tokio::sync::mpsc;

use crate::protocol::{ClientMessage, Event};

/// The two subjects a client uses for one agent.
#[derive(Debug, Clone)]
pub struct Subjects {
    pub events: String,
    pub messages: String,
}

impl Subjects {
    pub fn for_agent(agent_id: &str) -> Self {
        Subjects {
            events: format!("agent.{agent_id}.events"),
            messages: format!("agent.{agent_id}.messages"),
        }
    }
}

/// A connected bridge to one agent over NATS.
pub struct Bridge {
    client: async_nats::Client,
    subjects: Subjects,
}

impl Bridge {
    pub async fn connect(nats_url: &str, agent_id: &str) -> Result<Self> {
        let client = async_nats::connect(nats_url).await?;
        Ok(Bridge {
            client,
            subjects: Subjects::for_agent(agent_id),
        })
    }

    /// Subscribe to the agent's events. Parsed events land on the returned channel;
    /// unknown types and malformed payloads are dropped by `Event::parse`.
    pub async fn subscribe_events(&self) -> Result<mpsc::UnboundedReceiver<Event>> {
        let mut subscription = self.client.subscribe(self.subjects.events.clone()).await?;
        let (sender, receiver) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            while let Some(message) = subscription.next().await {
                if let Some(event) = Event::parse(&message.payload)
                    && sender.send(event).is_err()
                {
                    break;
                }
            }
        });
        Ok(receiver)
    }

    /// Publish a `user_input` to the agent's messages subject.
    pub async fn send_input(&self, text: &str) -> Result<()> {
        let payload = serde_json::to_vec(&ClientMessage::human_input(text))?;
        self.client
            .publish(self.subjects.messages.clone(), payload.into())
            .await?;
        self.client.flush().await?;
        Ok(())
    }
}
