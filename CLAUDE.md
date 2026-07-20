# CLAUDE.md

Tower v1 MVP in `mvp/`: `towerd` (Rust) + `frontend/` (Svelte) rendering the
fleet's conversations by staleness — open one, read it, say into it — plus
`bridge`, the v0 agent host that serves conversations (spawn over stdio, the
messages API over SSE, the Skill tool). Hand-built, no mission machinery. The
rest of the repo is specs (live contract), the planning design corpus (see
below — not archive), and the poc.

Known follow-up: a conversation panel (Svelte and Leptos both) renders its
whole message history into the DOM, however long the conversation — some run
400+ turns. Live profiling (21 Jul) found this the real ceiling on render
cost with several panels open and streaming at once. A virtual list (render
only messages near the viewport, a spacer sized to the rest) would cap DOM
size regardless of history length; not yet designed or built.

## The documents govern

Pointers, not restatements. The doc wins where code and doc disagree;
deviations land in the doc first, then the code.

- `docs/mvp/tower-v1-design.md` — the architecture: seams, schema, decisions.
- `docs/mvp/tower-ws-spec.md` — the browser contract. The frontend builds
  against this document alone.
- `docs/spec/` — the wire contract (nats, conversation, approval, agent,
  conformance, scenarios). Normative schemas live in the specs as zod.
  Versions are per concern and coexist: conv is v2, agent and approval are
  v1 — disjoint subject trees, so old and new towers run side by side.
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

You don't have to read them all. You do have to know they exist and reach for
the right one instead of guessing.

## Rules with teeth

- Contracts are data. The only traits are `Broker` and `Clock`; components are
  plain functions unless they hold state across calls — `Views` is the only
  struct in towerd.
- `Views` owns sqlite on its dedicated OS thread. Nothing else touches the db
  file. Event rows + JetStream cursor commit in one transaction.
- Never subscribe to or capture a `.requests` subject with JetStream — the
  stream becomes a second responder (see nats-spec, Storage).
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
just dev       # towerd + vite together — the v2 stack, beside a v1 tower:
               # towerd 127.0.0.1:8081, db tower-v2.db, web localhost:5174
```

Toolchain pinned by `rust-toolchain.toml`. `just` is the verbs file; scripts
only for what cargo can't do. Config env vars: `NATS_URL`, `TOWER_BIND`,
`TOWER_DB`, `TOWER_STREAM` (towerd); `WEB_PORT` (vite); `BRIDGE_WORLD`,
`BRIDGE_MODEL`, `BRIDGE_SKILLS` (bridge — skills default to
`~/.claude/skills`, re-scanned per say: the first say commits the full
catalogue, later says a delta naming skills whose SKILL.md changed; the
stdio `skills` control line repoints the directory live).

## Testing

- `wire` folds: pure tests, inputs from `docs/spec/scenarios.md` fixtures.
- Components: literal values through the seams. The only fake is `Broker`.
- One integration check: compose broker, scripted publisher, WS client asserts.
- Fix lands twice: code + fixture, same commit.

## Dependencies

Blessed: tokio, axum, async-nats, rusqlite, serde/serde_json, anyhow,
thiserror, reqwest, uuid, yaml_serde; Svelte 5, Vite. A new dependency is a
decision — name it and why in the commit, don't reach.

## Conventions

- Commits: one imperative line, no prefixes, no trailer ceremony.
- Stage by exact path; never `git add .`/`-A`.
- Comments carry why, not what. No ceremony traits, no speculative
  abstraction — a seam appears when a second implementation exists.
- That rule is for code and design, **not database schemas**. A schema is
  the last thing to keep changing: when the future shape is known (a second
  stream, groups, layouts), key the table for it now — don't singleton it
  and migrate later.
