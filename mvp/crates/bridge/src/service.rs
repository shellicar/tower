//! The `service` verb's premise (agent.md, "The premise for `service`"):
//! two pure folds and the four-case decision built on them. No I/O here —
//! the request loop in main.rs feeds these from the Broker seam.
//!
//! - `fold_attachment` reads a conversation's `conv.v2.{id}.attachment.>`
//!   capture into the standing claim, applying the spec's full fold rules:
//!   unconditional supersession, the standing-instance gate for `moved`/
//!   `detached`, and loss of authority (a violator's post-violation events
//!   do not fold — nats.md, Conformance).
//! - `WorldLiveness` folds this world's own telemetry (`ready`/`pulse`)
//!   into the alive-vs-stranded verdict, judged against each instance's own
//!   declared cadence.
//! - `service_premise` is the four cases, exactly.

use std::time::{Duration, Instant};

use wire::ConvAttachment;

/// No promise yet is not the same as alive: an instance that never declared
/// a cadence gets this flat threshold (agent.md's suggested default), not
/// a multiple of a promise it never made.
const DEFAULT_SILENCE_S: u64 = 60;
/// Presumed gone after about three of its own declared intervals of silence.
const STRANDED_MULTIPLE: u64 = 3;
/// The slowest heartbeat this consumer honours (a deliberate cap, headed
/// for the spec): a declared interval above it folds to it, so a bogus
/// `intervalS: 86400` cannot keep a dead holder "alive" for days and block
/// service on its conversation. 10 minutes is already extremely generous
/// against the 30s cadence bridge itself pulses at.
const MAX_INTERVAL_S: u64 = 600;
/// The longest silence any instance is ever granted — 3× the capped
/// interval. Also the exact capture window a boot-time seed needs: a pulse
/// older than this cannot change any verdict, so replaying further back
/// buys nothing.
pub const MAX_SILENCE_S: u64 = STRANDED_MULTIPLE * MAX_INTERVAL_S;

/// An attachment event's identity: the `(world, instanceId)` pair. Two
/// identities match on the pair; if either side omits `world`, the gate
/// falls back to bare `instanceId` — degraded, not broken
/// (conversation.md, Attachment).
fn same_identity(
    a_world: Option<&str>,
    a_instance: &str,
    b_world: Option<&str>,
    b_instance: &str,
) -> bool {
    if a_instance != b_instance {
        return false;
    }
    match (a_world, b_world) {
        (Some(a), Some(b)) => a == b,
        _ => true,
    }
}

/// The standing attachment the fold arrives at: whichever compliant
/// `attached` published last on the conversation's subject.
#[derive(Debug, Clone, PartialEq)]
pub struct Standing {
    pub instance_id: String,
    pub world: Option<String>,
    pub cwd: Option<String>,
}

/// Fold a conversation's attachment record, in subject order, into the
/// standing claim. Applies loss of authority: an instance whose second
/// `attached` lands while its own claim is open (no own `detached` between)
/// is non-compliant from that event on — the violating `attached` does not
/// fold, and nothing that identity publishes afterward folds either,
/// including a `detached` (agent.md, Attachment, example e).
pub fn fold_attachment<'a>(
    events: impl IntoIterator<Item = &'a ConvAttachment>,
) -> Option<Standing> {
    let mut standing: Option<Standing> = None;
    // Identities with an open claim: opened by their `attached`, closed only
    // by their own `detached` — supersession does NOT close it, which is
    // exactly why a superseded instance re-attaching without ever detaching
    // is the violation shape.
    let mut open: Vec<(Option<String>, String)> = Vec::new();
    let mut violators: Vec<(Option<String>, String)> = Vec::new();

    let is_in = |set: &[(Option<String>, String)], world: Option<&str>, instance: &str| {
        set.iter()
            .any(|(w, i)| same_identity(w.as_deref(), i, world, instance))
    };

    for event in events {
        let (world, instance) = match event {
            ConvAttachment::Attached(a) => (
                a.world.as_ref().map(|w| w.0.as_str()),
                a.instance_id.0.as_str(),
            ),
            ConvAttachment::Moved(m) => (
                m.world.as_ref().map(|w| w.0.as_str()),
                m.instance_id.0.as_str(),
            ),
            ConvAttachment::Detached(d) => (
                d.world.as_ref().map(|w| w.0.as_str()),
                d.instance_id.0.as_str(),
            ),
        };
        if is_in(&violators, world, instance) {
            continue;
        }
        match event {
            ConvAttachment::Attached(a) => {
                if is_in(&open, world, instance) {
                    // Second `attached` with no own `detached` between: the
                    // event does not fold, and the identity loses authority
                    // permanently. The standing claim stays exactly what it
                    // was.
                    violators.push((world.map(str::to_string), instance.to_string()));
                    continue;
                }
                open.push((world.map(str::to_string), instance.to_string()));
                standing = Some(Standing {
                    instance_id: a.instance_id.0.clone(),
                    world: a.world.as_ref().map(|w| w.0.clone()),
                    cwd: a.cwd.clone(),
                });
            }
            ConvAttachment::Moved(m) => {
                // The standing-instance gate: a fact about the claim
                // currently held, discarded from anyone else.
                if let Some(s) = standing.as_mut()
                    && same_identity(s.world.as_deref(), &s.instance_id, world, instance)
                {
                    s.cwd = Some(m.cwd.clone());
                }
            }
            ConvAttachment::Detached(_) => {
                // Closes the publisher's own claim regardless of standing —
                // that is what re-legitimises a later re-attach (example d,
                // and the superseded instance's stand-down in example c).
                open.retain(|(w, i)| !same_identity(w.as_deref(), i, world, instance));
                // But it only changes the fold when its identity matches the
                // standing claim's (the gate again).
                if standing.as_ref().is_some_and(|s| {
                    same_identity(s.world.as_deref(), &s.instance_id, world, instance)
                }) {
                    standing = None;
                }
            }
        }
    }
    standing
}

#[derive(Debug, Clone, Copy)]
struct InstancePulse {
    last_seen: Instant,
    /// `None` until a cadence is actually declared — distinct from both
    /// "declared 0" and "definitely alive".
    interval_s: Option<u64>,
}

impl InstancePulse {
    fn silence_threshold(&self) -> Duration {
        match self.interval_s {
            // Only a valid promise is ever stored, so the multiple applies
            // to it as declared.
            Some(i) => Duration::from_secs(i * STRANDED_MULTIPLE),
            None => Duration::from_secs(DEFAULT_SILENCE_S),
        }
    }
}

/// The declared cadence is bounded at both ends (agent.md, Telemetry;
/// conversation.md, Attachment): a value outside it makes the event invalid
/// whole. The bound is validity, not a cap — nothing is clamped, and an
/// event carrying a bad promise is dropped rather than honoured to the
/// limit, because a promise nobody can be held to is not a weaker promise.
fn valid_interval(interval_s: i64) -> Option<u64> {
    (interval_s > 0 && interval_s <= MAX_INTERVAL_S as i64).then_some(interval_s as u64)
}

/// This world's own liveness map, folded from `agent.v1.{world}.telemetry.>`
/// as heard — instance ids are already world-scoped, so keys are bare.
/// Time is data: `since` is when the feed went live, every entry carries
/// the receipt instant the caller passes in, and verdicts are judged
/// against a `now` the caller passes in, so the fold itself never reads a
/// clock.
#[derive(Debug)]
pub struct WorldLiveness {
    /// When the telemetry subscription went live. Stranded is measured
    /// silence, and a map that hasn't listened for a full default threshold
    /// has measured nothing — until then, never-heard reads alive, so a
    /// freshly started instance answers `already_attached` (the sender
    /// retries) instead of displacing a live world-mate off a cold map.
    since: Instant,
    instances: std::collections::HashMap<String, InstancePulse>,
}

impl WorldLiveness {
    pub fn new(since: Instant) -> Self {
        Self {
            since,
            instances: std::collections::HashMap::new(),
        }
    }

    /// `ready` restates presence with no cadence declared.
    pub fn on_ready(&mut self, instance_id: &str, now: Instant) {
        self.observe(instance_id, None, now);
    }

    /// A heartbeat states a cadence: `intervalS` is required, and a missing
    /// or out-of-range one makes the event invalid whole. An invalid pulse
    /// is not a weaker pulse, it is not a pulse — it proves nothing, not
    /// even presence, so it is dropped rather than folded as bare presence.
    pub fn on_pulse(&mut self, instance_id: &str, interval_s: Option<i64>, now: Instant) {
        let Some(interval) = interval_s.and_then(valid_interval) else {
            return;
        };
        self.observe(instance_id, Some(interval), now);
    }

    /// `attached`/`detached` telemetry proves the publisher's presence just
    /// as `ready` does (towerd's fold counts it the same way); an
    /// `attached` carrying `intervalS` also declares the cadence. Carrying
    /// none is lawful (the field is optional there); carrying a bad one is
    /// not, and invalidates the whole event, presence included.
    pub fn on_attached(&mut self, instance_id: &str, interval_s: Option<i64>, now: Instant) {
        let interval = match interval_s {
            None => None,
            Some(i) => match valid_interval(i) {
                Some(v) => Some(v),
                None => return,
            },
        };
        self.observe(instance_id, interval, now);
    }

    /// One observation, from the live feed or a capture seed. `last_seen`
    /// never regresses: the live subscription is made before the seed is
    /// folded (no-gap discipline), so an older replayed frame must never
    /// overwrite a fresher live one.
    fn observe(&mut self, instance_id: &str, interval_s: Option<u64>, at: Instant) {
        let entry = self
            .instances
            .entry(instance_id.to_string())
            .or_insert(InstancePulse {
                last_seen: at,
                interval_s,
            });
        entry.last_seen = entry.last_seen.max(at);
        if interval_s.is_some() {
            entry.interval_s = interval_s;
        }
    }

    /// Alive = heard from within its own silence threshold. Never heard
    /// from reads alive until the map has listened for a full default
    /// threshold (`since`), and not-alive after — only then is the silence
    /// measured rather than merely unobserved.
    pub fn is_alive(&self, instance_id: &str, now: Instant) -> bool {
        match self.instances.get(instance_id) {
            Some(p) => now.duration_since(p.last_seen) < p.silence_threshold(),
            None => now.duration_since(self.since) < Duration::from_secs(DEFAULT_SILENCE_S),
        }
    }
}

/// Which of the four premise cases a `service` request landed in. The three
/// `Proceed` causes dispatch identically (serve: spawn or adopt per
/// history); they are distinguished so a test pins each arm by name.
#[derive(Debug, Clone, PartialEq)]
pub enum ServicePremise {
    /// Standing attachment in this world, holder alive: the goal already
    /// holds, and every instance in the world gives this same answer.
    AlreadyAttached,
    /// Standing attachment in another world: asking a different world to
    /// serve IS migration — the incumbent's liveness is irrelevant.
    TakeOverCrossWorld,
    /// Standing attachment in this world, holder stranded: a dead holder
    /// never blocks pickup — the attachment is never a lease.
    TakeOverStranded,
    /// No standing attachment at all.
    NoAttachment,
}

/// The four cases, exactly (agent.md, "The premise for `service`").
/// A standing claim that names no world can't be placed in this world, so
/// it lands in the cross-world arm — takeover, the landing unconditional
/// supersession makes safe — unless its bare instanceId is this very
/// instance, which places it here.
pub fn service_premise(
    standing: Option<&Standing>,
    own_world: &str,
    own_instance: &str,
    liveness: &WorldLiveness,
    now: Instant,
) -> ServicePremise {
    let Some(s) = standing else {
        return ServicePremise::NoAttachment;
    };
    let in_this_world = match s.world.as_deref() {
        Some(w) => w == own_world,
        None => s.instance_id == own_instance,
    };
    if !in_this_world {
        return ServicePremise::TakeOverCrossWorld;
    }
    // Only ever about a DIFFERENT instance that might hold a stale claim —
    // the answering instance is alive by construction, so its own standing
    // claim is an alive holder's.
    if s.instance_id == own_instance || liveness.is_alive(&s.instance_id, now) {
        ServicePremise::AlreadyAttached
    } else {
        ServicePremise::TakeOverStranded
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wire::{ConvAttached, ConvDetached, ConvMoved, InstanceId, WorldId};

    fn attached(instance: &str, world: Option<&str>) -> ConvAttachment {
        ConvAttachment::Attached(ConvAttached {
            ts: "2026-07-07T21:00:00+10:00".into(),
            instance_id: InstanceId(instance.into()),
            world: world.map(|w| WorldId(w.into())),
            cwd: None,
            tip: None,
            interval_s: None,
        })
    }

    fn moved(instance: &str, world: Option<&str>, cwd: &str) -> ConvAttachment {
        ConvAttachment::Moved(ConvMoved {
            ts: "2026-07-07T21:01:00+10:00".into(),
            instance_id: InstanceId(instance.into()),
            world: world.map(|w| WorldId(w.into())),
            cwd: cwd.into(),
        })
    }

    fn detached(instance: &str, world: Option<&str>) -> ConvAttachment {
        ConvAttachment::Detached(ConvDetached {
            ts: "2026-07-07T21:02:00+10:00".into(),
            instance_id: InstanceId(instance.into()),
            world: world.map(|w| WorldId(w.into())),
        })
    }

    fn standing_of(events: &[ConvAttachment]) -> Option<Standing> {
        fold_attachment(events)
    }

    // --- fold: the spec's examples ---

    #[test]
    fn a_ordinary_life_ends_released() {
        let events = [
            attached("inst-1", Some("mac")),
            detached("inst-1", Some("mac")),
        ];
        assert_eq!(standing_of(&events), None);
    }

    #[test]
    fn b_a_second_instances_attached_supersedes_unconditionally() {
        let events = [
            attached("inst-1", Some("mac")),
            attached("inst-2", Some("mac")),
        ];
        let standing = standing_of(&events).unwrap();
        assert_eq!(standing.instance_id, "inst-2");
    }

    #[test]
    fn c_a_superseded_instances_stale_detached_folds_as_nothing() {
        let events = [
            attached("inst-1", Some("mac")),
            attached("inst-2", Some("pc")),
            detached("inst-1", Some("mac")),
        ];
        let standing = standing_of(&events).unwrap();
        assert_eq!(standing.instance_id, "inst-2");
    }

    #[test]
    fn d_a_closed_claim_leaves_nothing_behind_so_a_re_attach_is_ordinary() {
        let events = [
            attached("inst-1", Some("mac")),
            detached("inst-1", Some("mac")),
            attached("inst-1", Some("mac")),
        ];
        let standing = standing_of(&events).unwrap();
        assert_eq!(standing.instance_id, "inst-1");
    }

    #[test]
    fn e_a_violating_second_attached_does_not_fold() {
        let events = [
            attached("inst-1", Some("mac")),
            attached("inst-1", Some("mac")),
        ];
        // The standing claim stays exactly what the first attached left it.
        let standing = standing_of(&events).unwrap();
        assert_eq!(standing.instance_id, "inst-1");
    }

    #[test]
    fn e_a_violator_cannot_detach_its_way_back() {
        let events = [
            attached("inst-1", Some("mac")),
            attached("inst-1", Some("mac")),
            detached("inst-1", Some("mac")),
        ];
        // The post-violation detached does not fold: the claim stays held.
        let standing = standing_of(&events).unwrap();
        assert_eq!(standing.instance_id, "inst-1");
    }

    #[test]
    fn e_another_instances_attached_still_supersedes_a_violators_held_claim() {
        let events = [
            attached("inst-1", Some("mac")),
            attached("inst-1", Some("mac")),
            attached("inst-2", Some("mac")),
        ];
        let standing = standing_of(&events).unwrap();
        assert_eq!(standing.instance_id, "inst-2");
    }

    #[test]
    fn a_superseded_instance_re_attaching_without_ever_detaching_is_the_violation() {
        // attached(inst-1), attached(inst-2), attached(inst-1) — no
        // detached(inst-1) between its two claims, so the third event is
        // the violation and does not fold.
        let events = [
            attached("inst-1", Some("mac")),
            attached("inst-2", Some("mac")),
            attached("inst-1", Some("mac")),
        ];
        let standing = standing_of(&events).unwrap();
        assert_eq!(standing.instance_id, "inst-2");
    }

    #[test]
    fn moved_folds_onto_the_standing_claim_only_from_its_holder() {
        let events = [
            attached("inst-1", Some("mac")),
            moved("inst-9", Some("mac"), "/elsewhere"),
            moved("inst-1", Some("mac"), "/moved"),
        ];
        let standing = standing_of(&events).unwrap();
        assert_eq!(standing.cwd.as_deref(), Some("/moved"));
    }

    #[test]
    fn a_detached_from_a_different_world_same_instance_id_is_gated_by_the_pair() {
        let events = [
            attached("inst-1", Some("mac")),
            detached("inst-1", Some("pc")),
        ];
        // Both sides carry a world and they differ: not the same identity.
        let standing = standing_of(&events).unwrap();
        assert_eq!(standing.instance_id, "inst-1");
    }

    #[test]
    fn a_worldless_detached_matches_on_bare_instance_id() {
        // Either side omitting world degrades the gate to bare instanceId.
        let events = [attached("inst-1", Some("mac")), detached("inst-1", None)];
        assert_eq!(standing_of(&events), None);
    }

    // --- liveness ---

    /// A map that has already listened for a full default threshold by the
    /// returned base instant: its never-heard verdicts are measured
    /// silence, not a cold start. Built by addition (base after creation),
    /// never by backdating — Instant is monotonic-since-boot, and
    /// subtracting from now underflows on a low-uptime host.
    fn warm_map() -> (WorldLiveness, Instant) {
        let created = Instant::now();
        let base = created + Duration::from_secs(DEFAULT_SILENCE_S + 1);
        (WorldLiveness::new(created), base)
    }

    #[test]
    fn an_instance_within_three_of_its_own_intervals_is_alive() {
        let (mut world, t0) = warm_map();
        world.on_pulse("inst-1", Some(30), t0);
        assert!(world.is_alive("inst-1", t0 + Duration::from_secs(89)));
    }

    #[test]
    fn an_instance_silent_past_three_of_its_own_intervals_is_not_alive() {
        let (mut world, t0) = warm_map();
        world.on_pulse("inst-1", Some(30), t0);
        assert!(!world.is_alive("inst-1", t0 + Duration::from_secs(91)));
    }

    #[test]
    fn no_declared_interval_gets_the_flat_default_threshold_not_a_multiple() {
        let (mut world, t0) = warm_map();
        world.on_ready("inst-1", t0);
        assert!(world.is_alive("inst-1", t0 + Duration::from_secs(59)));
        assert!(!world.is_alive("inst-1", t0 + Duration::from_secs(61)));
    }

    /// Malformed is invalid, and invalid is not a heartbeat: a pulse with a
    /// missing or non-positive `intervalS` never happened, so it proves
    /// nothing — not even the presence a bare `ready` would prove.
    #[test]
    fn a_missing_or_non_positive_interval_makes_the_pulse_invalid_so_it_lands_as_nothing() {
        let (mut world, t0) = warm_map();
        world.on_pulse("inst-1", Some(0), t0);
        world.on_pulse("inst-2", Some(-5), t0);
        world.on_pulse("inst-3", None, t0);
        assert!(!world.is_alive("inst-1", t0));
        assert!(!world.is_alive("inst-2", t0));
        assert!(!world.is_alive("inst-3", t0));
    }

    #[test]
    fn attached_telemetry_proves_presence_and_may_declare_the_cadence() {
        let (mut world, t0) = warm_map();
        world.on_attached("inst-1", Some(10), t0);
        assert!(world.is_alive("inst-1", t0 + Duration::from_secs(29)));
        assert!(!world.is_alive("inst-1", t0 + Duration::from_secs(31)));
        world.on_attached("inst-2", None, t0);
        assert!(world.is_alive("inst-2", t0 + Duration::from_secs(59)));
    }

    /// The bound is validity, not a cap: a day-long promise is not honoured
    /// to MAX_INTERVAL_S, it makes the event invalid whole. Nothing is
    /// clamped and nothing is observed — the instance reads exactly as one
    /// never heard from.
    #[test]
    fn a_declared_interval_above_the_limit_makes_the_event_invalid_not_clamped() {
        let (mut world, t0) = warm_map();
        world.on_pulse("inst-1", Some(86_400), t0);
        assert!(!world.is_alive("inst-1", t0));
        // The same bound on the other event that may declare a cadence.
        world.on_attached("inst-2", Some(MAX_INTERVAL_S as i64 + 1), t0);
        assert!(!world.is_alive("inst-2", t0));
        // The limit itself is lawful.
        world.on_pulse("inst-3", Some(MAX_INTERVAL_S as i64), t0);
        assert!(world.is_alive("inst-3", t0 + Duration::from_secs(MAX_SILENCE_S - 1)));
        assert!(!world.is_alive("inst-3", t0 + Duration::from_secs(MAX_SILENCE_S + 1)));
    }

    /// Seed-after-subscribe safety: an older replayed observation must
    /// never drag a fresher live one backwards.
    #[test]
    fn an_older_observation_never_regresses_last_seen() {
        let (mut world, t0) = warm_map();
        let fresh = t0 + Duration::from_secs(200);
        world.on_pulse("inst-1", Some(30), fresh);
        world.on_pulse("inst-1", Some(30), t0);
        assert!(world.is_alive("inst-1", fresh + Duration::from_secs(89)));
    }

    #[test]
    fn never_heard_from_is_not_alive_once_the_map_is_warm() {
        let (world, base) = warm_map();
        assert!(!world.is_alive("inst-unknown", base));
    }

    /// The cold-start hold: a map that hasn't listened for a full default
    /// threshold has measured no silence, so never-heard reads alive — a
    /// fresh instance must answer `already_attached` rather than displace a
    /// live world-mate it simply hasn't heard yet.
    #[test]
    fn never_heard_from_reads_alive_while_the_map_is_still_cold() {
        let t0 = Instant::now();
        let world = WorldLiveness::new(t0);
        assert!(world.is_alive("inst-unknown", t0 + Duration::from_secs(59)));
        assert!(!world.is_alive("inst-unknown", t0 + Duration::from_secs(61)));
    }

    // --- the four cases ---

    fn stands(instance: &str, world: Option<&str>) -> Standing {
        Standing {
            instance_id: instance.into(),
            world: world.map(str::to_string),
            cwd: None,
        }
    }

    #[test]
    fn no_standing_attachment_is_the_fresh_arm() {
        let (liveness, now) = warm_map();
        let actual = service_premise(None, "mac", "inst-me", &liveness, now);
        assert_eq!(actual, ServicePremise::NoAttachment);
    }

    #[test]
    fn a_standing_attachment_in_another_world_is_taken_over_regardless_of_liveness() {
        let (mut liveness, now) = warm_map();
        // Even a demonstrably live holder: cross-world IS migration.
        liveness.on_pulse("inst-far", Some(30), now);
        let standing = stands("inst-far", Some("pc"));
        let actual = service_premise(Some(&standing), "mac", "inst-me", &liveness, now);
        assert_eq!(actual, ServicePremise::TakeOverCrossWorld);
    }

    #[test]
    fn a_live_holder_in_this_world_means_already_attached() {
        let (mut liveness, now) = warm_map();
        liveness.on_pulse("inst-mate", Some(30), now);
        let standing = stands("inst-mate", Some("mac"));
        let actual = service_premise(Some(&standing), "mac", "inst-me", &liveness, now);
        assert_eq!(actual, ServicePremise::AlreadyAttached);
    }

    #[test]
    fn our_own_standing_claim_is_already_attached_without_consulting_pulses() {
        // A cold map: our own claim never consults the fold at all.
        let liveness = WorldLiveness::new(Instant::now());
        let standing = stands("inst-me", Some("mac"));
        let actual = service_premise(Some(&standing), "mac", "inst-me", &liveness, Instant::now());
        assert_eq!(actual, ServicePremise::AlreadyAttached);
    }

    #[test]
    fn a_stranded_holder_in_this_world_is_taken_over() {
        let (mut liveness, t0) = warm_map();
        liveness.on_pulse("inst-mate", Some(10), t0);
        let standing = stands("inst-mate", Some("mac"));
        let later = t0 + Duration::from_secs(31);
        let actual = service_premise(Some(&standing), "mac", "inst-me", &liveness, later);
        assert_eq!(actual, ServicePremise::TakeOverStranded);
    }

    #[test]
    fn a_worldless_standing_claim_lands_in_the_cross_world_arm() {
        let (liveness, now) = warm_map();
        let standing = stands("inst-old", None);
        let actual = service_premise(Some(&standing), "mac", "inst-me", &liveness, now);
        assert_eq!(actual, ServicePremise::TakeOverCrossWorld);
    }
}
