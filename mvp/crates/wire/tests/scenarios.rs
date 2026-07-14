//! The conformance fixtures (docs/spec/fixtures/**, narrated by scenarios.md)
//! through the wire folds — read from the files themselves: this repo is the
//! fixtures' source of truth, and these tests consume the same bytes
//! implementations copy. Tower is a consumer: the event-subject lines must all
//! parse as Known — request lines never reach ingest (streams capture event
//! subjects only). Fix lands twice: a change here means the fixture file
//! changes in the same commit, or the code does.
//!
//! Conversation scenarios read the v2 tree (`fixtures/v2/`); the agent
//! scenarios read `fixtures/agent/`; approval stays v1 at the fixtures root.

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
    AgentEvent, AgentKind, AgentTelemetry, ApprovalEvent, ApprovalKind, ApprovalLifecycle,
    ConvChange, Event, EventKind, WireEvent, parse_ts, parse_wire,
};

/// One fixture line: `{"subject":…,"message":{…}}` (reply keys ignored —
/// request lines are filtered out before parsing). A request is any subject
/// whose class token (4th) is `requests` — flat (`approval.v1.id.requests`) or
/// leafed (`conv.v2.id.requests.say`).
fn parse_line(line: &str) -> Option<WireEvent> {
    let v: serde_json::Value = serde_json::from_str(line).unwrap();
    let subject = v["subject"].as_str().unwrap();
    if subject.split('.').nth(3) == Some("requests") {
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

fn approval_events(fixture: &str) -> Vec<ApprovalEvent> {
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

fn agent_events(fixture: &str) -> Vec<AgentEvent> {
    fixture
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(parse_line)
        .map(|w| match w {
            WireEvent::Agent(e) => e,
            other => panic!("agent fixture produced {other:?}"),
        })
        .collect()
}

const SCENARIO_1: &str = fixture!("v2/scenario-1.jsonl");
const SCENARIO_2: &str = fixture!("v2/scenario-2.jsonl");
const SCENARIO_2B: &str = fixture!("v2/scenario-2b.jsonl");
const SCENARIO_3: &str = fixture!("v2/scenario-3.jsonl");
const SCENARIO_4: &str = fixture!("v2/scenario-4.jsonl");
const SCENARIO_5: &str = fixture!("v2/scenario-5.jsonl");
const SCENARIO_7: &str = fixture!("v2/scenario-7.jsonl");
const SCENARIO_6A: &str = fixture!("scenario-6a.jsonl");
const SCENARIO_6B: &str = fixture!("scenario-6b.jsonl");
const AGENT_A1: &str = fixture!("agent/scenario-a1.jsonl");
const AGENT_A2: &str = fixture!("agent/scenario-a2.jsonl");
const AGENT_A3: &str = fixture!("agent/scenario-a3.jsonl");
const AGENT_A4: &str = fixture!("agent/scenario-a4.jsonl");
const AGENT_A5: &str = fixture!("agent/scenario-a5.jsonl");

fn assert_all_known(events: &[Event]) {
    for e in events {
        assert!(
            !matches!(e.kind, EventKind::Unknown { .. }),
            "fixture line parsed as Unknown: {e:?}"
        );
    }
}

fn assert_all_agent_known(events: &[AgentEvent]) {
    for e in events {
        assert!(
            !matches!(e.kind, AgentKind::Unknown { .. }),
            "agent fixture line parsed as Unknown: {e:?}"
        );
    }
}

#[test]
fn scenario_1_all_event_lines_parse_known_and_the_query_closes() {
    let evs = events(SCENARIO_1);
    assert_all_known(&evs);

    let messages: Vec<_> = evs
        .iter()
        .filter_map(|e| match &e.kind {
            EventKind::Change(ConvChange::Message(m)) => Some(m.id.0.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(messages, ["m1", "m2", "m3", "m4"]);

    // The committal end of the query — a `query` change, reason completed.
    assert!(evs.iter().any(|e| matches!(
        &e.kind,
        EventKind::Change(ConvChange::Query(q)) if q.reason == "completed"
    )));

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
fn scenario_2_cancelled_turn_commits_no_message_and_the_query_closes_cancelled() {
    let evs = events(SCENARIO_2);
    assert_all_known(&evs);
    // Full telemetry trail, no message commit — the telemetry/commit gap is honest.
    assert!(evs.iter().any(|e| matches!(
        &e.kind,
        EventKind::Telemetry(wire::ConvTelemetry::TurnCancelled(_))
    )));
    assert!(
        !evs.iter()
            .any(|e| matches!(&e.kind, EventKind::Change(ConvChange::Message(_))))
    );
    // The query still closed — committally, reason cancelled.
    assert!(evs.iter().any(|e| matches!(
        &e.kind,
        EventKind::Change(ConvChange::Query(q)) if q.reason == "cancelled"
    )));
}

#[test]
fn scenario_2b_cancel_after_completion() {
    let evs = events(SCENARIO_2B);
    assert_all_known(&evs);
    assert!(evs.iter().any(|e| matches!(
        &e.kind,
        EventKind::Telemetry(wire::ConvTelemetry::TurnEnded(_))
    )));
    assert!(evs.iter().any(|e| matches!(
        &e.kind,
        EventKind::Change(ConvChange::Message(m)) if m.role == "assistant"
    )));
    assert!(!evs.iter().any(|e| matches!(
        &e.kind,
        EventKind::Telemetry(wire::ConvTelemetry::TurnCancelled(_))
    )));
}

#[test]
fn scenario_3_tip_movements_parse() {
    let evs = events(SCENARIO_3);
    assert_all_known(&evs);
    let tips: Vec<_> = evs
        .iter()
        .filter_map(|e| match &e.kind {
            EventKind::Change(ConvChange::TipMoved(t)) => Some(t.to.0.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(tips, ["m1", "m4"]);
}

#[test]
fn scenario_4_revisions_parse() {
    let evs = events(SCENARIO_4);
    assert_all_known(&evs);
    let revised: Vec<_> = evs
        .iter()
        .filter_map(|e| match &e.kind {
            EventKind::Change(ConvChange::Revision(r)) => Some(r.message_id.0.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(revised, ["m2", "m3"]);
}

#[test]
fn scenario_5_stale_premise_second_say_is_filtered() {
    // Both `say` lines are requests (filtered); the one committed message is
    // the accepted query's. The stale rejection lives in the reply, off-stream.
    let evs = events(SCENARIO_5);
    assert_all_known(&evs);
    let messages: Vec<_> = evs
        .iter()
        .filter_map(|e| match &e.kind {
            EventKind::Change(ConvChange::Message(m)) => Some(m.id.0.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(messages, ["m5"]);
}

#[test]
fn scenario_7_block_stream_reconstructs_the_turn() {
    let evs = events(SCENARIO_7);
    assert_all_known(&evs);

    let mut phases: Vec<String> = Vec::new();
    let mut texts: Vec<(String, String)> = Vec::new();
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

    let committed = evs
        .iter()
        .find_map(|e| match &e.kind {
            EventKind::Change(ConvChange::Message(m)) => Some(&m.content),
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
    let evs = approval_events(SCENARIO_6B);
    assert_eq!(evs.len(), 2);
    assert!(matches!(
        &evs[0].kind,
        ApprovalKind::Lifecycle(ApprovalLifecycle::Raised { .. })
    ));
    assert!(matches!(&evs[1].kind, ApprovalKind::Heartbeat { .. }));
}

#[test]
fn agent_a1_world_up_fresh_conversation() {
    let evs = agent_events(AGENT_A1);
    assert_all_agent_known(&evs);
    // ready, pulse, attached — and the attached carries the conversation before
    // any message exists.
    assert!(
        evs.iter()
            .any(|e| matches!(&e.kind, AgentKind::Telemetry(AgentTelemetry::Ready(_))))
    );
    assert!(evs.iter().any(|e| matches!(
        &e.kind,
        AgentKind::Telemetry(AgentTelemetry::Attached(a)) if a.conversation_id.0 == "conv-abc"
    )));
}

#[test]
fn agent_a2_clean_shutdown_detaches() {
    let evs = agent_events(AGENT_A2);
    assert_all_agent_known(&evs);
    assert!(
        evs.iter()
            .any(|e| matches!(&e.kind, AgentKind::Telemetry(AgentTelemetry::Detached(_))))
    );
}

#[test]
fn agent_a3_stranded_is_attached_then_silence() {
    // Attached + two pulses, then nothing — stranded is the consumer's fold
    // (pulse silence), never an event. Here we only assert the lines parse.
    let evs = agent_events(AGENT_A3);
    assert_all_agent_known(&evs);
    assert!(
        evs.iter()
            .any(|e| matches!(&e.kind, AgentKind::Telemetry(AgentTelemetry::Pulse(_))))
    );
}

#[test]
fn agent_a4_chdir_republishes_attached_with_new_cwd() {
    // The chdir line is a request (filtered); its consequence is the second
    // `attached` carrying the new cwd, last-write-wins.
    let evs = agent_events(AGENT_A4);
    assert_all_agent_known(&evs);
    let cwds: Vec<_> = evs
        .iter()
        .filter_map(|e| match &e.kind {
            AgentKind::Telemetry(AgentTelemetry::Attached(a)) => a.cwd.as_deref(),
            _ => None,
        })
        .collect();
    assert_eq!(cwds, ["~/repos/tower", "~/repos/tower-wip"]);
}

#[test]
fn agent_a5_resume_then_already_attached() {
    // Both `service` lines are requests (filtered); one `attached` event remains.
    let evs = agent_events(AGENT_A5);
    assert_all_agent_known(&evs);
    assert_eq!(
        evs.iter()
            .filter(|e| matches!(&e.kind, AgentKind::Telemetry(AgentTelemetry::Attached(_))))
            .count(),
        1
    );
}
