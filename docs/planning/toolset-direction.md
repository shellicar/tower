# Future toolset — analysis & direction

Conclusions from the swe design discussion (the full-toolset reasoning), plane-tagged.
Reference, not settled spec. **ExecV3 is unaffected by all of this** — see the end.

**Why-anchor:** the *reasoning* behind these verdicts lives in the tool philosophy
(`tower/docs/tool-philosophy.md`); this doc is the *design* applying it.

## The lens: planes, not one axis

Every claim sits on a *plane*; its verdict is plane-relative — true on one, irrelevant or
false on another. Do not collapse them. Planes in play:

- **Process** — the workflow/sequence; independent of tool shape.
- **How Claude thinks/works** — mis-nests (not mistypes); no muscle memory; the
  indifference/anxiety dispositions.
- **Safety → approval → attendance** — a chain, not a point: approvals presuppose someone
  *attending*.
- **Current vs future state** — on the SC's machine now vs an ephemeral sandbox later.
- **Model capability** — what's *possible* (native multi-invoke, flat-JSON reliability).
- **Wire/transport** — escaping (structured-in-transport = double-escaped).
- **Observability** — watch-after vs gate-before.
- **Local vs escape** (safety sub-plane) — self-contained/restorable vs leaves-the-machine.

## Proposed toolset (shape)

- **Processing** (stateless, typed stream, one `Pipe`): `Find`, `Read`, `Match`, `Slice`, `Query`, `Pipe`.
- **Execution**: `Exec` (flat V3, explicit cwd/env, no shell).
- **Mutation** (act freely, reported-after, reversible): `Create`, `Edit`, `Append`, `Delete`.
- **Recovery**: `Snapshot`, `Rewind`.
- **Persistent**: `Terminal` (interactive niche, observable).
- **Meta**: `Ref`.

## Verdict, by piece

**Query** — the one genuinely new verb. Good on capability+process (closes the
parse-JSON-and-compute leak) *and* on the wire plane (structure flows tool-to-tool, small
result out, never double-escaped to the model). Open only on interface-legibility: stays
simple, or drifts into jq-arcana. Testable.

**Match (Grep + SearchFiles collapsed)** — good on the visible/hidden plane: it dispatches
on the *visible* input type (predictable), which is a different thing from hidden
contextual behaviour. Open on the how-Claude-works plane: the lines-vs-files intent-fork
resolved by inserting `Read`. Testable.

**Flat Exec, linear Pipe, parallelism via multi-invoke** — settled (structure-robustness +
capability). The linear pipe is what keeps off the ExecV2 tree; concurrency rides native
multi-invoke, never branches inside the pipe.

**Mutation editing — preview vs edit-and-undo.** The baseline matters and was mis-stated
earlier in analysis:
- *Default `EditFile`* (the Claude Code default): edit, and if wrong, overwrite. Cheap
  (~2 turns), disposition = **indifference**, not anxiety. It works.
- *`Preview → Apply`* was added to make the model see-and-care (stop the blat-and-overwrite).
  It overshot into **anxiety** — the model camps in the preview perfecting it. "Anxiety" is
  meaningful only *relative* to the indifferent baseline; that comparison is what makes it
  an observation, not a neutral note.
- **Direction:** drop the preview gate; `Edit` is the way forward (back to the non-anxious
  default); add **undo** as the *only* delta. There is no open "does outcome-report
  re-induce anxiety" question — edit-and-fix *is* the non-anxious default; undo just makes
  being wrong cheap.

**Safety: local vs escape.** Local ops are self-contained and restorable → they compose
freely, no per-tool gate. Network/escape is irreversible → gated at the *interface layer*,
not in the tools. (Plane: safety × attendance × current/future — coherent on the
future-unattended-sandbox plane the SC deliberately chose; not on the current-attended one.)

**Recovery — `Rewind` = state-restoration, not replay.** `Rewind` restores the **world**
(machine/env) to a snapshot; it does **not** re-execute tools. Consequences:
- Idempotency is **not** required.
- It **covers `Exec`'s side-effects** — it restores the resulting state, not replays the command.
- **Restore the world, keep the memory** (resolution in `tool-philosophy.md`): restoring the
  *conversation* too would loop — I'd rewind, forget the path failed, and walk straight back in
  (and a rewind call inside the rewound conversation erases itself). So the default keeps the
  memory and records the rewind as an event in an **append-only log outside rewindable state**;
  restoring the conversation is a separate, breadcrumbed mode for context-poisoning recovery only.
- Residual is snapshot **depth** — filesystem + env is clean, *live in-flight process* state is
  the hard part — plus the firm boundary that **escaped/network effects are unrestorable**
  (hence the interface gate).

## Genuinely open (scoped to one plane each; harness-settled)

- `Query` interface legibility — interface plane.
- `Match` intent-fork-by-composition — how-Claude-works plane.
- Preview is **not** open — the indifference baseline settles it.

## ExecV3 is unaffected — buildable now

All of the above lives on the **processing / mutation / recovery / safety** planes. ExecV3
is the **execution** plane: flat `commands`, per-command `op`, `redirect` fields, explicit
`cwd`/`env`, no shell. Nothing in this analysis changes its shape. Its spec
(`ExecV3/capabilities.md`, `ExecV3/schema.md`) stands as written — build it as specified.

The only loose tie: command-blocking is tool **config**, not schema, and may relax in a
sandbox — but that's a policy decision on the safety plane, not a change to ExecV3's shape.
