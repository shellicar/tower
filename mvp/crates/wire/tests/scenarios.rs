//! The conformance fixtures (docs/spec/fixtures/*.jsonl, narrated by
//! scenarios.md) through the wire folds — read from the files themselves:
//! this repo is the fixtures' source of truth, and these tests consume the
//! same bytes implementations copy. Tower is a consumer: the event-subject
//! lines must all parse as Known — request lines never reach ingest (streams
//! capture event subjects only). Fix lands twice: a change here means the
//! fixture file changes in the same commit, or the code does.

macro_rules! fixture {
    ($name:literal) => {
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../docs/spec/fixtures/",
            $name
        ))
    };
}

use wire::{
    ApprovalKind, ApprovalLifecycle, ConvChange, ConvTelemetry, Event, EventKind, WireEvent,
    parse_ts, parse_wire,
};

/// One fixture line: `{"subject":…,"message":{…}}` (reply keys ignored —
/// request lines are filtered out before parsing).
fn parse_line(line: &str) -> Option<WireEvent> {
    let v: serde_json::Value = serde_json::from_str(line).unwrap();
    let subject = v["subject"].as_str().unwrap();
    if subject.ends_with(".requests") {
        return None; // not stream traffic; tower never sees it
    }
    let payload = serde_json::to_vec(&v["message"]).unwrap();
    parse_wire(subject, &payload)
}

fn events(fixture: &str) -> Vec<Event> {
    fixture
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(parse_line)
        .map(|w| match w {
            WireEvent::Conv(e) => e,
            other => panic!("conversation fixture produced {other:?}"),
        })
        .collect()
}

const SCENARIO_1: &str = fixture!("scenario-1.jsonl");
const SCENARIO_2: &str = fixture!("scenario-2.jsonl");
const SCENARIO_3: &str = fixture!("scenario-3.jsonl");
const SCENARIO_4: &str = fixture!("scenario-4.jsonl");
const SCENARIO_6A: &str = fixture!("scenario-6a.jsonl");
const SCENARIO_6B: &str = fixture!("scenario-6b.jsonl");
const SCENARIO_7: &str = fixture!("scenario-7.jsonl");

fn approval_events(fixture: &str) -> Vec<wire::ApprovalEvent> {
    fixture
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(parse_line)
        .map(|w| match w {
            WireEvent::Approval(e) => e,
            other => panic!("approval fixture produced {other:?}"),
        })
        .collect()
}

fn assert_all_known(events: &[Event]) {
    for e in events {
        assert!(
            !matches!(e.kind, EventKind::Unknown { .. }),
            "fixture line parsed as Unknown: {e:?}"
        );
    }
}

#[test]
fn scenario_1_all_event_lines_parse_known() {
    let evs = events(SCENARIO_1);
    assert_eq!(evs.len(), 12); // 13 lines minus the request line
    assert_all_known(&evs);

    let messages: Vec<_> = evs
        .iter()
        .filter_map(|e| match &e.kind {
            EventKind::Change(ConvChange::Message { id, .. }) => Some(id.0.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(messages, ["m1", "m2", "m3", "m4"]);

    // Every fixture ts normalises.
    for e in &evs {
        if let EventKind::Telemetry(t) = &e.kind {
            assert!(parse_ts(t.ts()).is_some());
        }
        if let EventKind::Change(c) = &e.kind {
            assert!(parse_ts(c.ts()).is_some());
        }
    }
}

#[test]
fn scenario_2_cancelled_turn_commits_nothing() {
    let evs = events(SCENARIO_2);
    assert_all_known(&evs);
    // Full telemetry trail, zero commits — the telemetry/commit gap is honest.
    assert!(evs.iter().any(|e| matches!(
        &e.kind,
        EventKind::Telemetry(ConvTelemetry::TurnCancelled { .. })
    )));
    assert!(!evs.iter().any(|e| matches!(&e.kind, EventKind::Change(_))));
}

#[test]
fn scenario_3_tip_movements_parse() {
    let evs = events(SCENARIO_3);
    assert_all_known(&evs);
    let tips: Vec<_> = evs
        .iter()
        .filter_map(|e| match &e.kind {
            EventKind::Change(ConvChange::TipMoved { to, .. }) => Some(to.0.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(tips, ["m1", "m4"]);
}

#[test]
fn scenario_6a_approval_answered() {
    let evs = approval_events(SCENARIO_6A);
    assert_eq!(evs.len(), 3); // raised + heartbeat + settled; requests filtered
    assert!(evs.iter().all(|e| e.id.0 == "apr-1"));
    assert!(matches!(
        &evs[0].kind,
        ApprovalKind::Lifecycle(ApprovalLifecycle::Raised { .. })
    ));
    assert!(matches!(&evs[1].kind, ApprovalKind::Heartbeat { .. }));
    let ApprovalKind::Lifecycle(ApprovalLifecycle::Settled { approved, by, .. }) = &evs[2].kind
    else {
        panic!("expected settled");
    };
    assert!(approved);
    assert_eq!(by["userId"], "stephen");
}

#[test]
fn scenario_6b_holder_died() {
    // Raised + one pulse, then silence — nothing settles; the void reading
    // is the consumer's (pulse silence), not an event.
    let evs = approval_events(SCENARIO_6B);
    assert_eq!(evs.len(), 2);
    assert!(matches!(
        &evs[0].kind,
        ApprovalKind::Lifecycle(ApprovalLifecycle::Raised { .. })
    ));
    assert!(matches!(&evs[1].kind, ApprovalKind::Heartbeat { .. }));
}

#[test]
fn scenario_7_block_stream_reconstructs_the_turn() {
    // The deltas subject carries one ordered stream; `block` markers say what
    // it is currently emitting. Folding it reconstructs thinking → text →
    // tool_use, and the committed message supersedes with the same order.
    let evs = events(SCENARIO_7);
    assert_all_known(&evs);

    let mut phases: Vec<String> = Vec::new();
    let mut texts: Vec<(String, String)> = Vec::new(); // (phase, accumulated)
    for e in &evs {
        match &e.kind {
            EventKind::Block(b) => phases.push(b.block_type.clone()),
            EventKind::Delta(d) => {
                let phase = phases.last().cloned().unwrap_or_else(|| "text".into());
                match texts.last_mut() {
                    Some((p, acc)) if *p == phase => acc.push_str(&d.text),
                    _ => texts.push((phase, d.text.clone())),
                }
            }
            _ => {}
        }
    }
    assert_eq!(phases, ["thinking", "text", "tool_use"]);
    assert_eq!(
        texts[0].1,
        "The file has to go — checking what references it first."
    );
    assert_eq!(
        texts[1].1,
        "Deleting the old module — nothing imports it any more."
    );
    assert_eq!(texts[2].1, r#"{"files": ["./old.ts"]}"#);

    // The committed message carries the same blocks, same order.
    let committed = evs
        .iter()
        .find_map(|e| match &e.kind {
            EventKind::Change(ConvChange::Message { content, .. }) => Some(content),
            _ => None,
        })
        .expect("the commit closes the stream");
    let block_types: Vec<&str> = committed
        .iter()
        .map(|b| b["type"].as_str().unwrap())
        .collect();
    assert_eq!(block_types, ["thinking", "text", "tool_use"]);
}

#[test]
fn scenario_4_revisions_parse() {
    let evs = events(SCENARIO_4);
    assert_all_known(&evs);
    let revised: Vec<_> = evs
        .iter()
        .filter_map(|e| match &e.kind {
            EventKind::Change(ConvChange::Revision { message_id, .. }) => {
                Some(message_id.0.as_str())
            }
            _ => None,
        })
        .collect();
    assert_eq!(revised, ["m2", "m3"]);
}
