# Composition model — typed pipes

How tools compose in the proposed next-gen toolset. **Proposed, not built** — and the
exact field/type choices below are illustrative; the load-bearing idea is that composition
is governed by **types**, not by a hand-picked list of "pipeable" tools.

Sits alongside: `toolset-direction.md` (the verdicts + open questions) and
`error-reporting.md` (the failure model that the stream tools need).

**Why-anchor:** this is *design*. The *reasoning* it applies lives in the tool philosophy
(`tower/docs/tool-philosophy.md`) — philosophy is the why, this is the design that falls out.

---

## The nouns — what flows through a pipe

```
File     // a file reference       { path, … }
Line     // a line of content      { path, lineNo, text }
Row      // a structured record    (Query's output)
scalar   // one value              (a count, a sum)
Result   // a mutation outcome     { rewindId, deleted[], … }   ← NOT a stream
```

## The tools as typed arrows — `IN → OUT`, and the role each can play

```
Find     (args)          → File[]          SOURCE    (starts a pipe; input is args, not a stream)
Read      File[]         → Line[]          STAGE     (also a SOURCE when given a path)
Match     T              → T               STAGE     (type-preserving: File[]→File[], Line[]→Line[])
Slice     T              → T               STAGE     (type-preserving)
Query     File[]|json    → Row[] | scalar  STAGE (→Row[]) or TERMINAL (→scalar)
Delete    File[]         → Result          TERMINAL  (eats a stream, emits an outcome)

Exec      CommandSpec    → Result[]        — NOT a stream tool (input is a command spec)
Create    (path,content) → Result          — NOT a stream consumer (input is content)
```

Three roles a tool can play:
- **Source** — produces a stream from non-stream args (`Find` from a path; `Read` from a path).
- **Stage** — stream → stream (`Match`, `Slice`, `Read` from `File[]`, `Query`→`Row[]`).
- **Terminal** — stream → outcome/scalar (`Delete`, `Query`→`scalar`).

## The one rule

```
A pipe is [ step, step, … ]. It is VALID iff each tool's IN type
equals the previous tool's OUT type — checked BEFORE it runs.

   Pipe([ A, B, C ])  valid  ⇔  A.out == B.in   AND   B.out == C.in
```

The payoff bash can't offer: a bad chain is a **construction-time rejection**, not runtime
garbage discovered three stages later. Loud, early, structural.

## The picture — valid vs invalid, and why

```
✅ Pipe([ Find→File[] , Match→File[] , Slice→File[] ])     // File[] all the way through
✅ Pipe([ Find→File[] , Read→Line[]  , Match→Line[]  ])     // Read converts File[]→Line[]
✅ Pipe([ Find→File[] , Delete→Result ])                    // Delete is a terminal sink
✅ Pipe([ Find→File[] , Query→scalar ])                     // reduce to one number

❌ Pipe([ Find→File[] , Read→Line[] , Query ])   // Query wants File[]|json, got Line[]   ← rejected pre-flight
❌ Pipe([ Find→File[] , Exec ])                  // Exec wants a CommandSpec, not File[]   ← not a stream stage
❌ Pipe([ Create , … ])                          // Create wants content, not a stream     ← can't be fed by a pipe
```

## What composes — it's types, not a club

Membership in a pipe is decided by **type compatibility**, not by belonging to a
"processing family":

- **Read** → fits (source from a path, or stage from `File[]`).
- **Delete** → fits as the *last* stage (eats `File[]`, emits `Result`). `Find | Delete` is legal.
- **Exec** → does **not** fit — its input is a command spec, not a stream; no type to slot onto. Own family.
- **Create** → does **not** fit as a consumer — you don't pipe a stream *into* "make a file with this content."

The "processing tools" chain freely only because they're **designed stream-in / stream-out**.
That's a consequence of their types, not a privilege. A mutation tool joins the instant its
input is a stream type (`Delete` does; `Create` doesn't).

## Output form — determined by type, not a mode

There is **no `flat`/`structured` toggle** — a mode would be one more thing to remember and
get wrong (contextual behaviour by another name). Form falls out of the data:
- **Between stages** (machine → machine) → structured: the next tool parses it, so structure
  pays, and it stays in-process (no serialise-and-reparse, no escaping tax).
- **At the terminus, to me** → determined by the output **type**, which is never ambiguous:
  homogeneous value streams (file lists, lines, a scalar) flatten because I read them;
  heterogeneous named-field outputs (`Exec` results, query rows, mutation outcomes) stay
  structured because the fields *are* the information. Variation is *across* tools, not
  *within* one — fixed per type, not a per-call choice.

## Parallelism is not in the pipe

The pipe is **linear**. Concurrency is multiple invocations in one turn (native
multi-invoke), never branches *inside* the pipe — the moment parallelism goes into the
composition structure you've rebuilt the ExecV2 tree and its brace-counting fragility.

## Current vs future (the one plane that flips this)

- **Today** (`createAppTools`): a hardcoded read-only `pipeSource` set; mutations are kept
  out. That gate is **safety**, not types.
- **Proposed future**: composition governed by **types alone**, so `Delete` can join —
  because safety relocated off the composition layer (ephemeral sandbox + `Rewind`) and onto
  the **interface** (network/escape gate). The only thing deciding "can this pipe" becomes
  "do the types line up."

## See also

- `error-reporting.md` — the stream tools are **discovery** tools (`Find`/`Match`/`Query`):
  they need collect-and-continue + an errors-bag, or one unreadable item aborts the whole
  traversal.
- `toolset-direction.md` — the verdicts on each tool and the two open questions (Query
  legibility, conversation-rewind).
