# CLAUDE.md

Tower v1 MVP: `towerd` (Rust) + `frontend/` (Svelte) rendering the fleet's
conversations by staleness — open one, read it, say into it. Hand-built in
`mvp/`, no mission machinery. The rest of the repo is specs (live contract),
planning archives, and the poc.

## The documents govern

Pointers, not restatements. The doc wins where code and doc disagree;
deviations land in the doc first, then the code.

- `docs/mvp/tower-v1-design.md` — the architecture: seams, schema, decisions.
- `docs/mvp/tower-ws-spec.md` — the browser contract. The frontend builds
  against this document alone.
- `docs/spec/` — the wire contract (nats, conversation, approval, conformance,
  scenarios). Normative schemas live in the specs as zod.
- `docs/roadmap.md` — where this sits. `docs/planning/` is archive: read for
  history, never maintain.

## Rules with teeth

- Contracts are data. The only traits are `Broker` and `Clock`; components are
  plain functions unless they hold state across calls — `Views` is the only
  struct in towerd.
- `Views` owns sqlite on its dedicated OS thread. Nothing else touches the db
  file. Event rows + JetStream cursor commit in one transaction.
- Never subscribe to or capture a `.requests` subject with JetStream — the
  stream becomes a second responder (see nats-spec, Storage).
- Tolerance everywhere: unknown types/fields/enum values are represented
  states (`Unknown`, `Other(String)`), never errors. Serde: no
  `deny_unknown_fields`; open enums via an untagged fallback variant.
- Every message carries the id triple: `messageId`, `turnId`, `queryId`.
- The viewed thing is a **Conversation**. "Room" is banned vocabulary.
- `from` is provenance: forwarded verbatim, `{ kind: "human" }` bare for the
  UI's own says, never fabricated.
- Staleness is the product: `row` events are unconditional; `open` gates
  content only, any number open.

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
cd mvp/frontend && pnpm dev # vite; pnpm build → dist/ served by towerd
```

Toolchain pinned by `rust-toolchain.toml`. `just` is the verbs file; scripts
only for what cargo can't do. Config env vars: `NATS_URL`, `TOWER_BIND`,
`TOWER_DB`.

## Testing

- `wire` folds: pure tests, inputs from `docs/spec/scenarios.md` fixtures.
- Components: literal values through the seams. The only fake is `Broker`.
- One integration check: compose broker, scripted publisher, WS client asserts.
- Fix lands twice: code + fixture, same commit.

## Dependencies

Blessed: tokio, axum, async-nats, rusqlite, serde/serde_json, anyhow,
thiserror; Svelte 5, Vite. A new dependency is a decision — name it and why in
the commit, don't reach.

## Conventions

- Commits: one imperative line, no prefixes, no trailer ceremony.
- Stage by exact path; never `git add .`/`-A`.
- Comments carry why, not what. No ceremony traits, no speculative
  abstraction — a seam appears when a second implementation exists.
- That rule is for code and design, **not database schemas**. A schema is
  the last thing to keep changing: when the future shape is known (a second
  stream, groups, layouts), key the table for it now — don't singleton it
  and migrate later.
