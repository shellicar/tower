# Tower v1 — design

Web UI: conversations ordered by last event; open one; read; say.
Backend Rust (`towerd`), frontend Svelte, coupling = NATS concern specs + `tower-ws-spec.md` (to write).

## Layout

```
crates/
  wire/     # spec types + pure folds. No I/O, no tokio.
  towerd/   # binary: ingest → views → web.
frontend/   # Svelte SPA. Not a crate. Talks WS per tower-ws-spec.md.
```

## Components and channels

```
        NATS (JetStream consumer, from cursor+1)
          │
   ┌──────▼──────┐   Event    ┌───────────────────────┐
   │   Ingest    ├───mpsc────▶│  Views (dedicated OS  │
   │ (one broker │            │  thread; owns sqlite) │
   │ connection) │            └──────┬──────────┬─────┘
   └──────┬──────┘        broadcast  │          │ oneshot replies
          │              ViewEvent   │          │ to ViewQuery
          │                     ┌────▼──────────▼────┐
          │   SayCommand        │     WsSessions     │
          └───────◀─────────────┤  (axum, one task   │
              SayGateway        │   per socket)      │
                                └────────────────────┘
```

## Seams

```rust
pub struct ConversationId(pub String);
pub struct QueryId(pub String);
pub struct TurnId(pub String);
pub struct MessageId(pub String);
pub struct ApprovalId(pub String);
```

```rust
// Ingest → Views
pub struct Event {
    pub conv: ConversationId,
    pub kind: EventKind,
}

pub enum EventKind {
    Telemetry(ConvTelemetry),
    Change(ConvChange),
    Delta(ConvDelta),
    Unknown,
}
```

```rust
// Views → sessions
pub enum ViewEvent {
    Row(RowChanged),
    Message   { conv: ConversationId, message: ConversationMessage },
    Streaming { conv: ConversationId, text: String },
}

pub struct RowChanged { pub conv: ConversationId, pub last_event: Timestamp, pub last_kind: String }

pub struct ConversationMessage {
    pub id: MessageId,
    pub query: QueryId,
    pub turn: TurnId,
    pub role: String,
    pub from: Sender,
    pub content: Vec<ContentBlock>,
    pub ts: Timestamp,
}

pub enum ViewQuery {
    List { reply: oneshot::Sender<Vec<RowState>> },
    Conversation {
        conv: ConversationId,
        after: Option<Timestamp>,   // client's high-water mark; None = from the start
        reply: oneshot::Sender<Vec<ConversationMessage>>,
    },
}
```

```rust
// sessions → broker
pub struct SayCommand { pub conv: ConversationId, pub text: String, pub tip: Option<MessageId> }
pub enum SayOutcome { Accepted { query: QueryId }, Rejected { reason: String }, Unreachable }
```

```rust
// the only traits
pub trait Broker { /* publish, request, subscribe */ }
pub trait Clock  { fn now(&self) -> Timestamp; }
```

Browser ↔ towerd: `ClientMsg` / `ServerMsg`, serde-tagged; normative in `tower-ws-spec.md`.

## Views schema (sqlite)

```sql
CREATE TABLE cursor (
    id  INTEGER PRIMARY KEY CHECK (id = 1),   -- exactly one row
    seq INTEGER NOT NULL
);

CREATE TABLE rows (
    conv       TEXT PRIMARY KEY,
    last_event INTEGER NOT NULL,               -- unix millis, UTC
    last_kind  TEXT NOT NULL
);

CREATE TABLE messages (
    conv       TEXT NOT NULL,
    message_id TEXT NOT NULL,
    query_id   TEXT NOT NULL,
    turn_id    TEXT NOT NULL,
    role       TEXT NOT NULL,
    sender     TEXT NOT NULL,                  -- `from` object, JSON, verbatim
    content    TEXT NOT NULL,                  -- content blocks, JSON, opaque
    ts         INTEGER NOT NULL,               -- unix millis, UTC
    PRIMARY KEY (conv, message_id)
);
CREATE INDEX messages_by_conv_ts ON messages (conv, ts);
```

- `ts` parsed once to UTC millis: wire timestamps carry mixed offsets; strings misorder.
- PK `(conv, message_id)` + `INSERT OR REPLACE` = idempotent replay; at-least-once delivery is safe.
- `sender`/`content` opaque JSON; tower renders, never interprets. Deltas are not stored.

## Gateway

```rust
pub async fn say<B: Broker>(broker: &B, cmd: SayCommand) -> SayOutcome {
    let subject = format!("conv.v1.{}.requests", cmd.conv.0);
    let payload = wire::encode_say(&cmd);   // type:"say", from {kind:"human"}, text, precondition {tip} verbatim
    match broker.request(&subject, payload, Duration::from_secs(5)).await {
        BrokerReply::Data(bytes) => wire::parse_say_reply(&bytes),
        BrokerReply::Timeout | BrokerReply::NoResponders => SayOutcome::Unreachable,
    }
}
```

- No retry: the human re-sends; an automatic retry could double-send.
- Timeout/no-responders fold to `Unreachable`; distinguishing them would invent meaning.

## main

```rust
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let nats_url = std::env::var("NATS_URL")?;
    let bind     = std::env::var("TOWER_BIND")?;
    let db_path  = std::env::var("TOWER_DB")?;

    // storage first: the cursor must exist before ingest can start
    let db = rusqlite::Connection::open(&db_path)?;
    apply_schema(&db)?;                          // numbered migrations, user_version
    let cursor = read_cursor(&db)?;              // 0 on a fresh file → full replay

    let broker = NatsBroker::connect(&nats_url).await?;   // fail-fast

    let (events_tx,  events_rx)  = mpsc::channel::<(u64, Event)>(1024);
    let (queries_tx, queries_rx) = mpsc::channel::<ViewQuery>(64);
    let (view_events_tx, _)      = broadcast::channel::<ViewEvent>(1024);

    // views: the one struct, on its own OS thread
    let views = Views::new(db, view_events_tx.clone());
    std::thread::spawn(move || views.run_blocking(events_rx, queries_rx));

    // ingest: plain async fn, worker pool
    tokio::spawn(run_ingest(broker.clone(), events_tx, cursor + 1));

    // web: axum serves frontend dist/ + /ws; each socket becomes run_session(...)
    let handle = ViewsHandle::new(queries_tx, view_events_tx);
    let app    = router(handle, broker);
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
```

## Decisions

- Components are plain functions unless they hold state across calls. `Views` (sqlite
  connection + broadcast sender) is the only struct in towerd; ingest, gateway, and
  sessions are `async fn`s taking their dependencies as arguments.
- Snapshot once at connect, `RowChanged` events after. Subscribe before snapshot.
- Reconnect = fresh session. The client re-opens its conversation with `after` = the
  latest `ts` it holds; full history travels once, ever. Boundary overlap deduped by
  `message_id`. The list is refetched whole (small).
- The viewed thing is a **Conversation** — no second noun. "Room" does not exist.
- Materialise continuously, every conversation. Opening one reads the warm view.
- Views own sqlite; event rows + JetStream cursor written in one transaction.
- Schema changes = numbered migrations (`user_version`, the CLI's migrate pattern).
  Delete-db-and-replay is manual recovery only — replay rebuilds no further back than
  stream retention, so the db outgrows "cache" as soon as it is older than retention.
- Views loop on a dedicated OS thread, not the tokio pool.
- Ingest reads through the stream only (consumer from cursor+1). Restart = reconnect = same path.
- Startup order in `main`: open db → read cursor → build consumer → spawn loops.
- Say premise = the browser's tip, forwarded verbatim. `from` = `{ kind: "human" }` bare (no auth in v1).
- Config: `NATS_URL`, `TOWER_BIND`, `TOWER_DB`.
- Shutdown = crash: transactions make them the same path.
- History depth = replay + everything folded since. `history` request stays parked.

## Testing

- `wire`: pure fold tests, inputs = the conformance fixtures in `../spec/scenarios.md`.
- Components: literal values through the seams; only fake = `Broker`.
- Integration: compose broker, scripted publisher, WS client asserts; one check.
- Frontend: against `tower-ws-spec.md` + its worked examples only.
- Fix lands twice: code + fixture, same commit.

## Out of scope v1

- Approvals surface (badge + answer).
- "Go to pane" (needs attachment telemetry).
- Mission grouping, org filtering, multiple towers.
- Auth / public serving; binds locally.
- `history` request.
