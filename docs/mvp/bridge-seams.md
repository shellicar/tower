# Bridge's model and entropy seams

Not yet built. This is the design for the two seams the agent loop is
missing, worked out from the behaviours that have to become testable rather
than from the code as it stands.

CLAUDE.md names ten edges that get a seam at birth. Bridge has two: `Broker`
(request handling, replay, object fetch) and `DeltaSink` (a turn's delta
stream). The agent loop itself has neither. It is about 1300 lines of
`agent.rs`: turn, tool call, tool result, approval, next turn, and nothing
tests it, because `anthropic::stream_turn` takes a live
`reqwest::Client` and talks to the real Messages API. What is tested around
it is the pure fold in `decisions.rs` and each tool on its own. The loop
that joins them is untested end to end.

Two seams close that, and they only work together. With a fake model but
real uuids you still cannot assert what was published, because every
`queryId`, `turnId`, `messageId` and approval id is minted at the point of
use: fourteen `Uuid::new_v4()` calls in `agent.rs` alone. The entropy seam
hands out the next id so a test names it in advance; the model seam decides
what the turn does. Neither is much use without the other.

PR #14 gave bridge its `Broker` seam after the fact: thirteen commits, 1202
lines added across 14 files, and it bought eleven tests. That is what a
retrofit costs here, and the cost section below is sized against it.

## The behaviours

Each one names what a test asserts and what it has to control. The traits
below were shaped to serve this list, not the other way round.

**A turn that calls a tool and comes back with its result.** Asserts the
published sequence for a two turn query: `telemetry.turn.started`,
`telemetry.turn.ended` with `stopReason: tool_use`, `telemetry.usage`, the
say committed as `changes.message`, the assistant message carrying the
`tool_use` block, `telemetry.tool.use` before the tool runs, the
`tool_result` committed as a user role message with no `from`, then a second
`turn.started` under a new `turnId`, and `changes.query` with reason
`completed`. Also asserts that the second request the model seam received
carries the first turn's assistant message and the tool result. Controls:
two scripted turns, the ids, and a tool with no ambient dependencies
(`MemoryTypes` reads only the scratch database the test config already
builds).

**A turn cancelled mid-stream.** Asserts `telemetry.turn.cancelled` carrying
the real `turnId`, `changes.query` with reason `cancelled`, and that no
`changes.message` was published at all: the say is revoked, not just the
turn, so the record is untouched. Controls: a scripted turn that stalls
forever, so the cancel arm of the select is the only one that can resolve
and the ordering is not a race.

**A cancel between rounds.** A different path, easily conflated with the
one above. The first turn's commits are already on the wire, so they stand:
the say, the assistant message and the tool result are all published, there
is no `turn.cancelled` (no turn was cancelled), and `changes.query` closes
`cancelled`. Controls: a scripted first turn that ends `tool_use`, with the
cancel flipped during the tool round.

**An approval denied, and the turn continuing.** Asserts the raise on
`approval.v1.{id}.lifecycle` with a correlation naming the conversation,
query, turn and `toolUseId`; the settle carrying the answerer's provenance
verbatim; a `tool_result` of `denied by {from}` with `is_error: true`; that
the next request the model seam received carries that tool result; and that
the query still closes `completed`. Controls: the permission matrix set to
ask, a scripted answer seeded on `approval.v1.{approval_id}.requests`, and
the ids. This behaviour is the clearest argument for the entropy seam:
seeding that subject means knowing the approval id before the code mints
it, which is impossible today.

**A stream that dies half way through.** Two shapes, and they behave
differently. A read failure part way through aborts the turn:
`telemetry.turn.aborted`, `changes.query` reason `aborted`, record
untouched. A clean end of stream with no `message_delta` does something
else, and this is worth pinning because it looks like a bug: `stop_reason`
is seeded `end_turn` and never overwritten, so bridge commits the truncated
assistant message and closes the query `completed`. A caller reading the
record cannot tell it from a turn that finished. The test pins today's
behaviour and makes the question askable. Controls: a scripted turn whose
frame list ends early, and one that yields a read error.

**A turn that stops because it hit max tokens.** Asserts `turn.ended`
carries `stopReason: max_tokens` verbatim (the spec is explicit that the
service's word passes through unsynthesised), the assistant message commits,
and `changes.query` closes `completed`: the servicer ran its last round and
chose not to run another, which is what `completed` means in
conversation.md. Controls: a scripted `message_delta` with that stop reason.

**A say that resumes a record ending on a dangling tool_use.** Asserts the
request itself: the last user message leads with one `tool_result` per
dangling `tool_use` id, each `is_error: true` with the abandoned text, and
carries no empty text block when the say had no text. Controls: an adopted
`Conversation` ending on an assistant message with an unanswered `tool_use`,
an empty say, and a seam that records what it was asked. This is only
visible at the model seam; nothing else in the process can see it.

**A tool the model was never offered.** Asserts `telemetry.tool.use` is
still published (the action is observed before it is judged), the result is
`unknown tool "X"` with `is_error: true`, and the loop continues to the next
turn. The offered set is the only enforcement disabling a tool has, and
nothing proves it holds. Controls: a scripted `tool_use` block naming a tool
absent from the offered list.

**A tool_use whose input never parses.** The accumulated `partial_json` is
malformed, so the block keeps its seeded input and the committed message
stays well formed and sendable. Controls: scripted `input_json_delta` chunks
that do not parse.

**Deltas reach the wire in order.** Asserts on `conv.v2.{id}.deltas`: a
`block` marker per block start carrying its `blockType`, then a plain
`delta` per chunk, with text, thinking and `partial_json` all flattened to
`{ type: "delta", text }`. Controls: a scripted mix of block types and a
delta sink that records.

**The request carries what the settings say.** Thinking off sends
`thinking: { type: "disabled" }` and no `output_config`; thinking on sends
`{ type: "adaptive", display: "summarized" }` plus
`output_config: { effort }`; `max_tokens` is the configured number.
Asserted twice: at the seam, that the settings reach the request, and as a
pure test over the body builder, that the request becomes the right JSON.

**Usage passes through what the service reported.** The 5m and 1h cache
creation split lands on `telemetry.usage` unchanged. Small, but people read
those fields to work out what a conversation cost, and nothing checks them.

## The two traits

Both live in the lib target (`bridge::model`, `bridge::ids`) for the reason
`bridge::broker` does: a fake that lives in `bridge-testkit` can only
implement a trait the lib exposes. `DeltaSink` sits in the binary and that
is exactly why its only fake is the no-op one in `anthropic.rs`.

### Model

```rust
/// The model API edge. One call opens one turn's stream. Nothing about
/// transport, credentials, or how the answer is published crosses here:
/// those belong to the implementation and to the caller respectively.
pub trait Model: Clone + Send + Sync + 'static {
    type Stream: ModelStream;

    fn stream(
        &self,
        request: ModelRequest,
    ) -> impl Future<Output = Result<Self::Stream, ModelError>> + Send;
}

/// One turn's events in arrival order. `None` ends the stream, and an end
/// is not a success: a stream that stops before its `message_delta` was
/// truncated, and the caller decides what that means. A read that fails
/// says so and is never folded into "the stream ended", the same
/// distinction `BrokerReplay` draws for a replay.
pub trait ModelStream: Send {
    fn next(
        &mut self,
    ) -> impl Future<Output = Option<Result<StreamEvent, ModelError>>> + Send;
}
```

The request. `system` is the spawn's own prompt alone: the Agent SDK
identity block that subscription access requires, the cache breakpoints, and
the mapping of settings onto wire fields are the implementation's business,
tested as a pure function over the body it builds.

```rust
pub struct ModelRequest {
    pub model: String,
    pub system: Option<String>,
    pub messages: Vec<Value>,
    pub tools: Vec<Value>,
    pub settings: ModelSettings,
}

/// Read once at the composition root and carried as data. Shaped like
/// claude-sdk-cli's own config rather than the request body: a token
/// ceiling and a thinking switch with an effort level, never a token
/// budget.
pub struct ModelSettings {
    pub max_tokens: i64,
    pub thinking: Thinking,
}

pub struct Thinking {
    pub enabled: bool,
    pub effort: Effort,
}

/// The Messages API's effort levels, the set claude-sdk-cli offers.
pub enum Effort {
    Max,
    XHigh,
    High,
    Medium,
    Low,
}
```

The events. One variant per event the loop acts on; everything else arrives
as `Other` and is ignored, so a new event type on the wire is never an error
(`ping` and `content_block_stop` already land there).

```rust
pub enum StreamEvent {
    MessageStart {
        usage: Usage,
    },
    /// The content block as sent, verbatim: it is the seed the committed
    /// block grows from, and typing the API's content block union here
    /// would duplicate it for no gain.
    BlockStart {
        block: Value,
    },
    BlockDelta {
        delta: Delta,
    },
    MessageDelta {
        stop_reason: Option<String>,
        output_tokens: Option<i64>,
    },
    Other(Value),
}

pub enum Delta {
    Text(String),
    Thinking(String),
    InputJson(String),
    Signature(String),
    Other(Value),
}

/// What `message_start` reports. `output_tokens` arrives later, on
/// `message_delta`, and is deliberately not here.
#[derive(Default)]
pub struct Usage {
    pub input_tokens: i64,
    pub cache_creation_tokens: i64,
    pub cache_creation_5m_tokens: i64,
    pub cache_creation_1h_tokens: i64,
    pub cache_read_tokens: i64,
}

#[derive(Debug, thiserror::Error)]
pub enum ModelError {
    #[error("the request never reached the messages API")]
    Transport(#[source] Box<dyn std::error::Error + Send + Sync>),
    #[error("messages API returned {status}: {body}")]
    Status { status: u16, body: String },
    #[error("the stream failed part way through")]
    StreamRead(#[source] Box<dyn std::error::Error + Send + Sync>),
    #[error("the service reported a stream error: {detail}")]
    Service { detail: String },
}
```

The service's own `error` frame surfaces as `ModelError::Service`, not as a
`StreamEvent` variant, so the caller has one place to handle failure instead
of two.

### Ids

```rust
/// Entropy. One synchronous method, which makes this the one seam here
/// that can be a trait object: `Arc<dyn Ids>` is a field, not a generic
/// parameter, so it costs nothing in any signature.
pub trait Ids: Send + Sync {
    fn next(&self) -> String;
}

pub struct UuidIds;

impl Ids for UuidIds {
    fn next(&self) -> String {
        uuid::Uuid::new_v4().to_string()
    }
}
```

One undifferentiated sequence, not `next(IdKind::Turn)`. The kind-tagged
form reads better in a fake's output and survives reordering, but surviving
reordering is the wrong property: the order ids are minted in is part of
what a test should pin, and a kinded fake would let a reordering pass
unnoticed.

## The fakes

Both in `bridge-testkit`, beside `FakeBroker`.

```rust
/// Scripted turns, taken in order, and every request recorded. The record
/// is not a convenience: several behaviours are visible nowhere else.
#[derive(Clone, Default)]
pub struct FakeModel {
    pub requests: Arc<Mutex<Vec<ModelRequest>>>,
    pub turns: Arc<Mutex<VecDeque<Vec<Frame>>>>,
}

/// One scripted step. Running off the end of a turn's frames ends the
/// stream, which is how a test writes a truncated turn: it simply stops
/// listing frames.
pub enum Frame {
    Event(StreamEvent),
    /// A read failure part way through.
    Fail(String),
    /// Never yields. A turn that stalls lets a test cancel with no
    /// synchronisation at all, because the cancel arm of the select is
    /// then the only one that can resolve. Same trick as
    /// `FakeSubscription::stay_open`.
    Stall,
}
```

A `stream` call with no turn left scripted panics naming the request, the
same discipline `FakeBroker::replay` uses for an unseeded filter: a test
that drives one more turn than it scripted must fail, not pass vacuously
against an empty stream.

```rust
/// Hands out the ids a test named, in order. Exhaustion panics rather than
/// falling back to a fresh uuid: a test that mints more ids than it named
/// is asserting against values it never chose.
#[derive(Clone)]
pub struct FakeIds(Arc<Mutex<VecDeque<String>>>);
```

How a test drives them, taking the denied approval as the worked case:

```rust
let ids = FakeIds::new(["q1", "t1", "m-say", "m-turn1", "appr-1", "m-tools", "t2", "m-turn2"]);
let model = FakeModel::new([
    // Turn 1: the model asks for a tool.
    vec![
        Frame::Event(StreamEvent::MessageStart { usage: Usage::default() }),
        Frame::Event(StreamEvent::BlockStart {
            block: json!({ "type": "tool_use", "id": "toolu_1", "name": "Delete", "input": {} }),
        }),
        Frame::Event(StreamEvent::BlockDelta {
            delta: Delta::InputJson(r#"{"paths":["/tmp/x"]}"#.into()),
        }),
        Frame::Event(StreamEvent::MessageDelta {
            stop_reason: Some("tool_use".into()),
            output_tokens: Some(12),
        }),
    ],
    // Turn 2: having seen the denial, it stops.
    vec![
        Frame::Event(StreamEvent::MessageStart { usage: Usage::default() }),
        Frame::Event(StreamEvent::BlockStart { block: json!({ "type": "text", "text": "" }) }),
        Frame::Event(StreamEvent::BlockDelta { delta: Delta::Text("understood".into()) }),
        Frame::Event(StreamEvent::MessageDelta {
            stop_reason: Some("end_turn".into()),
            output_tokens: Some(4),
        }),
    ],
]);
// The approval id is `appr-1` before a line of the loop runs, so the
// answer can be seeded on the subject the gate will subscribe to.
broker.seed_subscribe("approval.v1.appr-1.requests", [answer(false, human("stephen"))]);
```

The assertions then read off `broker.published` and `model.requests`: the
settle event, the `denied by` tool result, and that request 2's last message
carries it.

## What it costs

Bigger than it looks, and most of it is not the seams themselves.

**Generic parameters.** `Model` is async, so like `Broker` and `DeltaSink`
it has to be a generic parameter, not a trait object. Sixteen declarations
gain one:

- `agent.rs`: `AgentConfig`, `run`, `accept_say`, `TurnContext`, `run_query`
- `main.rs`: `Host` and its `impl`, `serve_conversation`, `serve_claimed`,
  `serve_subscribed`, `handle_service`, `serve_agent_requests`,
  `serve_agent_requests_once`, `handle_line`
- `testsupport.rs`: `config`, `host`

`Ids` adds none, because it rides as `Arc<dyn Ids>`. That difference is
worth about a dozen signatures on its own, and it is the reason to keep
entropy synchronous even if a future implementation is tempted otherwise.

**Call sites that move.** Fourteen `Uuid::new_v4()` calls in `agent.rs`
become `ids.next()`: three in `accept_say` (query, turn, the say's message
id), three in `run_query` (the assistant message, the tool result message,
the next turn id), eight approval ids in `run_tool_round`. `run_tool_round`
takes an `&Arc<dyn Ids>` on top of its twelve existing arguments. Two more
in `main.rs` (the conversation id at spawn, the instance id at boot) are the
same seam and should move with it; the ones in `memory.rs`, `attach.rs` and
the tools' own tests are behind other boundaries and stay.

Test call sites should not move at all, and that is a design constraint, not
a hope: both seams ride in `AgentConfig` and `Host` rather than as new
positional parameters, so `testsupport::config` and `testsupport::host`
absorb them and the twenty-five existing tests in `main.rs` and `agent.rs`
compile unchanged. `DeltaSink` being a positional parameter today is the
inconsistency, and it is not worth fixing in the same change.

**anthropic.rs.** `stream_turn` is about 200 lines doing four jobs at once,
and it splits into three, of which only one is behind the seam:

1. `build_body(&ModelRequest) -> Value`, pure. The identity system block,
   the two cache breakpoints, and the thinking mapping. The five existing
   `mark_message_cache_breakpoint` tests survive untouched, which matters:
   they encode a live bug about cache control on empty text blocks.
2. `AnthropicModel::stream`, the real implementation. POST, auth, status
   check, and the SSE frame parser. The frame splitter comes out as its own
   pure function, so the `event:`/`data:` handling gets literal-value tests
   for the first time.
3. `fold_turn`, the event fold: blocks accumulate, deltas publish and tee,
   usage tallies, `TurnDone` comes out. This is what every new test drives.

`MAX_TOKENS` goes. `Auth`, `build_http_client`, `oauth_token` and
`refresh_credentials` move behind `AnthropicModel`'s constructor, and
`AgentConfig.auth`, `AgentConfig.http`, `Host.auth` and `Host.http`
disappear with them.

**agent.rs.** `run_query`'s `stream_turn` call becomes a `model.stream`
call plus a `fold_turn` call, and the `tokio::select!` that races cancel
against the turn keeps the same shape. `telemetry.turn.started` loses
`anthropic::MAX_TOKENS` in favour of `settings.max_tokens` and gains
`effort`, which `docs/spec/conversation.md` and `wire::TurnStarted` already
define as optional and bridge has never sent. No spec change is needed for
that.

**Configuration, and this one leaves the crate.** `thinking_budget:
Option<i64>` becomes `ModelSettings`. `BRIDGE_THINKING_BUDGET` is replaced,
which touches `CLAUDE.md`'s env list and the env table in
`docs/mvp/bridge-stdio-spec.md`, and the `settings` control line's
`thinkingBudget` field changes shape. The stdio spec is a contract, so under
CLAUDE.md's rule that change rides its own PR ahead of the code.

**What the seams do not buy.** `now_iso()` is still ambient: every payload
carries a `ts` nobody can predict, so assertions stay field-wise and no test
can compare a whole published body. Time is a named edge with no seam in
bridge, and it is the next one, not part of this.

## Open

- Whether a clean end of stream with no `message_delta` should abort the
  turn rather than commit a truncated message as `end_turn`. The test above
  pins what happens today; the decision is not made here.
- Whether `DeltaSink` should move to the lib target so a recording sink can
  live in `bridge-testkit`. Cheaper for now: put one beside `NoopDeltaSink`
  under `cfg(test)`.
- Whether `effort` belongs on the conversation as well as the instance. It
  is an instance fact today, like the model, and `turn.started` states what
  served each turn, which is enough.
