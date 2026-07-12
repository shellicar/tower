//! The two traits (tower-v1-design.md, Seams): capabilities, not data.
//! Everything else at every boundary is a plain value.

use std::future::Future;
use std::time::Duration;

/// A request's transport outcome. Timeout and no-responders both exist as
/// values because the gateway folds them to the same meaning (`Unreachable`)
/// — the distinction carries no meaning and is deliberately not exposed
/// further, but the trait reports what actually happened.
#[derive(Debug, Clone, PartialEq)]
pub enum BrokerReply {
    Data(Vec<u8>),
    Timeout,
    NoResponders,
}

pub trait Broker: Clone + Send + Sync + 'static {
    fn request(
        &self,
        subject: &str,
        payload: Vec<u8>,
        timeout: Duration,
    ) -> impl Future<Output = BrokerReply> + Send;
}

pub trait Clock: Clone + Send + Sync + 'static {
    /// ISO-8601 with a real UTC offset — what the wire envelope carries.
    fn now_iso(&self) -> String;
}

// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct NatsBroker {
    pub client: async_nats::Client,
}

impl Broker for NatsBroker {
    async fn request(&self, subject: &str, payload: Vec<u8>, timeout: Duration) -> BrokerReply {
        let request = async_nats::Request::new()
            .payload(payload.into())
            .timeout(Some(timeout));
        match self.client.send_request(subject.to_string(), request).await {
            Ok(message) => BrokerReply::Data(message.payload.to_vec()),
            Err(e) => match e.kind() {
                async_nats::RequestErrorKind::NoResponders => BrokerReply::NoResponders,
                _ => BrokerReply::Timeout,
            },
        }
    }
}

#[derive(Clone)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_iso(&self) -> String {
        // Hoisted into wire::ts so every producer in the workspace stamps
        // identically (the bridge shares it).
        wire::now_iso()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_clock_round_trips_through_the_wire_grammar() {
        let now = SystemClock.now_iso();
        assert!(wire::parse_ts(&now).is_some(), "{now}");
    }
}
