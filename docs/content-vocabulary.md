# Content vocabulary

The standard by which a tool's output is presented. This document records the understanding reached in design discussion: what the content vocabulary is, why it has to be a standard, and where the boundary sits between a tool and the presentation.

> Understanding, not a spec. This captures the reasoning so a later session reconstructs it rather than re-deriving it worse. It fixes concepts and responsibilities, not types or APIs.

## The problem it solves

A renderer has to present a tool's output without knowing the tool. A TUI, a web client, and a tool written next year all have to show the same thing correctly. That only works if there is a shared standard both sides conform to. This is the MIME model: a producer declares `text/html`, and every browser renders it, because the type is defined and both ends implement the same contract. The content vocabulary is that standard for tool output.

Without the standard, the renderer would be free to interpret output however it liked, and nothing would guarantee that what it shows matches what the tool did. The standard removes that freedom on purpose: the type dictates the contract, and the renderer implements it.

## The type carries meaning beyond the content

This is the load-bearing idea. The same characters mean different things under different types, and the type is what tells the renderer which.

- `const x = 5;` as `ts` is a program fragment: highlightable, parseable, a thing. As `txt` it is just characters.
- In a diff, the `+` and `-` are not content to print. They are structural markers the `diff` type defines, so a renderer shows added and removed lines (green and red), not literal plus and minus signs.

So the type is not decoration. It is the instruction for how to interpret the bytes. A tool emitting a type is telling the presentation how to render, through the standard. (`diff` and `file_edit` are interchangeable names for such a type; the naming is not the point.)

## Input is not the surface

Two distinct things are associated with a tool, and conflating them is the trap.

- **Input** is what the model hands the tool: `EditFile { path, edits }`. The tool consumes it. It never reaches the renderer.
- **Surface** is a separate artifact the tool *produces* for presentation: `{ path, content-type, content-operation, content }`. It carries enough on its own (the content-type, and the operation, for example diff versus replace) that a renderer can present it without seeing the tool or the input.

The renderer renders the surface, never the input.

## Producing the surface is a tool concern

The surface is the tool's responsibility to produce, because only the tool knows what its action means and how to represent it faithfully (as a diff, as a replacement, whatever fits). The presentation cannot derive the surface from the input; it would have to know the tool to do that, which is exactly what the standard exists to avoid.

So the flow is:

```
input  ->  tool  ->  surface  ->  renderer
```

The surface is the contract between the tool and the presentation: self-sufficient, carrying everything needed to be rendered on its own.

## The occasion is not the distinction

The same surface renders the same way wherever it appears, live output or an approval prompt. The meaning lives in the type, not in the occasion, so there is one renderer per type, not one per surface-times-occasion. Approval is one place a surface is shown, and it is where faithful rendering matters most, because someone acts on what they see, but it does not change what the surface is.

## The renderer's part

The renderer implements the standard for its surface: a TUI renders a type to cells, a web client renders it to DOM. It has one renderer per content type and keys off the type, never the tool. An unknown type falls back to a generic rendering, the way a browser degrades on an unknown element. The standard is what makes the whole thing composable across tools and renderers written independently.

## How we got here

The understanding above came out of a discussion, and the wrong turns are part of why the final shape is right. They are recorded because the contrast is what carries the understanding, not just the conclusion.

It started from a concrete question: what does a `file_edit` actually look like? The framing before that was vague ("the tool produces meaning, the renderer decides presentation"), and the question forced concreteness. Concreteness exposed the real issue: how structured is the thing, and who decides what it means.

The first answer was too loose: "the renderer decides presentation." The correction was MIME. HTML renders across browsers written by strangers only because `text/html` is a standard; the renderer does not freely decide, it implements a defined contract. So "the renderer decides" understated the load-bearing part. The standard is what makes it work, and a tool emitting a standardised type is telling the presentation how to render, through that standard. The whole document rests on this.

Two wrong turns followed, and both are worth keeping because they mark the boundaries of the idea.

The first was making it about approval. The reasoning pulled in a separate axis, the reversibility and no-preview argument from the tool philosophy, and concluded the content vocabulary was about whether a mutation is gated: that a reversible edit has "no approval", so the vocabulary was about outcomes rather than intents. That was wrong. Gating and rendering are orthogonal. The content vocabulary is about rendering; whether an action is gated is a different question that does not touch it.

The second was overcorrecting by dropping approval entirely. After the first correction the reasoning swung to the opposite extreme and cut approval out of the conversation. Also wrong, and the same failure in the other direction: the fix to a mischaracterisation is to correct it, not to delete the thing. Approval is one of the surfaces the standard serves. The occasion, approval or display, is simply not the distinction; the meaning lives in the type.

The example that pinned it: the same characters, `const x = 5;`, are a different thing as `ts` than as `txt`, and a diff's `+` and `-` are structural markers rather than literal characters. There is meaning beyond the content itself, and the type is what carries it. That is the essence of the standard, stated as plainly as it goes.

The last piece was input versus surface. The tool input goes into the tool; the surface the presentation renders is a separate artifact the tool produces, and producing it is a tool concern because only the tool knows its meaning. That is where `input -> tool -> surface -> renderer` came from.

## Relationship to the other docs

- `tui-architecture.md` captures this from the presentation side: typed content blocks the peers agree on, per-type renderers, unknown-type fallback. That is the renderer's end of the same standard.
- `code-architecture.md`'s content-vocabulary contract is the tool-output edge, and it still carries an earlier framing (the representation "riding in the approval"), from before the input-versus-surface split was clear. It should be reconciled to that split.
- One concrete thing to square: `tui-architecture.md`'s worked example currently has the renderer parse the tool's `input` to produce the rich rendering. That is the renderer interpreting input, which this understanding replaces with the tool producing a surface. The two need to be reconciled.
