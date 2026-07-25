//! Cross-instance liveness fold (agent-spec, "Liveness is a fold, never
//! declared"): who else in this world is attached to which conversation, and
//! whether they're still alive. A pure fold over explicit facts and an
//! injected `now`, so it is tested without a clock or a broker — the only
//! fake anywhere near this is `std::time::Instant`, supplied by the caller.
//!
//! Two facts, kept apart exactly as the spec keeps them apart: `attachments`
//! is decided state (who last claimed a conversation); `instances`' liveness
//! is inferred from pulse silence, never declared. Default silence
//! threshold: 60s, applied until a real `intervalS` promise arrives ("no
//! declared interval yet is not the same as alive"). Stranded: ~3x an
//! instance's own declared interval.

use std::collections::HashMap;
use std::time::{Duration, Instant};

const DEFAULT_INTERVAL_S: i64 = 60;
const STRANDED_MULTIPLE: u64 = 3;

#[derive(Debug, Clone, Copy)]
struct InstancePulse {
    last_seen: Instant,
    interval_s: i64,
}

/// The world's servicing map, folded from `agent.v1.{world}.telemetry.>`
/// alone.
#[derive(Debug, Default)]
pub struct WorldState {
    instances: HashMap<String, InstancePulse>,
    attachments: HashMap<String, String>, // conversationId -> instanceId
}

impl WorldState {
    pub fn new() -> Self {
        Self::default()
    }

    /// `ready` restates liveness with no interval yet — seed the default
    /// threshold so a boot-then-silence instance still gets a verdict.
    pub fn on_ready(&mut self, instance_id: &str, now: Instant) {
        let entry = self
            .instances
            .entry(instance_id.to_string())
            .or_insert(InstancePulse {
                last_seen: now,
                interval_s: DEFAULT_INTERVAL_S,
            });
        entry.last_seen = now;
    }

    pub fn on_pulse(&mut self, instance_id: &str, interval_s: i64, now: Instant) {
        self.instances.insert(
            instance_id.to_string(),
            InstancePulse {
                last_seen: now,
                interval_s,
            },
        );
    }

    /// `attached` states ownership (last-write-wins per conversation) and,
    /// when it carries `intervalS`, gives that instance an immediate
    /// liveness basis — a fresh attachment need not wait for its first
    /// separate pulse.
    pub fn on_attached(
        &mut self,
        instance_id: &str,
        conversation_id: &str,
        interval_s: Option<i64>,
        now: Instant,
    ) {
        self.attachments
            .insert(conversation_id.to_string(), instance_id.to_string());
        let entry = self
            .instances
            .entry(instance_id.to_string())
            .or_insert(InstancePulse {
                last_seen: now,
                interval_s: interval_s.unwrap_or(DEFAULT_INTERVAL_S),
            });
        entry.last_seen = now;
        if let Some(i) = interval_s {
            entry.interval_s = i;
        }
    }

    /// `detached` is a decided fact: release ownership outright, whoever the
    /// fold currently thinks holds it (tolerance — an instance this fold
    /// never saw `ready` for can still detach).
    pub fn on_detached(&mut self, conversation_id: &str) {
        self.attachments.remove(conversation_id);
    }

    fn is_alive(&self, instance_id: &str, now: Instant) -> bool {
        match self.instances.get(instance_id) {
            Some(p) => {
                let threshold = Duration::from_secs(p.interval_s.max(0) as u64 * STRANDED_MULTIPLE);
                now.duration_since(p.last_seen) < threshold
            }
            None => false,
        }
    }

    /// The instance id owning a live attachment to `conversation_id`, if any
    /// other than `own_instance` — the fact `service` needs to answer
    /// `already_attached` honestly across instances, not only locally.
    /// `None` when nobody owns it, the owner is `own_instance` (the caller's
    /// own `served` map is authoritative there), or the owner has gone
    /// stranded (a stale claim `service` may override, per the spec's
    /// takeover case).
    pub fn attached_elsewhere(
        &self,
        conversation_id: &str,
        own_instance: &str,
        now: Instant,
    ) -> Option<&str> {
        let owner = self.attachments.get(conversation_id)?;
        if owner == own_instance {
            return None;
        }
        if self.is_alive(owner, now) {
            Some(owner.as_str())
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nobody_attached_is_not_attached_elsewhere() {
        let world = WorldState::new();
        assert_eq!(
            world.attached_elsewhere("conv-1", "inst-a", Instant::now()),
            None
        );
    }

    #[test]
    fn attached_by_another_live_instance_is_attached_elsewhere() {
        let mut world = WorldState::new();
        let now = Instant::now();
        world.on_pulse("inst-b", 30, now);
        world.on_attached("inst-b", "conv-1", None, now);
        assert_eq!(
            world.attached_elsewhere("conv-1", "inst-a", now),
            Some("inst-b")
        );
    }

    #[test]
    fn attached_by_this_instance_is_not_attached_elsewhere() {
        let mut world = WorldState::new();
        let now = Instant::now();
        world.on_pulse("inst-a", 30, now);
        world.on_attached("inst-a", "conv-1", None, now);
        assert_eq!(world.attached_elsewhere("conv-1", "inst-a", now), None);
    }

    #[test]
    fn a_stranded_owner_is_no_longer_attached_elsewhere() {
        let mut world = WorldState::new();
        let t0 = Instant::now();
        world.on_pulse("inst-b", 10, t0);
        world.on_attached("inst-b", "conv-1", None, t0);
        let later = t0 + Duration::from_secs(31); // > 3 * 10s
        assert_eq!(world.attached_elsewhere("conv-1", "inst-a", later), None);
    }

    #[test]
    fn a_fresh_owner_within_its_interval_stays_attached_elsewhere() {
        let mut world = WorldState::new();
        let t0 = Instant::now();
        world.on_pulse("inst-b", 30, t0);
        world.on_attached("inst-b", "conv-1", None, t0);
        let later = t0 + Duration::from_secs(45); // < 3 * 30s
        assert_eq!(
            world.attached_elsewhere("conv-1", "inst-a", later),
            Some("inst-b")
        );
    }

    #[test]
    fn detached_releases_ownership_immediately() {
        let mut world = WorldState::new();
        let now = Instant::now();
        world.on_pulse("inst-b", 30, now);
        world.on_attached("inst-b", "conv-1", None, now);
        world.on_detached("conv-1");
        assert_eq!(world.attached_elsewhere("conv-1", "inst-a", now), None);
    }

    #[test]
    fn an_attachment_with_no_interval_yet_uses_the_default_threshold() {
        let mut world = WorldState::new();
        let t0 = Instant::now();
        world.on_ready("inst-b", t0);
        world.on_attached("inst-b", "conv-1", None, t0);
        let just_under = t0 + Duration::from_secs(179); // < 3 * 60s default
        assert_eq!(
            world.attached_elsewhere("conv-1", "inst-a", just_under),
            Some("inst-b")
        );
        let over = t0 + Duration::from_secs(181);
        assert_eq!(world.attached_elsewhere("conv-1", "inst-a", over), None);
    }
}
