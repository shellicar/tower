# CLAUDE.md

Tower v1 MVP in `mvp/`: `towerd` (Rust) + `frontend-svelte/` (Svelte) rendering the
fleet's conversations by staleness — open one, read it, say into it — plus
`bridge`, the v0 agent host that serves conversations (spawn over stdio, the
messages API over SSE, the Skill tool), and `helm`, the single-conversation
terminal client that spawns its own bridge. Hand-built, no mission machinery.
The rest of the repo is specs (live contract), the planning design corpus (see
below — not archive), and the poc.

`frontend-leptos/` is a second, comparison build of the same browser client
(docs/mvp/frontend-leptos-plan.md, frontend-comparison-leptos.md) — DOM-based
Rust/Leptos against the wire alone (`docs/mvp/tower-ws-spec.md`), isolating
what a Rust renderer buys over Svelte. It is not a lagging prototype: the two
track ONE feature set. A change to what a conversation panel shows or does
(a new usage-line field, an attachment affordance, a status badge) lands in
both `frontend-svelte/` and `frontend-leptos/` in the same piece of work — whichever
you build first, port it to the other before calling the work done. Wire
shape and bridge/towerd behaviour are shared already (both read the same
WS contract); only the two renderings can drift, and drift is the bug.

The Svelte frontend's message list is a windowed virtual list
(VirtualList.svelte) with pre-mount height prediction for plain-text
messages (core/textHeight.ts, via @chenglou/pretext). The prediction is
exact-most-of-the-time, not exact: verified line-by-line against Chrome
(22 Jul), pretext occasionally disagrees with the engine about whether one
more word fits at a wrap boundary — off by a line on some messages, and
engine behaviour drifts across browser versions. The mounted row's
ResizeObserver correction is load-bearing for exactly this; never remove
it on the argument that the prediction is accurate. Leptos has the windowed
virtual list (keyed `<For>`, height cache, spacers, per-row ResizeObserver —
same technique, ported) but no height prediction yet; when that ports, canvas
measureText comes via web-sys, but pretext's line-breaking logic would need a
port (gpui-pretext on crates.io claims to be one — unverified).

## The documents govern

Pointers, not restatements. The doc wins where code and doc disagree;
deviations land in the doc first, then the code.

- `docs/mvp/tower-v1-design.md` — the architecture: seams, schema, decisions.
- `docs/mvp/tower-ws-spec.md` — the browser contract. The frontend builds
  against this document alone.
- `docs/spec/` — the wire contract (core, nats, conversation, approval,
  agent, content, conformance, scenarios); `docs/spec/README.md` indexes it.
  Normative schemas live in the specs as zod. Versions are per concern and
  coexist: conv is v2, agent and approval are v1 — disjoint subject trees, so
  old and new towers run side by side.
- `docs/roadmap.md` — where this sits. `docs/glossary.md` — the vocabulary.
- `docs/planning/` — the design corpus. NOT mere archive: it holds the answers
  you'd otherwise guess. Reach here BEFORE answering any "gap to
  claude-sdk-cli" or "what should the agent do" question. Key ones:
  `feature-comparison.md` (claude-sdk-cli vs the MVP — the gap, with the
  must/want/NO scope), `sdk-feature-inventory.md`, `sdk-shape.md`,
  `tool-philosophy.md`, `sdk-tools.md`, `cli-features.md` (the SDK/agent
  reference), `code-architecture.md`, `orchestration-layer.md`,
  `multi-transport-architecture.md`, `tui-architecture.md`, `project-state.md`.
  Don't maintain it; don't guess past it either.
- A change to the wire contract (`docs/spec/`) rides its own PR, never bundled
  with code. One owner per document per change; implementation PRs build to
  merged spec text. Every other document, this file included, changes in the
  same PR as the code it describes.

You don't have to read them all. You do have to know they exist and reach for
the right one instead of guessing.

## Rules with teeth

- Contracts are data. The only traits are `Broker` and `Clock`; components are
  plain functions unless they hold state across calls — `Views` is the only
  struct in towerd.
- `Views` owns sqlite on its dedicated OS thread. Nothing else touches the db
  file. Event rows + JetStream cursor commit in one transaction.
- Never subscribe to or capture a `.requests` subject with JetStream — the
  stream becomes a second responder (see nats.md, Storage).
- A message's type is stated exactly once. Routing axis → the subject leaf
  spells it (`conv.v2.{id}.changes.tip.moved`) and the body carries no
  `type`; a deliberately flat subject (conv `deltas`, approval) keeps its
  body `type` — that is correct, not redundant. Duplication is the sin.
- Liveness is a fold, never declared. towerd stores agent facts (instances,
  attachments); alive/released/stranded is the client's derivation from
  `lastPulse` against its own clock — no verdict column, no server tick.
  Agent facts never touch `rows`: staleness is conversation activity.
- Existence is a union: an attached-but-message-less conversation is a
  potential conversation — shown while the attachment lives, gone with it;
  the first committed message births the ordinary row.
- Tolerance everywhere: unknown types/fields/enum values are represented
  states (`Unknown`, `Other(String)`), never errors. Serde: no
  `deny_unknown_fields`; open enums via an untagged fallback variant.
- Every message carries the id triple: `messageId`, `turnId`, `queryId`.
- The viewed thing is a **Conversation**. "Room" is banned vocabulary.
- `from` is provenance: forwarded verbatim, `{ kind: "human" }` bare for the
  UI's own says, never fabricated.
- Staleness is the product: `row` events are unconditional; `open` gates
  content only, any number open.
- Errors: the cause rides `#[source]` only — an `#[error("...")]` message
  never repeats the cause's text (chain-walkers like anyhow's `{:#}` would
  print it twice). Anywhere an error is logged or shown renders the full
  chain via `{:#}` (for an owned error: `eprintln!("{:#}", anyhow::Error::new(e))`);
  a bare `{e}` on an error type drops the cause and is a bug. One test pins
  that a rendered chain names its underlying cause.

## Workload facts (measured, not assumed)

LLM conversations are the opposite shape of chat-room chat:

- **Message count is low.** Max observed ~2,300 messages per conversation
  (audit jsonl line counts); typical far less. O(n) over messages is
  microseconds; no algorithm here needs to be clever about count.
- **Message content is large, and the bulk is binary.** Measured across
  2,196 conversations / 206k messages: raw maxima are 17.8 MB (tool result)
  and 3.1 MB (user message) — but only 326 messages carry base64 (images,
  PDFs), and with base64 stripped the maxima are **513 KB** (tool result),
  **240 KB** (user), **245 KB** (assistant). Text tops out around half a MB;
  everything above that is blob payload.
- **What that licenses and forces:** per-message collapsing (tool results,
  thinking, long blocks folded to summary lines) is the primary render
  lever; virtualisation earns its keep on bytes-per-node, not node count.
- **Weight ships as refs.** towerd externalises heavy values at apply time
  into content-addressed `refs`, replaced in place by
  `{ "$ref": id, "size", "hint" }`. v1 applies it at four fixed nodes:
  `image.source`, `document.source`, `tool_result.content`, and oversized
  (~16 KB+) values in `tool_use.input` (input is unbounded — a large
  generated document is all input). The shape is position-agnostic; clients handle a
  `$ref` at any node; new nodes are add-only. Opaque id, never a URL: the
  client builds the fetch (`GET /ref/{id}`, Range for paging) from its own
  API knowledge. The WS never carries megabytes. Interim — the real split
  lands at the CLI level eventually (content vocabulary).

## Build and verify

```sh
just build     # cargo build --workspace (mvp/)
just test      # cargo test --workspace
just check     # cargo clippy + fmt --check
docker compose up -d        # broker + stream-init (event subjects only)
just dev       # towerd + BOTH frontends, hot reload, beside a v1 tower:
               # towerd 127.0.0.1:8081 (svelte dist) + 8083 (leptos dist),
               # db tower-v2.db, vite localhost:5174, trunk localhost:8082
```

Toolchain pinned by `rust-toolchain.toml`. `just` is the verbs file; scripts
only for what cargo can't do. Config env vars — towerd: `NATS_URL`,
`TOWER_BIND`, `TOWER_BIND_LEPTOS`, `TOWER_DIST`, `TOWER_DIST_LEPTOS`,
`TOWER_DB`, `TOWER_STREAM_AUDIT`, `TOWER_STREAM_DIAGNOSTIC`,
`TOWER_STREAM_EPHEMERAL`, `TOWER_ATTACH_BUCKET`, `TOWER_ATTACH_TTL_S`;
vite: `WEB_PORT`; bridge: `NATS_URL`, `BRIDGE_WORLD`,
`BRIDGE_STREAM`, `BRIDGE_STREAM_EPHEMERAL`, `BRIDGE_ATTACH_BUCKET`,
`BRIDGE_REFS_DB`, `BRIDGE_MEMORY_DB`, `BRIDGE_HISTORY_DB`
(skills has no env var and no default: the directory is empty until a stdio
`skills` control line sets it, re-scanned per say — the first say commits the
full catalogue, later says a delta naming skills whose SKILL.md changed; the
same control line repoints it live).

The model has no env var and no default either. A `model` control line
carries name, maxTokens, thinking, thinkingDisplay and effort; it MERGES
rather than replacing, and until it names a model and a maxTokens bridge
refuses to serve a conversation (`no_model`). Adaptive thinking, not a
budget: the legacy `{"type":"enabled","budget_tokens":N}` shape produces
worse thinking and is gone. docs/mvp/bridge-stdio-spec.md holds the rest.

## helm

The terminal client (`mvp/crates/helm`): one bridge, spawned as a child,
dialed over two inheritable OS pipes (`BRIDGE_ATTACH_FD_DOWN`/
`BRIDGE_ATTACH_FD_UP` — stdio keeps the control protocol untouched). The pair
is one-way each: events and replies flow down (`{subject,payload}` / `{id,payload}`), requests and
uploads flow up (`{id,subject,payload}` / `{id,upload}`) and bridge proxies
them onto NATS — helm is genuinely NATS-less; the broker is bridge's concern
alone. Bridge's lifetime is its stdin: helm dies, bridge exits. Internal shape mirrors
`frontend-svelte/src/lib/concerns/` — transport owns the wire, conversation /
usage / approvals / editor are self-contained folds, fixture-tested; ratatui
owns present/platform, `view.rs` wraps in-house so every visual row maps to
its block (that's what makes click hit-testing exact).

```sh
HELM_BRIDGE_PATH=./target/debug/bridge cargo run -p helm
```

Env: `HELM_BRIDGE_PATH`, `HELM_BRIDGE_LOG` (bridge stderr, default
`/tmp/helm-bridge.log`), `HELM_EMOJI`.

## Seams

Edges get their seam at birth. An edge is anywhere the code meets what a
test cannot control from inside the process. At an edge, the fake is a
known second implementation, not speculation — it exists the day the first
test is owed, which is day one. Retrofitting a seam costs more than a
rewrite (learned on the bridge broker seam, PR #14); building with one
costs nothing. A seam is whatever makes the edge controllable — a trait
only when needed: a connection, a path, or a plain value passed in counts.

The edges:

- **network/broker**: NATS pub/sub, request/reply, JetStream replay, object store
- **time**: clocks, timers, intervals, timeouts
- **filesystem**: reads, writes, watched dirs (skills)
- **databases**: an in-memory provider is the fake (sqlite `:memory:`); the
  real file-backed db appears only in tests that need what only it has —
  WAL, cross-connection visibility, the file itself
- **child processes**: tool exec, spawned bridges, ptys, clipboard helpers
- **model APIs**: the Anthropic SSE client, any future provider
- **entropy**: uuid/instance-id minting
- **ambient env**: read once at the composition root into config passed as
  data — never at call sites
- **cwd**: data threaded to where it's used, never process state (learned in #7)
- **terminal**: stdin/stdout, the TUI surface

Above the edges, no ceremony: no reflexive traits over your own logic —
three similar lines beat a premature abstraction. Abstraction there is a
decision made in the brief, never invented by the operator.

## Testing

- `wire` folds: pure tests, inputs from `docs/spec/scenarios.md` fixtures.
- Components: literal values through the seams. The only fake is `Broker`.
- One integration check: compose broker, scripted publisher, WS client asserts.
- Fix lands twice: code + fixture, same commit.

## Dependencies

Blessed: tokio, axum, async-nats, rusqlite, serde/serde_json, anyhow,
thiserror, reqwest, uuid, yaml_serde; ratatui + crossterm (helm only);
Svelte 5, Vite. A new dependency is a decision — name it and why in the
commit, don't reach.

## Conventions

- Commits: one imperative line, no prefixes, no trailer ceremony.
- Stage by exact path; never `git add .`/`-A`.
- Comments carry why, not what. Abstraction discipline lives in the Seams
  section: edges seamed at birth, no ceremony above them.
- Errors: the cause rides `#[source]` only — an `#[error("...")]` message
  never repeats it (chain-walkers would print it twice). Anything logged or
  shown renders the chain via anyhow's `{:#}` (wrap an owned error:
  `eprintln!("{:#}", anyhow::Error::new(e))`); a bare `{e}` on an error type
  drops the cause and is a bug. One test pins that a rendered chain names
  its underlying cause.
- The no-premature-abstraction rule is for code and design, **not database
  schemas**. A schema is
  the last thing to keep changing: when the future shape is known (a second
  stream, groups, layouts), key the table for it now — don't singleton it
  and migrate later.
