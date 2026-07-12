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
        // UTC with the +00:00 spelled as an offset the spec's grammar
        // accepts. std has no civil-time formatting; the epoch → civil
        // conversion mirrors wire::ts (Hinnant's civil_from_days).
        let ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock before 1970")
            .as_millis() as i64;
        let (secs, millis) = (ms.div_euclid(1000), ms.rem_euclid(1000));
        let (days, sod) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
        let (y, m, d) = civil_from_days(days);
        format!(
            "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}+00:00",
            sod / 3600,
            (sod % 3600) / 60,
            sod % 60
        )
    }
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
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
