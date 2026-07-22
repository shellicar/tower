//! Schema — numbered migrations over `user_version` (the CLI's migrate
//! pattern). Append-only: a shipped migration is never edited. Plus the
//! cursor/usage reads that need direct sqlite access before `Views` (the
//! struct) is built, or from a sibling module without borrowing it.

use rusqlite::{Connection, OptionalExtension};

use wire::ConversationId;

use super::types::UsageState;

/// The one shared layout row ("default" — no per-user dimension yet). Read
/// by `query::layout` and written by `mutate::set_layout`.
pub(super) const LAYOUT_ID: &str = "default";

const MIGRATIONS: &[&str] = &[
    // 1 — the v1 schema (tower-v1-design.md, Views schema).
    "CREATE TABLE cursor (
         id  INTEGER PRIMARY KEY CHECK (id = 1),
         seq INTEGER NOT NULL
     );
     INSERT INTO cursor (id, seq) VALUES (1, 0);
     CREATE TABLE rows (
         conv       TEXT PRIMARY KEY,
         last_event INTEGER NOT NULL,
         last_kind  TEXT NOT NULL
     );
     CREATE TABLE messages (
         conv       TEXT NOT NULL,
         message_id TEXT NOT NULL,
         query_id   TEXT NOT NULL,
         turn_id    TEXT NOT NULL,
         role       TEXT NOT NULL,
         sender     TEXT NOT NULL,
         content    TEXT NOT NULL,
         ts         INTEGER NOT NULL,
         PRIMARY KEY (conv, message_id)
     );
     CREATE INDEX messages_by_conv_ts ON messages (conv, ts);
     CREATE TABLE refs (
         id    TEXT PRIMARY KEY,
         hint  TEXT NOT NULL,
         bytes BLOB NOT NULL
     );",
    // 2 — titles: tower's own annotation, keyed by conversation id. NOT a
    // materialised view: it is the one table rematerialisation must never
    // touch, because it derives from nothing — it is what the SC typed.
    "CREATE TABLE titles (
         conv  TEXT PRIMARY KEY,
         title TEXT NOT NULL
     );",
    // 3 — the capture stream's incarnation (its created time), recorded so a
    // recreated stream (sequences restart at 1) is detectable: the cursor is
    // only meaningful against the stream it was advanced by.
    "CREATE TABLE stream (
         id      INTEGER PRIMARY KEY CHECK (id = 1),
         created TEXT NOT NULL
     );",
    // 4 — approvals: the outstanding-set fold, derived from
    // approval.v1.*.{lifecycle,telemetry} (in the rematerialise truncation
    // set). `conv` is correlation.conversationId extracted for the rail's
    // row marker; ask/correlation/by stay verbatim JSON.
    "CREATE TABLE approvals (
         id               TEXT PRIMARY KEY,
         ask              TEXT NOT NULL,
         correlation      TEXT,
         conv             TEXT,
         raised_ts        INTEGER NOT NULL,
         last_pulse       INTEGER NOT NULL,
         settled_approved INTEGER,
         settled_by       TEXT,
         settled_ts       INTEGER
     );",
    // 5 — tags: tower's own annotations, flat key:value (one value per key
    // per conversation), plus the key's colour — the tag's identity IS the
    // key, so its colour is shared truth. NOT materialised views: never
    // touched by rematerialisation.
    "CREATE TABLE tags (
         conv  TEXT NOT NULL,
         key   TEXT NOT NULL,
         value TEXT NOT NULL,
         PRIMARY KEY (conv, key)
     );
     CREATE TABLE tag_keys (
         key    TEXT PRIMARY KEY,
         colour TEXT NOT NULL
     );",
    // 6 — agent liveness: two tables, never one (the pulse is one fact per
    // instance; per-conversation copies are the restatement agent-spec
    // forbids). Derived from agent.v1.*.telemetry.> — in the rematerialise
    // truncation set. No verdict column: alive/released/stranded is the
    // client's derivation.
    "CREATE TABLE agent_instances (
         world       TEXT NOT NULL,
         instance_id TEXT NOT NULL,
         host        TEXT,
         last_pulse  INTEGER NOT NULL,
         interval_s  INTEGER,
         PRIMARY KEY (world, instance_id)
     );
     CREATE TABLE agent_attachments (
         world       TEXT NOT NULL,
         instance_id TEXT NOT NULL,
         conv        TEXT NOT NULL,
         cwd         TEXT,
         attached_ts INTEGER NOT NULL,
         PRIMARY KEY (world, instance_id, conv)
     );",
    // 7 — usage: the per-conversation cost surface, folded from
    // conv.v2.*.telemetry usage AND turn_started (fold.rs: turn_started
    // alone drives `turns` — the one signal that fires exactly once per
    // turn; usage is a token/cost fact, never a turn count). The four token
    // counts are cumulative over the conversation; `model` and
    // `context_tokens` are the LATEST turn's (the current prompt size, not
    // a sum). In the rematerialise truncation set. Facts only — the dollar
    // and the context percentage are the client's policy.
    "CREATE TABLE usage (
         conv                  TEXT PRIMARY KEY,
         input_tokens          INTEGER NOT NULL,
         cache_creation_tokens INTEGER NOT NULL,
         cache_read_tokens     INTEGER NOT NULL,
         output_tokens         INTEGER NOT NULL,
         turns                 INTEGER NOT NULL,
         context_tokens        INTEGER NOT NULL,
         model                 TEXT NOT NULL
     );",
    // 8 — the 5m/1h split of cache_creation (conversation-spec's optional
    // cacheCreation{5m,1h}Tokens). Added after 7 shipped, so ALTER not edit;
    // default 0 covers rows and producers that never carried the split.
    "ALTER TABLE usage ADD COLUMN cache_creation_5m_tokens INTEGER NOT NULL DEFAULT 0;
     ALTER TABLE usage ADD COLUMN cache_creation_1h_tokens INTEGER NOT NULL DEFAULT 0;",
    // 9 — layout: the durable shape of attention across the fleet (which
    // tabs exist, which conversations are open in each, what each is
    // called). NOT a materialised view: never touched by rematerialisation,
    // same footing as titles/tags. Keyed by `layout_id` though v1 has
    // exactly one row ("default") — no auth yet, so no per-user dimension
    // to key on, but the shape is known (a login, a profile) and the CLAUDE.md
    // schema rule is explicit: key it now, don't singleton and migrate later.
    // `tabs` is the whole blob as JSON text, not normalised — tabs are few
    // and always read/written together, so there is nothing a join buys here.
    "CREATE TABLE layout (
         layout_id TEXT PRIMARY KEY,
         tabs      TEXT NOT NULL
     );",
    // 10 — dismissed approvals/attachments: a human's own decision to stop
    // tracking a dead thing ("connection is authority" — a connected client
    // choosing to dismiss is the same standing that answers an approval or
    // sets a title). Kept as SEPARATE tables, not columns on the derived
    // `approvals`/`agent_attachments` tables, for the same reason titles/tags
    // are separate: rematerialisation truncates derived tables on a stream
    // incarnation change, and a human's dismissal must survive that —
    // otherwise a rare recovery path silently resurrects everything anyone
    // ever dismissed. NOT a claim the approval was answered or the agent
    // detached (both of those are facts tower has no authority to assert);
    // purely tower's own record of "stop showing me this."
    "CREATE TABLE dismissed_approvals (
         id            TEXT PRIMARY KEY,
         dismissed_ts  INTEGER NOT NULL
     );
     CREATE TABLE dismissed_attachments (
         world         TEXT NOT NULL,
         instance_id   TEXT NOT NULL,
         conv          TEXT NOT NULL,
         dismissed_ts  INTEGER NOT NULL,
         PRIMARY KEY (world, instance_id, conv)
     );",
    // 11 — cursor/stream go from singleton (one capture stream) to keyed by
    // stream name: the capture subjects split across audit/diagnostic/
    // ephemeral streams (each with its own retention), so each needs its own
    // independent, non-comparable sequence position. The existing singleton
    // row carries over to 'conv-approval' — an upgrade resumes exactly where
    // it was, not a rematerialisation; the other two streams get no seed row,
    // same as a fresh single-stream install starting from nothing.
    "CREATE TABLE cursor_v2 (stream_name TEXT PRIMARY KEY, seq INTEGER NOT NULL);
     CREATE TABLE stream_v2 (stream_name TEXT PRIMARY KEY, created TEXT NOT NULL);
     INSERT INTO cursor_v2 (stream_name, seq) SELECT 'conv-approval', seq FROM cursor WHERE id = 1;
     INSERT INTO stream_v2 (stream_name, created) SELECT 'conv-approval', created FROM stream WHERE id = 1;
     DROP TABLE cursor;
     DROP TABLE stream;
     ALTER TABLE cursor_v2 RENAME TO cursor;
     ALTER TABLE stream_v2 RENAME TO stream;",
    // 12 — `sender` becomes nullable: a tool_result carries no `from` at all
    // (conversation-spec, 19 Jul correction — it is a mechanical delivery,
    // not an utterance, so stamping it with a sender was a category error).
    // SQLite has no DROP NOT NULL, so recreate: existing rows carry over
    // verbatim, including the stale sender JSON already committed on old
    // tool_result rows — append-only history is not rewritten by a shape fix.
    "CREATE TABLE messages_v2 (
         conv       TEXT NOT NULL,
         message_id TEXT NOT NULL,
         query_id   TEXT NOT NULL,
         turn_id    TEXT NOT NULL,
         role       TEXT NOT NULL,
         sender     TEXT,
         content    TEXT NOT NULL,
         ts         INTEGER NOT NULL,
         PRIMARY KEY (conv, message_id)
     );
     INSERT INTO messages_v2 SELECT * FROM messages;
     DROP TABLE messages;
     ALTER TABLE messages_v2 RENAME TO messages;
     CREATE INDEX messages_by_conv_ts ON messages (conv, ts);",
    // 13 — unread: the ticket-system stale-conversation signal ("has anyone
    // on the fleet looked at this"), one row per conversation, upserted in
    // place. `unread` starts true the moment a qualifying event (an
    // assistant turn) lands on a resolved conversation, and stays true until
    // acked; `stale` flips true only once the per-episode timer fires with
    // nobody having acked it yet — the durable, broadcastable state.
    // `read_id` is the episode's identity: a superseded or late ack is a
    // harmless no-op, never an error. NOT a materialised view — tower's own
    // annotation, never touched by rematerialisation (same footing as
    // titles/tags/layout).
    "CREATE TABLE unread (
         conv    TEXT PRIMARY KEY,
         read_id TEXT NOT NULL,
         unread  INTEGER NOT NULL,
         stale   INTEGER NOT NULL
     );",
];

pub fn apply_schema(db: &Connection) -> anyhow::Result<()> {
    let version: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, migration) in MIGRATIONS.iter().enumerate() {
        let target = (i + 1) as i64;
        if version < target {
            db.execute_batch(migration)?;
            db.pragma_update(None, "user_version", target)?;
        }
    }
    Ok(())
}

pub fn read_cursor(db: &Connection, stream_name: &str) -> anyhow::Result<u64> {
    Ok(db
        .query_row(
            "SELECT seq FROM cursor WHERE stream_name = ?1",
            [stream_name],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
        .unwrap_or(0) as u64)
}

/// The conversation's usage row as a snapshot. Errors with `QueryReturnedNoRows`
/// when the conversation has no usage yet; callers that want an `Option` wrap
/// with `.optional()`.
pub(super) fn read_usage_row(
    db: &Connection,
    conv: &ConversationId,
) -> rusqlite::Result<UsageState> {
    db.query_row(
        "SELECT input_tokens, cache_creation_tokens, cache_creation_5m_tokens,
                cache_creation_1h_tokens, cache_read_tokens, output_tokens,
                turns, context_tokens, model
         FROM usage WHERE conv = ?1",
        [&conv.0],
        |r| {
            Ok(UsageState {
                conv: conv.clone(),
                input_tokens: r.get(0)?,
                cache_creation_tokens: r.get(1)?,
                cache_creation_5m_tokens: r.get(2)?,
                cache_creation_1h_tokens: r.get(3)?,
                cache_read_tokens: r.get(4)?,
                output_tokens: r.get(5)?,
                turns: r.get(6)?,
                context_tokens: r.get(7)?,
                model: r.get(8)?,
            })
        },
    )
}
