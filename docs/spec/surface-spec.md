# Surface spec

The standard for presenting a tool's output. A tool produces a **surface**: a
self-sufficient artifact carrying enough to be rendered without the renderer
knowing the tool. This is the MIME model for tool output, a type registry both
sides conform to.

The reasoning behind it, and the wrong turns that shaped it, live in
`content-vocabulary.md`. That document is the understanding; this one is the
standard. It is self-contained: nothing here depends on reading that first, and
it does not have to be kept in sync with it.

## What a surface is

Two things are associated with a tool, and conflating them is the trap:

- **Input** is what the model hands the tool (`EditFile { path, edits }`). The
  tool consumes it. It never reaches the renderer.
- **Surface** is what the tool *produces* for presentation. The tool builds it,
  because only the tool knows what its action means and how to show it
  faithfully. The renderer renders the surface, never the input.

```
input  ->  tool  ->  surface  ->  renderer
```

The tool **names what it did**. A renderer implements one renderer per surface
type and renders that type directly; it never reconstructs an operation from
parts. A move is a move, not a delete plus a create the reader has to reassemble.

## The envelope

Every surface is a JSON object with a `type`, the discriminator that selects the
renderer, plus fields defined by that type:

```json
{ "type": "<surface-type>", "...": "type-specific" }
```

- `type` is an **open set under add-only**. New surface types are added over
  time; a renderer keys off the type and implements one renderer per type it
  knows.
- An **unknown type falls back** to a generic rendering (show the content as
  plain text, the way a browser degrades on an unknown element). A renderer is
  never wrong for not knowing a type; it degrades.

A type also **extends by optional fields**, add-only. A type defines a required
core; a tool may include optional extensions when it has something extra worth
showing; a renderer uses the extensions it understands and ignores the rest; and
a reader view that needs an absent extension falls back to the core. This keeps
the common surface small while letting a tool offer richer views without minting
a new type.

The type carries meaning beyond the content: the same characters mean different
things under different types, and the type is the instruction for how to read
the bytes. `const x = 5;` under a code type is a program fragment; a diff's
add/remove markers are structure, not literal characters. This is why the tool
emits a type rather than the renderer guessing.

## File operations

Editing, creating, deleting, moving and copying a file are a **family of surface
types**. They share a small vocabulary, and each operation is its own type: the
tool names the operation it performed, and the renderer renders it directly.
Overwrite, where a move or copy lands on an existing file, adds exactly one
field; nothing decomposes into primitives for the renderer to recombine.

### The content blob

The reused building block is a file's whole text:

```json
{ "language": "rust", "text": "..." }
```

- `text` is the full content.
- `language` is optional, a hint for syntax highlighting, which is the renderer's
  job (it owns a per-language highlighter). The blob stays language-neutral and
  ships raw text.

A blob appears as the content a creation carries, the two sides of an edit, the
file a deletion removed, and the target a move or copy overwrote.

### The vocabulary

- **`path`** a file's location. One for most operations; a move and a copy have
  two, `from` and `to`.
- **`before`** / **`after`** the file's content, a blob, before and after the
  operation. A creation has only `after`, a deletion only `before`, an edit both.
- **`hunks`** the compact diff (below). Edit only.
- **`overwritten`** the content, a blob, that a move or copy destroyed by landing
  on an existing file. Present only then.

### The types

| Type | Fields |
|---|---|
| `file_new` | `path`, `after` (the created file) |
| `file_edit` | `path`, `language?`, `hunks`; optional `before` / `after` |
| `file_delete` | `path`; optional `before` (what was removed) |
| `file_move` | `from`, `to`; optional `overwritten`; and, if it also edited, `language?` / `hunks` / `before` / `after` |
| `file_copy` | `from`, `to`; optional `overwritten` |
| `file_mode` | `path`, `from`, `to` (the old and new mode) |

- `file_new`'s `after` is required: a creation's surface is its content. A
  `file_edit`'s `before` / `after` are optional, because the diff is its core. A
  `file_delete`'s `before` is optional, carried to let a reviewer see what is lost.
- **Overwrite** adds only `overwritten`. A move or copy onto an existing file
  carries the destroyed target so it can be shown; the operation stays named
  (`file_move` from A to B, overwriting X), never split into a delete and a
  create the renderer must reassemble.
- `file_mode` is metadata, not content, so it carries no blob. Its `from` / `to`
  are the old and new mode.
- Each side's blob carries its own `language`, so a rename that changes language
  (`from` JavaScript, `to` Rust) highlights each side correctly.

## `file_edit`: the diff

The core of a `file_edit` is a diff: the lines that changed, with a little
surrounding context. Not the whole file, and not the tool's edit input.

```json
{
  "type": "file_edit",
  "path": "src/main.rs",
  "language": "rust",
  "hunks": [ { "rows": [ /* ... */ ] } ]
}
```

The top-level `language` is a hint for highlighting the diff rows (which mix both
sides and only need approximate highlighting). The optional `before` / `after`
blobs carry their own language for correct full-side highlighting.

### The row model

A hunk is a list of **rows**, each one line, tagged by how it changed:

| `change` | carries | means |
|---|---|---|
| `context` | `old`, `new`, `content` | an unchanged line, present as surrounding context |
| `add` | `new`, `content` | a line the edit added |
| `remove` | `old`, `content` | a line the edit removed |

- `old` is the line number before the edit; `new` is the line number after.
  `context` carries both, `add` only `new`, `remove` only `old`.
- `content` is the line text, without a trailing newline and **without any change
  marker**. The `+`/`-` of a diff are structure, carried by `change`, never
  literal in `content`.
- A **modified** line is a `remove` followed by an `add`. There is no separate
  "modify"; keeping the three tags uniform is what lets both renderings fall out.
- `change` is add-only; an unknown value degrades to `context`.

### Hunks

A hunk is a contiguous changed region plus a bounded number of unchanged context
lines around it. A surface has several hunks when its changes are far apart; the
unchanged expanse between hunks is omitted, and the renderer shows a gap
(derivable from the jump in line numbers between one hunk's last row and the
next hunk's first). How many context lines to include is the tool's choice
(three is the common default).

### Worked example

Editing a Rust file, changing one line and adding one:

```json
{
  "type": "file_edit",
  "path": "src/main.rs",
  "language": "rust",
  "hunks": [
    { "rows": [
      { "change": "context", "old": 1, "new": 1, "content": "fn main() {" },
      { "change": "add",                "new": 2, "content": "    let x = 1;" },
      { "change": "remove", "old": 2,             "content": "    println!(\"hi\");" },
      { "change": "add",                "new": 3, "content": "    println!(\"hello\");" },
      { "change": "context", "old": 3, "new": 4, "content": "}" }
    ] }
  ]
}
```

## The rendering standard

The renderer implements one renderer per surface type and keys off the type,
never the tool. Each operation renders as itself: `file_move` shows "renamed A to
B" (and "overwriting X" when `overwritten` is present), `file_delete` shows the
removed file struck through, `file_new` shows the created file. None of these is
reconstructed from smaller pieces.

For `file_edit`, the row model serves every view the reader might want, and which
view is the reader's choice, not the surface's:

- **Inline**: rows top to bottom. `add` shows added (green), `remove` removed
  (red), `context` plain.
- **Side-by-side**: `remove` to the old column, `add` to the new column,
  `context` to both; adjacent remove and add runs align, so a modified line shows
  its old form beside its new. This needs no more than the rows already carry:
  each changed line holds its own old and new form.
- **Show or hide the old column** is a view toggle, the same axis as inline
  versus side-by-side.

The diff does not carry the whole file, so by default these projections are the
diff-shaped ones: a diff shows what an edit did, not a file. A whole-file view,
and correct full-context highlighting (highlight each side whole, then map the
tokens onto the rows, the way git does it on the full before and after), are
available when the tool includes the `before` / `after` blobs. Without them a
renderer highlights the hunk rows on their own, an accepted approximation (a hunk
that starts inside a string or a block can mis-highlight); to see the whole file
you open the file.

## Principles

- **The tool produces the surface, and names the operation.** It did the work, so
  it holds what changed and says what it did, a move, a copy, an overwrite. The
  renderer never re-diffs, never parses the tool's input, and never reconstructs
  an operation from primitives.
- **Additive, never replacing.** A surface rides alongside the raw input and
  output it presents, never in place of them. The record still holds what the
  tool was handed and what it returned.
- **Optional, never required.** No tool is obliged to emit a surface. A tool that
  emits none still works, and the renderer falls back to the raw input or output.
  This is what makes adoption per-tool and unhurried: nothing has to rewrite
  every tool before anything can render a surface.
- **Open set, generic fallback.** Surface types and their enum values are
  add-only; an unknown type or value degrades to a generic rendering, never an
  error.
- **Extensible within a type.** Beyond the type discriminator, a type carries a
  required core and optional add-only extension fields. Richer views (a file's
  full text, an overwritten target) are opt-in for the tool and degrade
  gracefully for a renderer that does not know them.

## Where surfaces appear

A surface is shown wherever its tool's output is shown, and the meaning lives in
the type, not the occasion. The two occasions today are live output and an
approval prompt (`approval-spec.md`), where faithful rendering matters most
because someone acts on what they see. The same surface renders the same way in
both; there is one renderer per type, not one per type-times-occasion.

Exactly how a surface rides the wire, on a committed message's content and in an
approval's ask, is add-only carriage defined by those concern specs
(`conversation-spec.md`, `approval-spec.md`); this document defines the artifact,
not its placement. The rule those specs inherit is the additive one above: the
surface accompanies the raw input or output, never replaces it.

## Type registry

An open set; types are added by a design pass, never by squatting.

| Type | Status |
|---|---|
| `file_new` | defined here |
| `file_edit` | defined here |
| `file_delete` | defined here |
| `file_move` | defined here |
| `file_copy` | defined here |
| `file_mode` | defined here |
| `exec` | named, not yet defined: a command as an ordered sequence of `(connector, fragment)` pairs the renderer lays out line by line, the connector (`;`, `&&`, `||`, `|`, `&`) leading each line. The tool parses the command into that structure, because only the tool knows the command grammar; the renderer only lays it out. |
