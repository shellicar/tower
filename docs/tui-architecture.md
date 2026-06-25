# TUI architecture

The presentation framework the bridge clients render through. This document is the layer contract MVC presumes you already have, and that you do not have here, because the framework and the app are being built at the same time.

## Why this document exists

MVC structures an app *on top of* a framework. In a browser the engine sits below the View: the View emits a render tree, and the browser does layout, paint, compositing, and the platform write. A web developer never names those layers because the DOM specification already named them.

There is no engine here. The TUI writes its own layout, its own composition, its own terminal output. So the layers a framework normally owns are first-class parts of this codebase, and MVC has no vocabulary for them, by design. Its three boxes silently fuse the seams that matter:

- **View** = layout + compose + present + platform.
- **Model** = document model + view state.

The long-standing "ghost text" defect lived inside the View box, at the present/platform sub-seam MVC cannot name. Terminal behaviour (autowrap left enabled, and a newline trusted to advance exactly one physical line) leaked up into rendering, because no contract said it could not. A boundary the architecture has no word for cannot be enforced.

This document gives the boundaries names. Named boundaries are checkable: "is this change correct?" stops being taste and becomes a contract check. The same names are the specification an LLM writes renderers against. Without a published contract every contribution is a guess; with one, every contribution is verifiable.

> Architecture, not design. This names the layers, their responsibilities, and the contracts between them. It does not fix APIs, types, or file layout. Those are design, decided per implementation.

## The invariant

One rule, applied everywhere. It is the OSI grammar, not a specific stack:

- A layer depends only on the layer below it.
- Peers at the same layer communicate through a contract and never reach through it.
- A layer's implementation is replaceable without its neighbours noticing.

That single rule buys two things from the same source: **substitutability** (swap a transport, a client, a model) and **bug-immunity** (a behaviour cannot cross a boundary it is fenced behind). OSI is not the architecture. It is the grammar the architecture is written in. Each concern (presentation, transport, the tool pipeline) is a stack expressed in that grammar; this document works one of them through in full.

## The TUI layers

The TUI is the render-and-input part of a bridge client (the client also holds the bridge end, the request side, and the projection). Data flows down to the screen. Input flows up and becomes requests. A single coordinator is the only trigger for a re-render: on any event, whether a bridge message or an input, it updates state and runs layout, compose, present.

```
 bridge   events in (text_delta, tool_intent, turn_ended ...)
          requests out (user_input, approval, cancel)
   │
 ┌─┼──────────────────────────────────────── pure, no terminal ──┐
 │ 1  DOCUMENT MODEL   the client's projection of the conversation │
 │ 2  VIEW STATE       mode, editor, cursor, scroll, expand state  │
 │ 3  LAYOUT           (model + view state + width) -> cell document│
 │ 4  COMPOSE          (cell document + size + scroll) -> grid      │
 └────────────────────────────────────────────────────────────────┘
 │ 5  PRESENT          diff grid vs presented -> minimal updates    │  trusted kernel
 │ 6  PLATFORM         size, resize, raw input, flush               │  ONLY OS-dependent layer
        VT-writes backend / Win32-console backend, one interface
```

| Layer | Responsibility | Terminal-aware |
|-------|----------------|----------------|
| 1 Document model | The client's ordered projection of the conversation: typed content blocks, each with a stable identity. Built by folding the event stream. Sealed blocks are complete and immutable; one active block accumulates streamed partial content (see Streaming). "What is true, as this client has seen it." | No |
| 2 View state | Mode (compose, streaming, approval, history, command), editor buffer, cursor, scroll offset, per-block expand and collapse, selection. References blocks by identity. "What the user is looking at and doing." | No |
| 3 Layout | Pure function of (document model, view state, width) to a virtual document of cells, which may exceed the viewport. Wrapping and measurement happen here. The per-type block renderers (the content vocabulary) live here; an unknown type falls back to a generic rendering. | No |
| 4 Compose | Pure function of (virtual document, viewport size, scroll) to the visible cell grid. Decides the first and last visible line. Places overlays (status line, approval prompt) into the fixed grid. | No |
| 5 Present | Owns the back and front cell buffers. Diffs the desired grid against what is presented and emits the minimal update. Absolute cursor addressing, autowrap off, synchronized output when the terminal offers it. | Yes |
| 6 Platform | Reports size, emits resize events, delivers raw input, flushes output. Two backends behind one interface: VT escape writes (Linux, macOS, modern Windows Terminal), and the Win32 console API (CHAR_INFO grid or swapped screen buffers). | Yes |

The cell grid is the contract between layout and present. It is unambiguous: each coordinate holds one character and one style, so two grids can be compared exactly. A string of pre-styled text is not a contract; its width depends on how the terminal renders each glyph, and that ambiguity is where the ghost class lives.

Input mirrors output. The platform layer delivers raw bytes, an input decoder turns them into keys, mouse, and paste, and view state mutates. Where the user commits something, view state emits a request back through the bridge.

## Functionality by layer

The catalog of named operations, each under the layer that owns it. This exists for completeness: every piece of behaviour should have one home here, so a new capability has an obvious place and an obvious contract. It is the list to extend, not a closed set.

**1 Document model**

- Event folding: applying each event to build and update blocks.
- Sealing: moving the active block to sealed when its end event arrives.
- Identity: assigning each block a stable id.
- Projection: accumulating the ordered block history this client has seen.

**2 View state**

- Mode: which interaction mode is active (compose, streaming, approval, history, command).
- Editor: the input buffer and its cursor.
- Scroll: the scroll offset into the document.
- Selection and focus: what is selected or focused.
- Disclosure: per-block expand and collapse, tool-detail toggles.

**3 Layout** (most of the text-shaping work lives here)

- Grapheme segmentation: clustering code points into graphemes.
- Width measurement: the display width of each grapheme (East Asian width, emoji, zero-width).
- Line wrapping: breaking a logical line into physical rows at the current width (soft wrap).
- Reflow: re-wrapping when the width changes, ideally from precomputed segments rather than re-measuring.
- Sanitisation: stripping or replacing control and zero-width sequences that would corrupt layout.
- Tab expansion: turning tabs into spaces at tab stops.
- Styling: turning a block's styling into per-cell style.
- Truncation: shortening to fit, with an ellipsis where needed.
- Padding and alignment: filling a row to width, left, right, or centre.
- Decoration: gutters, prefixes, quote markers, list bullets, indentation.
- Height measurement: how many physical rows a block occupies (the input to scroll math).
- Per-type rendering: the content-vocabulary renderer for each block type, with a generic fallback.

**4 Compose**

- Region allocation: dividing the viewport between regions (conversation, editor, status).
- Scroll resolution: mapping the scroll offset to a visible row range, clamped to bounds.
- Viewport slicing: taking the visible window out of the virtual document.
- Overlay and z-order: placing the status line, approval prompt, and any popup into the grid.
- Clipping: discarding content outside a region's bounds.
- Cursor placement: where the hardware cursor lands in the final grid.

**5 Present**

- Diffing: comparing the desired grid against the presented one.
- Damage output: turning changed cells into the minimal set of writes.
- Cursor optimisation: absolute addressing, fewest moves.
- Style coalescing: emitting only the style transitions between cells.
- Frame framing: wrapping the flush in synchronized output when available.
- Buffer swap: promoting the desired grid to the presented one.

**6 Platform**

- Setup and teardown: alt screen, raw mode, cursor visibility, on enter and exit.
- Capability detection: synchronized output, colour depth, and similar.
- Size and resize: reporting dimensions and emitting resize events.
- Input decoding: bytes into key, mouse, and paste events (escape and mouse sequence parsing, bracketed paste).
- Flush and encoding: writing bytes (VT) or cells (Win32 console) in the terminal's encoding.

Two pieces sit on a seam rather than inside one layer, and are worth calling out:

- **Width measurement** (layout) should agree with how the **platform** renders glyph widths, but the layered model *contains* a disagreement instead of letting it cascade. Because present draws to absolute cell positions with autowrap off, a glyph the terminal draws wider or narrower than layout measured is at worst a local artifact on that one row: a gap if layout reserved more cells than the glyph used, an overlap or clipped glyph if it used more. The next cell is still drawn where layout placed it, no extra physical row is consumed, and the next frame paints over it. This is the structural difference from printing a long line and letting the terminal wrap it, where a single width error desynchronises the whole layout (the ghost); here it is bounded to one glyph's neighbourhood. So width agreement is cosmetic fidelity, not structural integrity, and the graceful degradation is a property of the model rather than of measuring perfectly.
- **Colour downsampling** (truecolor to 256 to 16) is present's to emit but platform's to bound, since the available depth is a capability. It lives at the present/platform seam.

## The layer contracts (where verifiability begins)

A named boundary is enforceable by review: does this code reach across the line. A *concrete* contract is verifiable by test: the value that crosses the seam is a known shape you can assert against. The architecture above fixes the boundaries and what crosses them; the exact types are design. But one contract is load-bearing for everything this document promises, so it is worth showing concretely. Verifiability pays out the moment the value crossing a seam stops being a name and becomes a shape.

The shapes below are illustrative, not normative. They show what each contract looks like once it is concrete enough to test against.

What crosses each seam:

| Seam | Value that crosses | Illustrative shape |
|------|--------------------|--------------------|
| bridge -> model | events and request responses | `{ type: "block_start", blockId, blockType }`, `{ type: "text_delta", blockId, text }`, `{ type: "block_end", blockId }` |
| model -> layout | typed blocks, one marked active | `{ id, type: "tool_use", name, input, sealed: false }` |
| layout -> compose | a virtual document of cells | `Cell[][]`, rows that may exceed the viewport |
| compose -> present | the visible cell grid | `Cell[rows][cols]` |
| present -> platform | the minimal update (or a full frame) | `{ row, col, cells }[]`, plus size and capability queries |
| platform -> view state | decoded input | `{ type: "key", value }`, `{ type: "paste", text }`, `{ type: "resize", cols, rows }` |

The keystone is the cell. Everything verifiable runs through layout, compose, and present, and all three speak cells, so the cell is the one shape that must be pinned for the rest to pay out. Illustratively:

```
Cell  = { grapheme: string, style: Style }
Style = { fg?, bg?, bold?, dim?, inverse?, underline? }
Grid  = Cell[][]   // [row][col], 0-based; an empty cell is { grapheme: " ", style: {} }
```

It has to settle three things a name does not: how a width-2 grapheme spans two cells (the second a continuation marker), how a zero-width mark attaches to its base cell, and how two grids compare (cell by cell) so the diff and the snapshot are well defined. Once those are fixed, a renderer's output is a value, and "verifiable" is real.

Worked example, a tool-use block streaming then sealing:

1. `block_start` with `blockType: "tool_use"` adds an active block to the model. Deltas append partial JSON to `input`; `sealed` stays false.
2. `layout(model, width)` runs the `tool_use` renderer. While `sealed` is false the input may not parse, so it emits a basic cell representation ("running ToolName"). The output is a concrete `Cell[][]`, so the test is `expect(layout(model, 40)).toEqual(expectedCells)`.
3. `block_end` seals the block. The next `layout` parses the now-complete input and emits the rich representation. Same assertion shape, different expected cells.
4. `compose` slices the virtual document to the viewport; `present` diffs against the prior grid and emits only the changed cells; `platform` flushes them.

Every arrow in that chain hands on a value, and every value is assertable. That is what the named boundaries buy once their shapes are concrete: a new renderer or a new block type is checked against the contract, not judged by eye. The architecture names the seams; this section is where a name becomes a schema, and the cell schema is the first thing design pins down.

## Streaming and the active block

The document model distinguishes **sealed** blocks from a single **active** block. Sealed blocks are complete and immutable. The active block accumulates partial content from the event stream (text deltas, thinking deltas, partial tool input) and is mutated on every event. That partial content is ephemeral: it is not necessarily persisted, and the block has no durable commitment until it seals.

The seal is the boundary other concerns key off:

- **Persistence and durability act on sealed blocks only.** The active block sits below that line, so a transcript never captures half-streamed content; durability writes a block once it is whole.
- **Representation completeness.** Partial content may not yet form a complete typed block. Tool input, for instance, arrives as partial JSON that is not parseable until the stream ends. So a content renderer (layer 3) has a partial state and a complete state: it renders what it has, basically, while the block assembles, and the rich, structured rendering once the block seals. This is the same basic-versus-rich split durability relies on.
- **Frame cadence.** Streaming produces a frame per delta. The active block re-runs layout, compose, and present on each one. The present layer's diff keeps each streamed frame minimal, writing only the changed cells, so high-frequency deltas do not repaint the whole screen.

Streaming is event traffic, not request traffic: deltas are broadcast events that append to the active block, never addressed requests.

## Resize and durability fall out of the layers

Resize is correct by construction. The present layer holds a back buffer, so it never depends on the terminal's memory of what it shows. On resize the composed grid is discarded, layout re-runs at the new width, compose re-slices, and present reconciles a fresh frame. There is no half-flushed state because a complete frame is flushed atomically.

This is why the framework owns the whole viewport (the alternate screen) rather than printing inline. Inline content shares one coordinate space with the terminal's own scrollback; on resize the terminal silently re-wraps the printed part by an amount the app cannot observe, and the live region loses its origin. Owning the viewport gives the app a coordinate system independent of terminal reflow.

Durability (leaving a transcript behind on exit or crash) is a separate, optional feature, not the primary case. It is a peripheral consumer of the document model that writes a basic point-in-time render of completed blocks through the platform layer. It never touches layout, compose, or present, so it cannot contaminate the core, and omitting it changes nothing else.

## The end-to-end tower

The TUI stack and the bridge stack are not two things. They are one layered path from the canonical conversation to the cells on a specific screen, with the protocol as the layer both ends speak.

```
SERVER end                              CLIENT end
AgentModel (canonical truth)            cells on a screen
      │                                       ▲
 model adapter                          present / platform
      │                                       │
 ────────────────  PROTOCOL (events + requests)  ────────────────
      │                                       │
   bridge ── transport ── wire ── transport ── bridge
```

The OSI correspondences that hold (the value is the invariants, not landing exactly seven layers):

- **Application** is the protocol: events and requests.
- **Presentation** is the content vocabulary: typed content blocks, the representation peers agree on so each interprets the data identically. The TUI renders them to cells; a web client renders them to DOM.
- **Session** is the handshake and identity; **Transport** is the bridge transport.

History is a capability over the document model, not terminal scrollback. The TUI navigates its own projection (in-session); Tower runs a query across sessions, served from the canonical model and audit (cross-session). One model shape, two feeds. Durability, audit, and Tower are all consumers of the document model in the same way; the live TUI is the one consumer that also takes input.

## Reuse across clients

The TUI is written against the protocol and the document model, not against any SDK. Once it is, the source of events is just the feed:

- **Current CLI**: the bridge is in-process. The SDK stream is adapted into the same events that feed the document model; requests go straight to the SDK.
- **Tower**: the bridge is over a wire.

The TUI above the bridge is identical in both. The current CLI is Tower with a zero-length wire. Adopting this is evolution, not a rewrite, and three gaps are shared investments that serve both clients at once:

1. Renderers emit cells, not pre-styled strings. This splits today's fused render into layout and compose, and removes the ghost class.
2. Blocks become genuinely typed with stable identity, which per-type rendering with fallback and per-block view state both require.
3. Present and platform are separated, so the OS dependency is the one isolated layer.

## Why this shape

- **Bug-immunity.** The ghost was an OSI violation: a lower layer's behaviour crossed a boundary it should have been fenced behind. With present and platform isolated, terminal behaviour cannot reach rendering, and the class is structurally impossible rather than patched.
- **Testability.** Everything above present is pure and asserts as plain values. The one terminal-aware layer is exercised by a virtual screen (a cell-grid emulator that interprets the present layer's output). The single seam that was untestable becomes the only thing needing a harness, and it has one.
- **Substitutability.** New transport, new client, new model, each is one layer changed and no neighbour notices.
- **Correctness an LLM can write against.** Renderers are pure functions per content type, snapshot-tested against the virtual screen. The LLM is fenced out of the terminal-aware layer entirely, and a new block type is additive: unknown types fall back rather than break.

## Relationship to other documents

`code-architecture.md` covers the agent, the bridge, and the contracts from the system's side. This document covers the presentation path from the client's side. They meet at the protocol and the content vocabulary, which both describe from their own end.
