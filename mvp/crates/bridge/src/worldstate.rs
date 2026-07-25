//! Cross-instance liveness fold (agent-spec, "Liveness is a fold, never
//! declared"): who else in this world is attached to which conversation, and
//! whether they're still alive. A pure fold over explicit facts and an
//! injected `now`, so it is tested without a clock or a broker — the only
//! fake anywhere near this is `std::time::Instant`, supplied by the caller.
//! Behaviour and its limits are agent-spec's own (service's cross-instance
//! premise-check note); this module is the implementation, not the place
//! that decides the semantics.
//!
//! Two facts, kept apart exactly as the spec keeps them apart: `attachments`
//! is decided state (who last claimed a conversation, released only by a
//! `detached` from that same instance — a stale `detached` from a
//! since-superseded owner must never erase a newer owner's claim); an
//! instance's liveness is inferred from pulse silence, never declared. No
//! declared interval yet is genuinely not the same as alive: an instance
//! seen only via `ready` gets the spec's flat default silence threshold
//! (60s) directly, never multiplied — the ~3x-declared-interval rule is for
//! an instance that has actually promised a cadence.

use std::collections::HashMap;
use std::time::{Duration, Instant};

const DEFAULT_SILENCE_S: u64 = 60;
const STRANDED_MULTIPLE: u64 = 3;

#[derive(Debug, Clone, Copy)]
struct InstancePulse {
    last_seen: Instant,
    /// `None` until a `pulse` (or an `attached` carrying `intervalS`)
    /// actually declares a cadence — distinct from "declared 0", and from
    /// "definitely alive".
    interval_s: Option<i64>,
}

impl InstancePulse {
    fn silence_threshold(&self) -> Duration {
        match self.interval_s {
            Some(i) => Duration::from_secs(i.max(0) as u64 * STRANDED_MULTIPLE),
            None => Duration::from_secs(DEFAULT_SILENCE_S),
        }
    }
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

    /// `ready` restates liveness with no interval yet.
    pub fn on_ready(&mut self, instance_id: &str, now: Instant) {
        self.instances
            .entry(instance_id.to_string())
            .or_insert(InstancePulse {
                last_seen: now,
                interval_s: None,
            })
            .last_seen = now;
    }

    pub fn on_pulse(&mut self, instance_id: &str, interval_s: i64, now: Instant) {
        self.instances.insert(
            instance_id.to_string(),
            InstancePulse {
                last_seen: now,
                interval_s: Some(interval_s),
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
                interval_s,
            });
        entry.last_seen = now;
        if interval_s.is_some() {
            entry.interval_s = interval_s;
        }
    }

    /// `detached` is a decided fact, but only for the instance that sent it:
    /// remove the claim only if the fold's current owner is that same
    /// instance. Plain NATS carries no cross-publisher ordering, so a
    /// takeover's new `attached` can be folded before the old owner's late
    /// `detached` arrives; releasing unconditionally would let that stale
    /// detach erase the new owner's live claim.
    pub fn on_detached(&mut self, instance_id: &str, conversation_id: &str) {
        if self.attachments.get(conversation_id).map(String::as_str) == Some(instance_id) {
            self.attachments.remove(conversation_id);
        }
    }

    fn is_alive(&self, instance_id: &str, now: Instant) -> bool {
        match self.instances.get(instance_id) {
            Some(p) => now.duration_since(p.last_seen) < p.silence_threshold(),
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
    fn detached_by_its_own_owner_releases_ownership_immediately() {
        let mut world = WorldState::new();
        let now = Instant::now();
        world.on_pulse("inst-b", 30, now);
        world.on_attached("inst-b", "conv-1", None, now);
        world.on_detached("inst-b", "conv-1");
        assert_eq!(world.attached_elsewhere("conv-1", "inst-a", now), None);
    }

    /// The regression this module must never reintroduce: a takeover's new
    /// `attached` lands, then the *old* owner's late `detached` arrives for
    /// the same conversation — plain NATS gives no cross-publisher ordering
    /// guarantee, so this is a real, not hypothetical, interleaving. The
    /// stale detach must not erase the new owner's live claim.
    #[test]
    fn a_stale_detach_from_a_superseded_owner_does_not_erase_the_new_owners_claim() {
        let mut world = WorldState::new();
        let t0 = Instant::now();
        world.on_pulse("inst-b", 30, t0);
        world.on_attached("inst-b", "conv-1", None, t0);
        // Takeover: inst-c attaches after inst-b's pulse goes stranded.
        let takeover = t0 + Duration::from_secs(91);
        world.on_pulse("inst-c", 30, takeover);
        world.on_attached("inst-c", "conv-1", None, takeover);
        // inst-b's own detached, published before the takeover but delivered
        // after it — a stale fact arriving late.
        world.on_detached("inst-b", "conv-1");
        assert_eq!(
            world.attached_elsewhere("conv-1", "inst-a", takeover),
            Some("inst-c")
        );
    }

    #[test]
    fn an_instance_known_only_via_ready_uses_the_flat_default_threshold_not_a_multiple_of_it() {
        let mut world = WorldState::new();
        let t0 = Instant::now();
        world.on_ready("inst-b", t0);
        world.on_attached("inst-b", "conv-1", None, t0);
        let just_under = t0 + Duration::from_secs(59); // < 60s default, no 3x
        assert_eq!(
            world.attached_elsewhere("conv-1", "inst-a", just_under),
            Some("inst-b")
        );
        let over = t0 + Duration::from_secs(61); // > 60s default
        assert_eq!(world.attached_elsewhere("conv-1", "inst-a", over), None);
    }
}
