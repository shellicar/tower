use rusqlite::OptionalExtension;

use super::*;
use wire::{ApprovalId, ConversationId, InstanceId, WorldId, parse_ts, parse_wire};

fn fresh() -> (Views, tokio::sync::broadcast::Receiver<ViewEvent>) {
    let db = rusqlite::Connection::open_in_memory().unwrap();
    apply_schema(&db).unwrap();
    let (tx, rx) = tokio::sync::broadcast::channel(64);
    let (queries_tx, _queries_rx) = tokio::sync::mpsc::channel(64);
    let runtime =
        tokio::runtime::Handle::try_current().unwrap_or_else(|_| RT.with(|rt| rt.handle().clone()));
    (Views::new(db, tx, queries_tx, runtime), rx)
}

thread_local! {
    /// Tests run under `#[test]` (no tokio runtime) rather than
    /// `#[tokio::test]`, since almost none of them are async — `Views::new`
    /// still needs a runtime handle to hand to the unread-timer plumbing, so
    /// each thread lazily starts one just to have a handle, never entered.
    static RT: tokio::runtime::Runtime = tokio::runtime::Runtime::new().unwrap();
}

fn event(subject: &str, payload: &str) -> WireEvent {
    parse_wire(subject, payload.as_bytes()).unwrap()
}

/// The rows half of list(); most tests don't care about tag keys.
fn rows_of(views: &Views) -> Vec<RowState> {
    views.list().unwrap().0
}

const MSG_M1: &str = r#"{"ts":"2026-07-07T21:00:00+10:00","id":"m1","queryId":"q1","turnId":"t1","role":"user","from":{"kind":"human","userId":"stephen"},"content":[{"type":"text","text":"read file X and summarise it"}]}"#;

#[test]
fn message_lands_in_views_and_row() {
    let (mut views, mut rx) = fresh();
    views.apply(
        "conv-approval",
        1,
        &event("conv.v2.conv-abc.changes.message", MSG_M1),
    );

    let rows = rows_of(&views);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].conv.0, "conv-abc");
    assert_eq!(rows[0].last_kind, "message");

    let msgs = views
        .conversation(&ConversationId("conv-abc".into()), None)
        .unwrap();
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0].id.0, "m1");
    assert_eq!(msgs[0].from.as_ref().unwrap()["userId"], "stephen");

    assert!(matches!(rx.try_recv().unwrap(), ViewEvent::Row(_)));
    assert!(matches!(rx.try_recv().unwrap(), ViewEvent::Message { .. }));
    assert_eq!(read_cursor(&views.db, "conv-approval").unwrap(), 1);
}

#[test]
fn replay_is_idempotent() {
    let (mut views, _rx) = fresh();
    views.apply(
        "conv-approval",
        1,
        &event("conv.v2.conv-abc.changes.message", MSG_M1),
    );
    views.apply(
        "conv-approval",
        1,
        &event("conv.v2.conv-abc.changes.message", MSG_M1),
    ); // at-least-once
    let msgs = views
        .conversation(&ConversationId("conv-abc".into()), None)
        .unwrap();
    assert_eq!(msgs.len(), 1);
}

#[test]
fn revision_rewrites_content_in_place() {
    let (mut views, _rx) = fresh();
    views.apply(
        "conv-approval",
        1,
        &event("conv.v2.conv-abc.changes.message", MSG_M1),
    );
    views.apply("conv-approval", 2, &event("conv.v2.conv-abc.changes.revision",
        r#"{"ts":"2026-07-07T21:01:00+10:00","messageId":"m1","content":[{"type":"text","text":"…trimmed…"}]}"#));
    let msgs = views
        .conversation(&ConversationId("conv-abc".into()), None)
        .unwrap();
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0].content[0]["text"], "…trimmed…");
}

#[test]
fn telemetry_touches_row_without_storing() {
    let (mut views, _rx) = fresh();
    views.apply("conv-approval", 1, &event("conv.v2.conv-abc.telemetry.turn.started",
        r#"{"ts":"2026-07-07T21:00:00+10:00","queryId":"q1","turnId":"t1","service":"anthropic.messages","model":"claude-sonnet-4-5","thinking":false,"maxTokens":8192}"#));
    let rows = rows_of(&views);
    assert_eq!(rows[0].last_kind, "turn_started");
    assert!(
        views
            .conversation(&ConversationId("conv-abc".into()), None)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn usage_fold_accumulates_and_snapshots() {
    let (mut views, mut rx) = fresh();
    let conv = ConversationId("conv-abc".into());
    // No usage yet: the snapshot is absent, and absent means zero.
    assert!(views.usage(&conv).unwrap().is_none());

    views.apply("conv-approval", 1, &event("conv.v2.conv-abc.telemetry.turn.started",
        r#"{"ts":"2026-07-07T20:59:59+10:00","queryId":"q1","turnId":"t1","service":"anthropic.messages","model":"claude-sonnet-4-5","thinking":false,"maxTokens":8192}"#));
    views.apply("conv-approval", 2, &event("conv.v2.conv-abc.telemetry.usage",
        r#"{"ts":"2026-07-07T21:00:00+10:00","queryId":"q1","turnId":"t1","service":"anthropic.messages","model":"claude-sonnet-4-5","inputTokens":100,"cacheCreationTokens":20,"cacheCreation5mTokens":3,"cacheCreation1hTokens":17,"cacheReadTokens":5,"outputTokens":40}"#));
    views.apply("conv-approval", 3, &event("conv.v2.conv-abc.telemetry.turn.started",
        r#"{"ts":"2026-07-07T21:00:59+10:00","queryId":"q2","turnId":"t2","service":"anthropic.messages","model":"claude-opus-4-6","thinking":false,"maxTokens":8192}"#));
    // The second frame omits the split (an older producer) — it must not
    // regress the running totals: absent reads as 0, so they hold.
    views.apply("conv-approval", 4, &event("conv.v2.conv-abc.telemetry.usage",
        r#"{"ts":"2026-07-07T21:01:00+10:00","queryId":"q2","turnId":"t2","service":"anthropic.messages","model":"claude-opus-4-6","inputTokens":200,"cacheCreationTokens":0,"cacheReadTokens":300,"outputTokens":10}"#));

    let u = views.usage(&conv).unwrap().unwrap();
    // The four token counts are cumulative over the conversation.
    assert_eq!(u.input_tokens, 300);
    assert_eq!(u.cache_creation_tokens, 20);
    // The 5m/1h split accumulates alongside the total.
    assert_eq!(u.cache_creation_5m_tokens, 3);
    assert_eq!(u.cache_creation_1h_tokens, 17);
    assert_eq!(u.cache_read_tokens, 305);
    assert_eq!(u.output_tokens, 50);
    // turns counts turn_started events, not usage frames — two turns
    // started, so two, regardless of how many usage frames each emitted.
    assert_eq!(u.turns, 2);
    // Context and model are the LATEST turn's, not sums: context is that
    // turn's whole prompt (input + cacheCreation + cacheRead) — named
    // here, not left as literals, so each addend is traceable back to
    // its field in the second event above.
    let (latest_input, latest_cache_creation, latest_cache_read) = (200, 0, 300);
    assert_eq!(
        u.context_tokens,
        latest_input + latest_cache_creation + latest_cache_read
    );
    assert_eq!(u.model, "claude-opus-4-6");

    // Each turn_started/usage event broadcasts one Usage snapshot (content)
    // alongside the row touch (staleness).
    let mut usage_broadcasts = 0;
    while let Ok(ev) = rx.try_recv() {
        if let ViewEvent::Usage(_) = ev {
            usage_broadcasts += 1;
        }
    }
    assert_eq!(usage_broadcasts, 4);
}

#[test]
fn an_output_only_usage_frame_never_clobbers_context_to_zero() {
    // Some producers (claude-sdk-cli) report a turn's usage as TWO frames:
    // a context frame (input + cache, the real snapshot) and an output-only
    // frame that carries just outputTokens, with input/cache all zero. The
    // second frame arriving after the first must not erase the real context.
    let (mut views, _rx) = fresh();
    let conv = ConversationId("conv-abc".into());

    views.apply("conv-approval", 1, &event("conv.v2.conv-abc.telemetry.usage",
        r#"{"ts":"2026-07-07T21:00:00+10:00","queryId":"q1","turnId":"t1","service":"anthropic.messages","model":"claude-sonnet-5","inputTokens":50,"cacheCreationTokens":0,"cacheReadTokens":630000,"outputTokens":0}"#));
    let u = views.usage(&conv).unwrap().unwrap();
    assert_eq!(u.context_tokens, 630050);

    // The output-only frame: real output, zero everywhere else.
    views.apply("conv-approval", 2, &event("conv.v2.conv-abc.telemetry.usage",
        r#"{"ts":"2026-07-07T21:00:05+10:00","queryId":"q1","turnId":"t1","service":"anthropic.messages","model":"claude-sonnet-5","inputTokens":0,"cacheCreationTokens":0,"cacheReadTokens":0,"outputTokens":420}"#));
    let u = views.usage(&conv).unwrap().unwrap();
    // Context holds at the last real snapshot; output still accumulates.
    assert_eq!(u.context_tokens, 630050);
    assert_eq!(u.output_tokens, 420);
}

#[test]
fn turns_counts_turn_started_never_usage_frames() {
    // The exact bug: a producer that reports one turn as two usage frames
    // (a context frame, then a separate output-only frame) must not double
    // the turn count. turn_started is the only thing that increments turns.
    let (mut views, _rx) = fresh();
    let conv = ConversationId("conv-abc".into());

    views.apply("conv-approval", 1, &event("conv.v2.conv-abc.telemetry.turn.started",
        r#"{"ts":"2026-07-07T21:00:00+10:00","queryId":"q1","turnId":"t1","service":"anthropic.messages","model":"claude-sonnet-5","thinking":false,"maxTokens":8192}"#));
    assert_eq!(views.usage(&conv).unwrap().unwrap().turns, 1);

    views.apply("conv-approval", 2, &event("conv.v2.conv-abc.telemetry.usage",
        r#"{"ts":"2026-07-07T21:00:01+10:00","queryId":"q1","turnId":"t1","service":"anthropic.messages","model":"claude-sonnet-5","inputTokens":50,"cacheCreationTokens":0,"cacheReadTokens":630000,"outputTokens":0}"#));
    views.apply("conv-approval", 3, &event("conv.v2.conv-abc.telemetry.usage",
        r#"{"ts":"2026-07-07T21:00:05+10:00","queryId":"q1","turnId":"t1","service":"anthropic.messages","model":"claude-sonnet-5","inputTokens":0,"cacheCreationTokens":0,"cacheReadTokens":0,"outputTokens":420}"#));
    // Two usage frames for the same turn: turns is still 1.
    assert_eq!(views.usage(&conv).unwrap().unwrap().turns, 1);

    views.apply("conv-approval", 4, &event("conv.v2.conv-abc.telemetry.turn.started",
        r#"{"ts":"2026-07-07T21:01:00+10:00","queryId":"q1","turnId":"t2","service":"anthropic.messages","model":"claude-sonnet-5","thinking":false,"maxTokens":8192}"#));
    // A genuinely new turn does increment.
    assert_eq!(views.usage(&conv).unwrap().unwrap().turns, 2);
}

#[test]
fn delta_streams_but_never_stores() {
    let (mut views, mut rx) = fresh();
    views.apply(
        "conv-approval",
        1,
        &event(
            "conv.v2.conv-abc.deltas",
            r#"{"type":"delta","text":"File X"}"#,
        ),
    );
    assert!(rows_of(&views).is_empty());
    assert!(matches!(
        rx.try_recv().unwrap(),
        ViewEvent::Streaming { .. }
    ));
    assert_eq!(read_cursor(&views.db, "conv-approval").unwrap(), 1);
}

#[test]
fn after_filters_catch_up() {
    let (mut views, _rx) = fresh();
    views.apply(
        "conv-approval",
        1,
        &event("conv.v2.conv-abc.changes.message", MSG_M1),
    );
    views.apply("conv-approval", 2, &event("conv.v2.conv-abc.changes.message",
        r#"{"ts":"2026-07-07T21:05:00+10:00","id":"m2","queryId":"q1","turnId":"t1","role":"assistant","from":{"kind":"agent"},"content":[{"type":"text","text":"done"}]}"#));
    // The boundary is inclusive: a message tied with the client's
    // high-water mark is re-sent (client dedupes by id), so the catch-up
    // from m1's ts carries m1 again plus m2.
    let m1_ts = parse_ts("2026-07-07T21:00:00+10:00").unwrap();
    let msgs = views
        .conversation(&ConversationId("conv-abc".into()), Some(m1_ts))
        .unwrap();
    assert_eq!(msgs.len(), 2);
    assert_eq!(msgs[0].id.0, "m1");
    assert_eq!(msgs[1].id.0, "m2");

    // Strictly past m1's ts, only m2 remains.
    let msgs = views
        .conversation(&ConversationId("conv-abc".into()), Some(m1_ts + 1))
        .unwrap();
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0].id.0, "m2");
}

#[test]
fn heavy_tool_result_is_externalised_and_fetchable() {
    let (mut views, _rx) = fresh();
    let heavy = format!(
        r#"{{"ts":"2026-07-07T21:00:00+10:00","id":"m9","queryId":"q1","turnId":"t2","role":"user","from":{{"kind":"agent"}},"content":[{{"type":"tool_result","tool_use_id":"toolu_01","content":"{}"}}]}}"#,
        "y".repeat(1000)
    );
    views.apply(
        "conv-approval",
        1,
        &event("conv.v2.conv-abc.changes.message", &heavy),
    );
    let msgs = views
        .conversation(&ConversationId("conv-abc".into()), None)
        .unwrap();
    let reference = &msgs[0].content[0]["content"];
    let id = reference["$ref"].as_str().unwrap();
    assert!(id.starts_with("sha256-"));
    let (hint, bytes) = views.get_ref(id).unwrap().unwrap();
    assert_eq!(hint, "tool_result");
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&bytes).unwrap(),
        serde_json::Value::String("y".repeat(1000))
    );
}

#[test]
fn unknown_event_with_ts_still_touches_staleness() {
    let (mut views, _rx) = fresh();
    views.apply(
        "conv-approval",
        1,
        &event(
            "conv.v2.conv-abc.telemetry.vibe.shift",
            r#"{"ts":"2026-07-07T21:00:00+10:00"}"#,
        ),
    );
    let rows = rows_of(&views);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].last_kind, "vibe_shift");
}

#[test]
fn titles_set_overwrite_clear_and_survive_rematerialisation() {
    let (mut views, _rx) = fresh();
    views.apply(
        "conv-approval",
        1,
        &event("conv.v2.conv-abc.changes.message", MSG_M1),
    );
    let conv = ConversationId("conv-abc".into());

    // Set, then overwrite (last write wins).
    views.set_title(&conv, "tower build").unwrap();
    views.set_title(&conv, "tower v1").unwrap();
    assert_eq!(rows_of(&views)[0].title.as_deref(), Some("tower v1"));

    // A title for a conversation the views have never seen is allowed;
    // the row is born titled when its first event arrives.
    views
        .set_title(&ConversationId("conv-new".into()), "early name")
        .unwrap();

    // Rematerialisation truncates the derived tables only — titles are
    // not a materialised view and must survive.
    views
        .db
        .execute_batch(
            "DELETE FROM rows; DELETE FROM messages; DELETE FROM refs;
         UPDATE cursor SET seq = 0 WHERE stream_name = 'conv-approval';",
        )
        .unwrap();
    views.apply(
        "conv-approval",
        1,
        &event("conv.v2.conv-abc.changes.message", MSG_M1),
    );
    assert_eq!(rows_of(&views)[0].title.as_deref(), Some("tower v1"));

    // Empty title clears; the row falls back to untitled.
    views.set_title(&conv, "").unwrap();
    assert_eq!(rows_of(&views)[0].title, None);
}

#[test]
fn layout_round_trips_and_broadcasts_on_set() {
    let (views, mut rx) = fresh();

    // Nothing set yet: absent, not an error.
    assert_eq!(views.layout().unwrap(), None);

    let tabs = r#"[{"name":"main","convs":["c1","c2"]}]"#;
    views.set_layout(tabs).unwrap();
    assert_eq!(views.layout().unwrap().as_deref(), Some(tabs));

    // A second write replaces, last-write-wins, same as titles/tags.
    let renamed = r#"[{"name":"work","convs":["c1"]}]"#;
    views.set_layout(renamed).unwrap();
    assert_eq!(views.layout().unwrap().as_deref(), Some(renamed));

    // set_layout itself doesn't broadcast (the `answer` dispatch does,
    // once the write is known to have committed) — nothing to drain here.
    assert!(rx.try_recv().is_err());
}

#[test]
fn dismissed_approval_drops_from_the_outstanding_snapshot_and_survives_reread() {
    let (mut views, mut rx) = fresh();
    views.apply("conv-approval", 1, &event("approval.v1.apr-1.lifecycle",
        r#"{"type":"raised","ts":"2026-07-07T21:00:00+10:00","ask":{"type":"bash"},"correlation":{"conversationId":"conv-abc"}}"#));
    assert_eq!(views.approvals().unwrap().len(), 1);

    views
        .dismiss_approval(&ApprovalId("apr-1".into()), 999)
        .unwrap();
    assert!(views.approvals().unwrap().is_empty());

    // Not deleted, not settled — dismissed, an honest third state.
    let state = views
        .get_approval(&ApprovalId("apr-1".into()))
        .unwrap()
        .unwrap();
    assert!(state.dismissed);
    assert!(state.settled.is_none());

    // Idempotent: dismissing twice doesn't error or double-insert.
    views
        .dismiss_approval(&ApprovalId("apr-1".into()), 1000)
        .unwrap();

    // Drain the raised broadcast before checking the dismiss one.
    let _ = rx.try_recv();
    let ViewEvent::Approval(broadcast) = rx.try_recv().unwrap() else {
        panic!("expected an approval broadcast");
    };
    assert!(broadcast.dismissed);
}

#[test]
fn dismissed_attachment_drops_until_a_fresh_reattach() {
    let (mut views, _rx) = fresh();
    views.apply(
        "conv-approval",
        1,
        &event(
            "agent.v1.w1.telemetry.attached",
            r#"{"ts":"2026-07-07T21:00:00+10:00","instanceId":"i1","conversationId":"conv-ghost"}"#,
        ),
    );
    let (_, attachments) = views.agents().unwrap();
    assert_eq!(attachments.len(), 1);

    // Dismissed shortly after the first attach, well before the second.
    let dismissed_ts = parse_ts("2026-07-07T21:30:00+10:00").unwrap();
    views
        .dismiss_attachment(
            &WorldId("w1".into()),
            &InstanceId("i1".into()),
            &ConversationId("conv-ghost".into()),
            dismissed_ts,
        )
        .unwrap();
    let (_, attachments) = views.agents().unwrap();
    assert!(attachments.is_empty());

    // A fresh attach (later ts) is new evidence — un-hides it.
    views.apply(
        "conv-approval",
        2,
        &event(
            "agent.v1.w1.telemetry.attached",
            r#"{"ts":"2026-07-08T21:00:00+10:00","instanceId":"i1","conversationId":"conv-ghost"}"#,
        ),
    );
    let (_, attachments) = views.agents().unwrap();
    assert_eq!(attachments.len(), 1);
}

#[test]
fn sync_stream_adopts_resumes_and_rematerialises() {
    let (mut views, _rx) = fresh();
    views.apply(
        "conv-approval",
        1,
        &event("conv.v2.conv-abc.changes.message", MSG_M1),
    );
    views
        .set_title(&ConversationId("conv-abc".into()), "tower v1")
        .unwrap();

    // First contact (nothing stored): ADOPT — keep data, keep cursor.
    // This is also the upgrade path for a db from before migration 3.
    assert_eq!(
        views
            .sync_stream("conv-approval", "incarnation-A", 100)
            .unwrap(),
        1
    );
    assert_eq!(rows_of(&views).len(), 1);

    // Same incarnation again (every consumer rebuild): resume, touch nothing.
    views.apply("conv-approval", 2, &event("conv.v2.conv-abc.telemetry.turn.started",
        r#"{"ts":"2026-07-07T21:01:00+10:00","queryId":"q1","turnId":"t1","service":"anthropic.messages","model":"claude-sonnet-4-5","thinking":false,"maxTokens":8192}"#));
    assert_eq!(
        views
            .sync_stream("conv-approval", "incarnation-A", 100)
            .unwrap(),
        2
    );
    assert_eq!(rows_of(&views).len(), 1);

    // A DIFFERENT incarnation: the stream was recreated — rematerialise.
    // Derived tables empty, cursor 0; the title (annotation) survives.
    assert_eq!(
        views
            .sync_stream("conv-approval", "incarnation-B", 100)
            .unwrap(),
        0
    );
    assert!(rows_of(&views).is_empty());
    assert!(
        views
            .conversation(&ConversationId("conv-abc".into()), None)
            .unwrap()
            .is_empty()
    );
    assert_eq!(read_cursor(&views.db, "conv-approval").unwrap(), 0);

    // Replay refills the views; the row comes back already titled.
    views.apply(
        "conv-approval",
        1,
        &event("conv.v2.conv-abc.changes.message", MSG_M1),
    );
    assert_eq!(rows_of(&views)[0].title.as_deref(), Some("tower v1"));

    // And incarnation-B is now home: same again resumes normally.
    assert_eq!(
        views
            .sync_stream("conv-approval", "incarnation-B", 100)
            .unwrap(),
        1
    );
}

#[test]
fn sync_stream_guard_replays_when_cursor_is_beyond_last_seq() {
    // Tonight's live strand: adopt a stream whose sequences end BELOW
    // the cursor — an unreachable position. The guard answers 0 (replay)
    // and, unlike rematerialisation, truncates nothing: the views keep
    // what they hold and the idempotent fold refills on top.
    let (mut views, _rx) = fresh();
    views.apply(
        "conv-approval",
        23386,
        &event("conv.v2.conv-abc.changes.message", MSG_M1),
    );
    views
        .set_title(&ConversationId("conv-abc".into()), "tower v1")
        .unwrap();

    // Adopt arm meets a 628-message stream holding cursor 23386.
    assert_eq!(
        views
            .sync_stream("conv-approval", "incarnation-A", 628)
            .unwrap(),
        0
    );
    // Views intact — no truncation on the guard path; cursor reset.
    assert_eq!(rows_of(&views).len(), 1);
    assert_eq!(rows_of(&views)[0].title.as_deref(), Some("tower v1"));
    assert_eq!(read_cursor(&views.db, "conv-approval").unwrap(), 0);

    // Same-incarnation arm gets the same protection.
    views.apply(
        "conv-approval",
        23386,
        &event("conv.v2.conv-abc.changes.message", MSG_M1),
    );
    assert_eq!(
        views
            .sync_stream("conv-approval", "incarnation-A", 628)
            .unwrap(),
        0
    );
}

#[test]
fn approval_fold_raised_pulsed_settled() {
    let (mut views, mut rx) = fresh();

    // Scenario 6a: raised → pending in the snapshot, with its ask verbatim.
    views.apply("conv-approval", 1, &event("approval.v1.apr-1.lifecycle",
        r#"{"type":"raised","ts":"2026-07-07T21:00:00+10:00","ask":{"type":"tool_use","name":"DeleteFile","input":{"content":{"type":"files","values":["./old.ts"]}}},"correlation":{"conversationId":"conv-abc","queryId":"q2","turnId":"t3","toolUseId":"toolu_02DEF"}}"#));
    let pending = views.approvals().unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].id.0, "apr-1");
    assert_eq!(pending[0].ask["name"], "DeleteFile");
    assert_eq!(
        pending[0].correlation.as_ref().unwrap()["conversationId"],
        "conv-abc"
    );
    assert!(matches!(rx.try_recv().unwrap(), ViewEvent::Approval(_)));

    // The pulse refreshes last_pulse, monotonically.
    views.apply(
        "conv-approval",
        2,
        &event(
            "approval.v1.apr-1.telemetry",
            r#"{"type":"heartbeat","ts":"2026-07-07T21:00:15+10:00"}"#,
        ),
    );
    let pending = views.approvals().unwrap();
    assert!(pending[0].last_pulse > pending[0].raised_ts);

    // Settled: out of the pending snapshot; the broadcast carries whose
    // decision it was.
    views.apply("conv-approval", 3, &event("approval.v1.apr-1.lifecycle",
        r#"{"type":"settled","ts":"2026-07-07T21:00:30+10:00","approved":true,"by":{"kind":"human","userId":"stephen"}}"#));
    assert!(views.approvals().unwrap().is_empty());
    let _ = rx.try_recv(); // the pulse's event
    let ViewEvent::Approval(state) = rx.try_recv().unwrap() else {
        panic!("expected an approval event");
    };
    let settled = state.settled.unwrap();
    assert!(settled.approved);
    assert_eq!(settled.by["userId"], "stephen");

    // Replay of the raised after settlement never erases the settlement.
    views.apply("conv-approval", 1, &event("approval.v1.apr-1.lifecycle",
        r#"{"type":"raised","ts":"2026-07-07T21:00:00+10:00","ask":{"type":"tool_use","name":"DeleteFile","input":{"content":{"type":"files","values":["./old.ts"]}}},"correlation":{"conversationId":"conv-abc"}}"#));
    assert!(views.approvals().unwrap().is_empty());

    // A pulse for an id never raised is skipped, not invented.
    views.apply(
        "conv-approval",
        4,
        &event(
            "approval.v1.apr-unknown.telemetry",
            r#"{"type":"heartbeat","ts":"2026-07-07T21:00:00+10:00"}"#,
        ),
    );
    assert!(views.approvals().unwrap().is_empty());
    assert_eq!(read_cursor(&views.db, "conv-approval").unwrap(), 4);
}

#[test]
fn tags_set_overwrite_clear_and_colour_keys() {
    let (mut views, _rx) = fresh();
    views.apply(
        "conv-approval",
        1,
        &event("conv.v2.conv-abc.changes.message", MSG_M1),
    );
    let conv = ConversationId("conv-abc".into());

    // Set two keys; first use mints each key's colour.
    views.set_tag(&conv, "mission", "tower-design").unwrap();
    views.set_tag(&conv, "role", "pm").unwrap();
    let (rows, keys) = views.list().unwrap();
    assert_eq!(rows[0].tags.len(), 2);
    assert!(
        rows[0]
            .tags
            .contains(&("mission".into(), "tower-design".into()))
    );
    assert_eq!(keys.len(), 2);
    assert!(keys.iter().all(|(_, c)| c.starts_with('#')));

    // Overwrite (last write wins) keeps one value per key; the key's
    // colour is stable across overwrites.
    let mission_colour = keys.iter().find(|(k, _)| k == "mission").unwrap().1.clone();
    views.set_tag(&conv, "mission", "tower-v2").unwrap();
    let (rows, keys) = views.list().unwrap();
    assert!(
        rows[0]
            .tags
            .contains(&("mission".into(), "tower-v2".into()))
    );
    assert_eq!(
        keys.iter().find(|(k, _)| k == "mission").unwrap().1,
        mission_colour
    );

    // Empty value clears the key from the conversation; the key's colour
    // survives (other conversations may still wear it).
    views.set_tag(&conv, "mission", "").unwrap();
    let (rows, keys) = views.list().unwrap();
    assert_eq!(rows[0].tags.len(), 1);
    assert_eq!(keys.len(), 2);

    // Tags survive rematerialisation — annotations, not derived views.
    views
        .db
        .execute_batch(
            "DELETE FROM rows; DELETE FROM messages; DELETE FROM refs;
             UPDATE cursor SET seq = 0 WHERE stream_name = 'conv-approval';",
        )
        .unwrap();
    views.apply(
        "conv-approval",
        1,
        &event("conv.v2.conv-abc.changes.message", MSG_M1),
    );
    assert_eq!(rows_of(&views)[0].tags.len(), 1);
}

#[test]
fn agent_fold_ready_pulse_attach_detach() {
    let (mut views, mut rx) = fresh();

    // Scenario a1: ready seeds the instance, the pulse declares the
    // promise, attached makes the conversation exist for observers.
    views.apply(
        "conv-approval",
        1,
        &event(
            "agent.v1.mac.telemetry.ready",
            r#"{"ts":"2026-07-07T21:00:00+10:00","instanceId":"inst-1a2f","host":"mac"}"#,
        ),
    );
    views.apply(
        "conv-approval",
        2,
        &event(
            "agent.v1.mac.telemetry.pulse",
            r#"{"ts":"2026-07-07T21:00:30+10:00","instanceId":"inst-1a2f","intervalS":30}"#,
        ),
    );
    views.apply("conv-approval", 3, &event("agent.v1.mac.telemetry.attached",
        r#"{"ts":"2026-07-07T21:00:30+10:00","instanceId":"inst-1a2f","conversationId":"conv-abc","cwd":"~/repos/tower"}"#));

    let (instances, attachments) = views.agents().unwrap();
    assert_eq!(instances.len(), 1);
    assert_eq!(instances[0].instance.0, "inst-1a2f");
    assert_eq!(instances[0].host.as_deref(), Some("mac"));
    assert_eq!(instances[0].interval_s, Some(30));
    assert!(instances[0].last_pulse > 0);
    assert_eq!(attachments.len(), 1);
    assert_eq!(attachments[0].conv.0, "conv-abc");
    assert_eq!(attachments[0].cwd.as_deref(), Some("~/repos/tower"));

    // Agent facts never touch rows: no conversation activity happened.
    assert!(rows_of(&views).is_empty());
    assert!(matches!(
        rx.try_recv().unwrap(),
        ViewEvent::Agent(AgentFact::Ready { .. })
    ));
    assert!(matches!(
        rx.try_recv().unwrap(),
        ViewEvent::Agent(AgentFact::Pulse { .. })
    ));
    assert!(matches!(
        rx.try_recv().unwrap(),
        ViewEvent::Agent(AgentFact::Attached { .. })
    ));

    // An out-of-order pulse never regresses the liveness fact.
    let fresh_pulse = instances[0].last_pulse;
    views.apply(
        "conv-approval",
        4,
        &event(
            "agent.v1.mac.telemetry.pulse",
            r#"{"ts":"2026-07-07T20:59:00+10:00","instanceId":"inst-1a2f","intervalS":30}"#,
        ),
    );
    let (instances, _) = views.agents().unwrap();
    assert_eq!(instances[0].last_pulse, fresh_pulse);

    // Scenario a2: detached deletes — a released attachment is absence.
    views.apply("conv-approval", 5, &event("agent.v1.mac.telemetry.detached",
        r#"{"ts":"2026-07-07T21:01:00+10:00","instanceId":"inst-1a2f","conversationId":"conv-abc"}"#));
    let (instances, attachments) = views.agents().unwrap();
    assert_eq!(instances.len(), 1); // the instance fact survives
    assert!(attachments.is_empty());
    assert_eq!(read_cursor(&views.db, "conv-approval").unwrap(), 5);
}

#[test]
fn agent_tables_are_derived_and_rematerialise() {
    let (mut views, _rx) = fresh();
    views.apply("conv-approval", 1, &event("agent.v1.mac.telemetry.attached",
        r#"{"ts":"2026-07-07T21:00:00+10:00","instanceId":"inst-1a2f","conversationId":"conv-abc","cwd":"~/repos/tower"}"#));
    assert_eq!(
        views
            .sync_stream("conv-approval", "incarnation-A", 100)
            .unwrap(),
        1
    );

    // A recreated stream truncates the agent tables with the other
    // derived views — fully rebuildable from replay.
    assert_eq!(
        views
            .sync_stream("conv-approval", "incarnation-B", 100)
            .unwrap(),
        0
    );
    let (instances, attachments) = views.agents().unwrap();
    assert!(instances.is_empty());
    assert!(attachments.is_empty());
}

#[test]
fn out_of_order_row_touch_never_regresses() {
    let (mut views, _rx) = fresh();
    views.apply(
        "conv-approval",
        1,
        &event("conv.v2.conv-abc.changes.message", MSG_M1),
    ); // 21:00
    views.apply(
        "conv-approval",
        2,
        &event(
            "conv.v2.conv-abc.telemetry.turn.cancelled",
            r#"{"ts":"2026-07-07T20:00:00+10:00","queryId":"q0","turnId":"t0"}"#,
        ),
    );
    let rows = rows_of(&views);
    assert_eq!(rows[0].last_kind, "message"); // the earlier ts did not win
}

#[test]
fn turn_finishing_mints_a_silent_episode_then_the_timer_declares_it_stale() {
    let (mut views, mut rx) = fresh();
    let conv = ConversationId("conv-abc".into());
    // An assistant message landing mints an episode — silently: no broadcast
    // yet, only the row/message frames the fold always sends.
    views.apply("conv-approval", 1, &event("conv.v2.conv-abc.changes.message",
        r#"{"ts":"2026-07-07T21:00:00+10:00","id":"m1","queryId":"q1","turnId":"t1","role":"assistant","from":{"kind":"agent"},"content":[{"type":"text","text":"done"}]}"#));
    while let Ok(ev) = rx.try_recv() {
        assert!(!matches!(ev, ViewEvent::Unread(_)));
    }
    assert!(views.stale_conversations().unwrap().is_empty());

    // The timer fires: NOW it broadcasts, and the snapshot carries it.
    let read_id = views
        .db
        .query_row(
            "SELECT read_id FROM unread WHERE conv = ?1",
            [&conv.0],
            |r| r.get::<_, String>(0),
        )
        .unwrap();
    views.on_stale_timer(&conv, &read_id);
    let ViewEvent::Unread(state) = rx.try_recv().unwrap() else {
        panic!("expected an unread broadcast");
    };
    assert!(state.stale);
    assert_eq!(state.read_id, read_id);
    let snapshot = views.stale_conversations().unwrap();
    assert_eq!(snapshot.len(), 1);
    assert_eq!(snapshot[0].conv.0, "conv-abc");
}

#[test]
fn a_second_turn_while_unread_does_not_reset_the_episode_or_its_timer() {
    // The starvation guard: more qualifying events landing while an episode
    // is already open must not mint a new read_id (which would restart the
    // timer and could starve a busy conversation into never going stale).
    let (mut views, _rx) = fresh();
    views.apply("conv-approval", 1, &event("conv.v2.conv-abc.changes.message",
        r#"{"ts":"2026-07-07T21:00:00+10:00","id":"m1","queryId":"q1","turnId":"t1","role":"assistant","from":{"kind":"agent"},"content":[{"type":"text","text":"one"}]}"#));
    let first_read_id: String = views
        .db
        .query_row(
            "SELECT read_id FROM unread WHERE conv = ?1",
            ["conv-abc"],
            |r| r.get(0),
        )
        .unwrap();
    views.apply("conv-approval", 2, &event("conv.v2.conv-abc.changes.message",
        r#"{"ts":"2026-07-07T21:05:00+10:00","id":"m2","queryId":"q2","turnId":"t2","role":"assistant","from":{"kind":"agent"},"content":[{"type":"text","text":"two"}]}"#));
    let second_read_id: String = views
        .db
        .query_row(
            "SELECT read_id FROM unread WHERE conv = ?1",
            ["conv-abc"],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(first_read_id, second_read_id);
}

#[test]
fn an_ack_before_the_timer_fires_stays_silent_forever() {
    let (mut views, mut rx) = fresh();
    let conv = ConversationId("conv-abc".into());
    views.apply("conv-approval", 1, &event("conv.v2.conv-abc.changes.message",
        r#"{"ts":"2026-07-07T21:00:00+10:00","id":"m1","queryId":"q1","turnId":"t1","role":"assistant","from":{"kind":"agent"},"content":[{"type":"text","text":"done"}]}"#));
    let read_id: String = views
        .db
        .query_row(
            "SELECT read_id FROM unread WHERE conv = ?1",
            [&conv.0],
            |r| r.get(0),
        )
        .unwrap();

    views.ack_unread(&conv);
    while let Ok(ev) = rx.try_recv() {
        assert!(!matches!(ev, ViewEvent::Unread(_))); // acked before stale: silent
    }

    // The timer firing after the fact is a no-op — the episode is gone.
    views.on_stale_timer(&conv, &read_id);
    assert!(rx.try_recv().is_err());
    assert!(views.stale_conversations().unwrap().is_empty());
}

#[test]
fn an_ack_after_stale_resolves_it_everywhere() {
    let (mut views, mut rx) = fresh();
    let conv = ConversationId("conv-abc".into());
    views.apply("conv-approval", 1, &event("conv.v2.conv-abc.changes.message",
        r#"{"ts":"2026-07-07T21:00:00+10:00","id":"m1","queryId":"q1","turnId":"t1","role":"assistant","from":{"kind":"agent"},"content":[{"type":"text","text":"done"}]}"#));
    let read_id: String = views
        .db
        .query_row(
            "SELECT read_id FROM unread WHERE conv = ?1",
            [&conv.0],
            |r| r.get(0),
        )
        .unwrap();
    views.on_stale_timer(&conv, &read_id);
    // Drain the row/message broadcasts from apply() plus the stale one.
    while let Ok(ev) = rx.try_recv() {
        if matches!(ev, ViewEvent::Unread(_)) {
            break;
        }
    }

    views.ack_unread(&conv);
    let ViewEvent::Unread(state) = rx.try_recv().unwrap() else {
        panic!("expected a resolution broadcast");
    };
    assert!(!state.stale);
    assert!(views.stale_conversations().unwrap().is_empty());

    // Idempotent: acking again is a silent no-op.
    views.ack_unread(&conv);
    assert!(rx.try_recv().is_err());
}

#[test]
fn a_user_message_is_not_a_qualifying_event() {
    // Only an assistant turn landing counts — new content nobody's seen. A
    // human's own message is not "new content" in that sense.
    let (mut views, _rx) = fresh();
    views.apply(
        "conv-approval",
        1,
        &event("conv.v2.conv-abc.changes.message", MSG_M1), // role: user
    );
    assert!(
        views
            .db
            .query_row("SELECT 1 FROM unread WHERE conv = 'conv-abc'", [], |r| r
                .get::<_, i64>(0))
            .optional()
            .unwrap()
            .is_none()
    );
}
