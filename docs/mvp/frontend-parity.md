# Frontend parity — Svelte vs Leptos

Living gap list between `mvp/frontend` (Svelte) and `mvp/frontend-leptos`
(Rust/Leptos). CLAUDE.md's rule is that the two track one feature set; this
doc is how that rule gets enforced when it's violated — each gap here is
precise enough to hand to a session as a porting task on its own. Cross items
off (`[x]`) as they close; don't rewrite the doc, update it.

Method: walked `docs/mvp/tower-ws-spec.md` frame by frame (does each side
parse it, fold it, render it, act on it), then the component surface (panel,
rail, approvals, tabs/view, composer, usage line, unread/stale, title/tag
editing, attachments, refs), reading both concern layers (`lib/concerns/*.svelte.ts`
vs `src/concerns/*.rs`) and both render layers (`lib/*.svelte` vs `src/ui/*.rs`)
side by side. Derived from code, not from any prior claim about what's missing.

## Coverage checklist (this doc's own progress, not the gaps)

- [x] WS contract — client→towerd messages (types only; behavioural coverage per-concern below)
- [x] WS contract — towerd→client frames (types only; behavioural coverage per-concern below)
- [x] Refs mechanism — parity, covered by refview
- [x] Attachments HTTP mechanism — gap found (`bucket` field)
- [x] Concern: transport (connection lifecycle, reconnect, request/response) — gap found (reconnect)
- [x] Concern: rail (rows, staleness, tags/titles, potential conversations) — parity
- [x] Concern: conversation (messages, streaming, queryState, pendingSay) — parity, `can_send`/composer gating logic matches
- [x] Concern: approvals — parity
- [x] Concern: usage — parity
- [x] Concern: view (tabs, layout, ViewConfig persistence) — parity
- [x] Component: conversation panel render (blocks, markdown, virtual list, composer, scroll-anchor) — gaps found
- [x] Component: rail render (RowList vs ui/rail.rs — tag filter/group UI) — parity
- [x] Component: approvals view — parity
- [x] Component: unread/stale view — parity
- [x] Component: refview — parity
- [x] Component: attachments (upload, dismiss) — gap found (upload); dismiss covered under rail, parity
- [x] Cross-cutting: tolerance, clock injection — spot-checked, no gap found
- [x] Porting order

## Gaps found

### Transport / connection lifecycle

- [ ] **Leptos never reconnects after the socket closes.** `frontend-leptos/src/transport.rs`'s wasm read loop
  (`while let Some(msg) = read.next().await`) sets `Status::Closed` when the stream ends and the async task
  simply finishes — nothing calls `Transport::connect` again. Svelte's `transport.svelte.ts` reconnects on
  every `onclose` with exponential backoff (500ms, doubling, capped at 10s) via `setTimeout(() => this.connect(), retryMs)`.
  A dropped Leptos connection today is permanent until the page is reloaded by hand. Porting task: add a
  reconnect loop around `wasm::Transport::connect` in `app.rs` (or inside `transport.rs`), same backoff shape,
  re-running the composition root's existing `sync_open`-on-reconnect effect (already correct — it re-fires
  because `Layout`/`List` land as ordinary events on any fresh connection).

### WS contract — wire-type coverage (both sides, informational)

- Both `mvp/frontend/src/lib/types.ts` and `mvp/crates/ws-types/src/lib.rs` are in sync with each other and
  cover the full frame set actually in use: `layout`/`set_layout`/`layout_set`, `dismiss_approval`/
  `dismiss_attachment`/`attachment_dismissed`, `stale_conversations`/`stale_conversation` are present in both —
  no wire-type drift between the two frontends. **Not a gap.**
- `docs/mvp/tower-ws-spec.md` itself does not document any of those frames (tabs/layout, dismiss, stale/unread) —
  the doc is stale relative to both frontends' code. Outside this doc's scope (it compares the two frontends,
  not frontend-vs-doc), but worth a separate note to the SC since the task brief assumed the doc was current.

### Tag editing — dead code on both sides, not a drift item

- `Rail.setTag()` (`rail.svelte.ts`) sends `set_tag` and optimistically patches the row; the wire type exists
  on both sides (`ClientMsg::SetTag` / `{ type: 'set_tag' }`). But **no Svelte component ever calls it** — grepped
  every `.svelte`/`.ts` file for `.setTag(`, zero call sites. Leptos's `Rail` (`rail.rs`) has no `set_tag`
  method at all, and `ui/rail.rs` only reads tags (`tag_of`, `tag_keys()`) for filter/group/chip display, never
  writes one. So tag *editing* is unwired plumbing on the Svelte side and entirely absent on the Leptos side —
  equally missing as a user-facing feature on both. Not a porting task (nothing to port from); flagged so a
  future "add tag editing" task starts from an accurate baseline instead of assuming Svelte has it.

### Conversation panel render

- [ ] **No virtual list / windowing in Leptos.** `ui/conversation.rs`'s `.messages` div renders every message in
  `oc.messages` on every render (`.into_iter().map(...).collect_view()`), unwindowed. Svelte's `ConversationPanel.svelte`
  renders through `VirtualList.svelte` (windowed, spacer-before/after, per-id height cache). This is the memory-flagged
  drift (virtual list landed in Svelte only, 21 Jul, `947c41a`). Porting task: port `VirtualList.svelte`'s technique to
  a Leptos component — keyed `<For>`, a height cache (`HashMap<String, f64>` keyed by message id), spacer elements,
  `ResizeObserver` per mounted row via `web_sys`. Do this before the height-prediction port below, since prediction is
  an optimisation *on top of* windowing, not a substitute for it — windowing is the part that actually bounds DOM size.

- [ ] **No canvas height-prediction ("pretext") in Leptos**, i.e. nothing to port yet since windowing itself isn't
  there. Once windowing lands, `core/textHeight.ts`'s technique (canvas `measureText`, monospace-only fast path for
  plain-text messages, `ResizeObserver` correction as the load-bearing fallback — never remove it, see memory
  `666f3737-6eb4-4112-bc7c-601b5af73853`) ports via `web-sys`'s `CanvasRenderingContext2d::measure_text`. Do NOT
  reach for `gpui-pretext` (crates.io) as a drop-in — it's an unverified, single-version, unaffiliated claim of a
  pretext port; if it's used, run the same line-diff verification (compare against real `Range.getClientRects()`
  output) that found pretext's own wrap-boundary divergence from Chrome before trusting it.

- [ ] **No markdown rendering for assistant text in Leptos.** `ui/block.rs`'s `render_block` renders every `text`
  block as a plain `<div>{text}</div>`, regardless of role. Svelte's `BlockView.svelte` renders assistant-role text
  through `MarkdownRenderer.svelte` (`core/markdown.ts`: `marked` v18 + `DOMPurify.sanitize`, GFM+breaks on, links
  forced `target=_blank rel=noopener`); user/tool text stays raw. Porting task: bring in a Rust markdown renderer
  (e.g. `pulldown-cmark`) plus an HTML sanitizer for the wasm target, thread a `markdown: bool` (or `role`) through
  `render_block` the way `BlockView` threads its `markdown` prop, gate it the same way (`role == "assistant"`), and
  keep the same link-safety behaviour (`target="_blank" rel="noopener"`, no raw `javascript:`/`<script>` survival —
  Svelte's `markdown.test.ts` has three hostile-payload tests worth porting verbatim as the acceptance check).

- [ ] **Re-verify: the scroll-anchor / approval-card bug may now also affect Leptos.** Memory `88f25ddd` (19 Jul)
  recorded that Leptos's stick-to-bottom effect re-scrolls "on any DOM patch when at_bottom is true, unaffected by
  what caused the patch", unlike Svelte's effect which only depends on `messages.length`/`streaming` and misses an
  in-context approval card growing the footer. Reading the CURRENT `ui/conversation.rs` (its own comment dates the
  narrowing to the per-conversation-signal CPU fix, after that memory was written): the stick-to-bottom `Effect`'s
  only reactive dependency is now `oc.with(|s| s.messages.len() + s.streaming.len())` — it does **not** read
  `approvals` or `pending_here`/`live_for_conv`, and the in-context approval card renders in the same sibling
  `.conversation-footer` as Svelte's, so growing it would shrink `.messages` the same way. On a code read alone this
  looks like it could have regressed into the same bug the memory said Leptos didn't have — but this needs a live
  browser check (raise an approval on an anchored, scrolled-to-bottom Leptos panel, watch whether the tool input
  scrolls into view) before either fixing it or crossing it off; do not trust the old memory's verdict against this
  newer code without re-running it. If it does reproduce, the fix mirrors the Svelte one: add the live-approvals-
  for-this-conv count as an effect dependency.

- [ ] **Composer draft persistence: Leptos writes localStorage on every keystroke, Svelte debounces.** `ui/conversation.rs`'s
  `save_draft` is called unconditionally from the `on:input` handler's own comment: "mvp/frontend debounces this...
  this build accepts that cost for now rather than reproduce the debounce timer." Svelte's `ConversationPanel.svelte`
  debounces (300ms trailing, 2s max-wait). Low priority — the Leptos comment already names this as a deliberate,
  accepted gap, not an oversight — but it's real main-thread I/O per keystroke and belongs on the list since the
  reasoning that dismissed it ("accept for now") never got revisited.

### Rail render (RowList.svelte vs ui/rail.rs)

- Tag filter/group UI, facet expand, heat colouring, `ViewConfig` persistence (`tower.viewConfig.<tab>`), potential-
  conversation display, and dismiss-attachment are all present on both sides at a code-read level — **not a gap**.
  Not separately deep-walked pixel-for-pixel; flagged here as covered-but-shallow in case a future pass wants to be
  stricter about it.

### Attachments — resolved by decision, not a port (23 Jul)

- [x] **Resolved the other way: the client never carries `bucket` at all.** The SC ruled the original
  finding's frame wrong — the bucket is a tower storage concern, and it doesn't make sense for a frontend
  to know or care about it. towerd now stamps the bucket into each object source when it forwards a say
  (ws.rs), the upload reply no longer returns it, the WS spec's say schema dropped it, and Leptos's
  `attachment_ref` (previously the "correct" side) had its bucket handling removed. The wire contract is
  unchanged: blocks on NATS still name their bucket; the stamping party moved from client to towerd.
  Original finding kept below for the record.

  ~~**`mvp/frontend/src/lib/core/uploads.ts`'s `uploadAttachment` never reads or carries `bucket`.**~~ It builds the
  `AttachmentRef` sent in a `say` from only `{ id, mediaType, size }` off the `POST /attachment` response, and
  `types.ts`'s `AttachmentRef.source` type doesn't even have a `bucket` field to hold one. `docs/mvp/tower-ws-spec.md`'s
  normative zod schema requires it, not optionally: `say.attachments[].source` is
  `z.looseObject({ type, id, bucket: z.string(), mediaType, size })`, and the spec prose is explicit — "a servicer
  resolves against the bucket the block names, never a guess from its own deployment config; a block naming no
  bucket cannot be resolved and the say that carries it rejects (`attachment_unavailable`)". Leptos's
  `frontend-leptos/src/uploads.rs::attachment_ref` does this correctly: it extracts `bucket` from the upload reply
  and its own doc comment states the reasoning verbatim, and it even returns `None` (a failed upload, not a ref with
  a guessed bucket) if the reply is missing one.
  This reads as a real bug, not just a missing feature — traced through the code, not run live: `towerd`'s own
  `POST /attachment` handler (`crates/towerd/src/web.rs`) does put `bucket` in its JSON reply, so the data is there;
  Svelte's client just never reads it off the response or forwards it in the `say`. Grepped the whole `mvp` tree for
  `attachment_unavailable` and found no handler for it anywhere yet (rejection is presumably the *servicer's* job, per
  the spec text, not towerd's) — so the failure mode on a live send is whatever an agent servicer currently does with
  a bucket-less attachment block, not confirmed here. **Verify live before treating this as certain**: attach a file
  in the Svelte UI, send it, and see whether the servicer actually receives/resolves it. If confirmed, the fix is in
  `uploadAttachment` (thread `bucket` off the response into the returned ref) and `types.ts`'s `AttachmentRef.source`
  type (add the field) — small, but worth doing before any Leptos porting work in this area, since Leptos already has
  the correct behaviour to copy from, not the other way around.

## Porting order

Ordered by what blocks what, not by size. Each item names the gap it closes (see above for the full description).

1. **Fix the Svelte attachment `bucket` bug** (verify live first). Cheapest item on the list, independent of
   everything else, and possibly an active correctness bug in production use today — fixing a live bug outranks
   porting a missing feature.
2. **Leptos: add transport reconnect.** Everything else in Leptos depends on the socket being up; a dropped
   connection today is a dead tab until reload. Small, isolated, no interaction with the render-layer gaps below.
3. **Leptos: port the virtual list.** The foundational render-layer gap — every open conversation with a long
   history pays the uncapped-DOM tax the whole CLAUDE.md "known follow-up" and the 21 Jul perf investigation were
   about. Landing this first is also what makes item 4 meaningful (prediction is an optimisation on windowing, not a
   substitute for it).
4. **Leptos: port canvas height-prediction.** Depends on 3. Lower urgency than 3 alone would suggest — the
   Svelte-side memory trail (666f3737, 9d862a84) shows this bought a narrower real-world win than hoped (most
   messages in a real conversation aren't pure-text, so most rows still hit the ResizeObserver fallback) — worth
   doing for parity but not worth over-investing in relative to 3.
5. **Leptos: port markdown rendering.** Independent of 3/4 (it changes what a block renders, not how many are
   mounted) — could be done in parallel with either, ordered after the render-surface work only because it's a
   smaller, more self-contained slice with a ready-made test list to port (`markdown.test.ts`'s hostile-payload
   cases) and no risk of interacting with the windowing change.
6. **Re-verify (and fix if confirmed) the scroll-anchor/approval-card issue in Leptos.** Needs a live browser to
   settle either way; ordered last only because it's a one-line effect-dependency fix once confirmed, not because
   it's unimportant — do the live check whenever a browser is available, independent of the rest of this order.
7. **Composer draft debounce in Leptos.** Lowest priority, already named and accepted in the code's own comment;
   pick up opportunistically.
