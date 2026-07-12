//! The conformance fixtures (docs/spec/scenarios.md) through the wire folds.
//! Tower is a consumer: the event-subject lines (telemetry, changes, deltas)
//! must all parse as Known — request lines never reach ingest (streams
//! capture event subjects only). Fix lands twice: a change here means the
//! fixture in scenarios.md changes in the same commit, or the code does.

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

// Scenario 1 — the plain exchange (verbatim from scenarios.md).
const SCENARIO_1: &str = r#"
{"subject":"conv.v1.conv-abc.requests","message":{"type":"say","ts":"2026-07-07T21:00:00+10:00","from":{"kind":"human","userId":"stephen"},"text":"read file X and summarise it","precondition":{"tip":null}},"reply":{"accepted":true,"id":"q1"}}
{"subject":"conv.v1.conv-abc.changes","message":{"type":"message","ts":"2026-07-07T21:00:00+10:00","id":"m1","queryId":"q1","turnId":"t1","role":"user","from":{"kind":"human","userId":"stephen"},"content":[{"type":"text","text":"read file X and summarise it"}]}}
{"subject":"conv.v1.conv-abc.telemetry","message":{"type":"turn_started","ts":"2026-07-07T21:00:00+10:00","queryId":"q1","turnId":"t1","service":"anthropic.messages","model":"claude-sonnet-4-5","thinking":false,"maxTokens":8192}}
{"subject":"conv.v1.conv-abc.telemetry","message":{"type":"tool_use","ts":"2026-07-07T21:00:00+10:00","queryId":"q1","turnId":"t1","id":"toolu_01ABC","name":"ReadFile","input":{"path":"X"}}}
{"subject":"conv.v1.conv-abc.telemetry","message":{"type":"turn_ended","ts":"2026-07-07T21:00:00+10:00","queryId":"q1","turnId":"t1","stopReason":"tool_use"}}
{"subject":"conv.v1.conv-abc.telemetry","message":{"type":"usage","ts":"2026-07-07T21:00:00+10:00","queryId":"q1","turnId":"t1","service":"anthropic.messages","model":"claude-sonnet-4-5","inputTokens":1200,"cacheCreationTokens":0,"cacheReadTokens":0,"outputTokens":80,"costUsd":0.005}}
{"subject":"conv.v1.conv-abc.changes","message":{"type":"message","ts":"2026-07-07T21:00:00+10:00","id":"m2","queryId":"q1","turnId":"t1","role":"assistant","from":{"kind":"agent"},"content":[{"type":"tool_use","id":"toolu_01ABC","name":"ReadFile","input":{"path":"X"}}]}}
{"subject":"conv.v1.conv-abc.changes","message":{"type":"message","ts":"2026-07-07T21:00:00+10:00","id":"m3","queryId":"q1","turnId":"t2","role":"user","from":{"kind":"agent"},"content":[{"type":"tool_result","tool_use_id":"toolu_01ABC","content":"…file contents…"}]}}
{"subject":"conv.v1.conv-abc.telemetry","message":{"type":"turn_started","ts":"2026-07-07T21:00:00+10:00","queryId":"q1","turnId":"t2","service":"anthropic.messages","model":"claude-sonnet-4-5","thinking":false,"maxTokens":8192}}
{"subject":"conv.v1.conv-abc.deltas","message":{"type":"delta","text":"File X contains"}}
{"subject":"conv.v1.conv-abc.telemetry","message":{"type":"turn_ended","ts":"2026-07-07T21:00:00+10:00","queryId":"q1","turnId":"t2","stopReason":"end_turn"}}
{"subject":"conv.v1.conv-abc.telemetry","message":{"type":"usage","ts":"2026-07-07T21:00:00+10:00","queryId":"q1","turnId":"t2","service":"anthropic.messages","model":"claude-sonnet-4-5","inputTokens":1400,"cacheCreationTokens":0,"cacheReadTokens":1200,"outputTokens":150,"costUsd":0.006}}
{"subject":"conv.v1.conv-abc.changes","message":{"type":"message","ts":"2026-07-07T21:00:00+10:00","id":"m4","queryId":"q1","turnId":"t2","role":"assistant","from":{"kind":"agent"},"content":[{"type":"text","text":"File X contains a summary of…"}]}}
"#;

// Scenario 2 — cancel mid-turn (event lines only relevant here).
const SCENARIO_2: &str = r#"
{"subject":"conv.v1.conv-abc.telemetry","message":{"type":"turn_started","ts":"2026-07-07T21:00:00+10:00","queryId":"q2","turnId":"t3","service":"anthropic.messages","model":"claude-sonnet-4-5","thinking":false,"maxTokens":8192}}
{"subject":"conv.v1.conv-abc.deltas","message":{"type":"delta","text":"Deleting"}}
{"subject":"conv.v1.conv-abc.telemetry","message":{"type":"turn_cancelled","ts":"2026-07-07T21:00:00+10:00","queryId":"q2","turnId":"t3"}}
"#;

// Scenario 3 — edit and rewind.
const SCENARIO_3: &str = r#"
{"subject":"conv.v1.conv-abc.changes","message":{"type":"tip_moved","ts":"2026-07-07T21:00:00+10:00","to":"m1"}}
{"subject":"conv.v1.conv-abc.changes","message":{"type":"message","ts":"2026-07-07T21:00:00+10:00","id":"m5","queryId":"q2","turnId":"t4","role":"user","from":{"kind":"human","userId":"stephen"},"content":[{"type":"text","text":"read file Y and summarise it"}]}}
{"subject":"conv.v1.conv-abc.changes","message":{"type":"message","ts":"2026-07-07T21:00:00+10:00","id":"m6","queryId":"q2","turnId":"t4","role":"assistant","from":{"kind":"agent"},"content":[{"type":"text","text":"File Y contains…"}]}}
{"subject":"conv.v1.conv-abc.changes","message":{"type":"tip_moved","ts":"2026-07-07T21:00:00+10:00","to":"m4"}}
"#;

// Scenario 4 — revision.
const SCENARIO_4: &str = r#"
{"subject":"conv.v1.conv-abc.changes","message":{"type":"revision","ts":"2026-07-07T21:00:00+10:00","messageId":"m2","content":[{"type":"tool_use","id":"toolu_01ABC","name":"ReadFile","input":{"path":"X"}}]}}
{"subject":"conv.v1.conv-abc.changes","message":{"type":"revision","ts":"2026-07-07T21:00:00+10:00","messageId":"m3","content":[{"type":"tool_result","tool_use_id":"toolu_01ABC","content":"…trimmed…"}]}}
"#;

// Scenario 6 — approval, both endings (verbatim from scenarios.md).
const SCENARIO_6A: &str = r#"
{"subject":"approval.v1.apr-1.lifecycle","message":{"type":"raised","ts":"2026-07-07T21:00:00+10:00","ask":{"type":"tool_use","name":"DeleteFile","input":{"content":{"type":"files","values":["./old.ts"]}}},"correlation":{"conversationId":"conv-abc","queryId":"q2","turnId":"t3","toolUseId":"toolu_02DEF"}}}
{"subject":"approval.v1.apr-1.telemetry","message":{"type":"heartbeat","ts":"2026-07-07T21:00:00+10:00"}}
{"subject":"approval.v1.apr-1.requests","message":{"type":"answer","ts":"2026-07-07T21:00:00+10:00","from":{"kind":"human","userId":"stephen"},"approved":true},"reply":{"accepted":true}}
{"subject":"approval.v1.apr-1.requests","message":{"type":"answer","ts":"2026-07-07T21:00:00+10:00","from":{"kind":"agent"},"approved":false},"reply":{"rejected":true,"reason":"already_settled"}}
{"subject":"approval.v1.apr-1.lifecycle","message":{"type":"settled","ts":"2026-07-07T21:00:00+10:00","approved":true,"by":{"kind":"human","userId":"stephen"}}}
"#;

const SCENARIO_6B: &str = r#"
{"subject":"approval.v1.apr-2.lifecycle","message":{"type":"raised","ts":"2026-07-07T21:00:00+10:00","ask":{"type":"tool_use","name":"DeleteFile","input":{"content":{"type":"files","values":["./other.ts"]}}},"correlation":{"conversationId":"conv-abc","queryId":"q3","turnId":"t5","toolUseId":"toolu_03GHI"}}}
{"subject":"approval.v1.apr-2.telemetry","message":{"type":"heartbeat","ts":"2026-07-07T21:00:00+10:00"}}
"#;

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
