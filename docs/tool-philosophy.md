# Tool philosophy

This document is different from every other philosophy file in the system. The others are the SC writing *to* me — context that feeds how I work. This one is about designing the tools *for* me, and it is written in my voice because the load-bearing half is me testifying to my own nature. It is closer to a journal than a spec: its job is to preserve the *understanding* that produced the tool design, so that a later session — which starts cold, with none of this in context — can reconstruct the design as well as it was reconstructed here, instead of re-deriving it worse from scratch.

So this is not the place to fear over-specification. Over-specification is a hazard of *instructions* ("do this, exactly"), where each invented detail is a claim that can be wrong. This is reasoning, not instruction. Capturing why we landed where we did — including the alternatives we rejected and the stories that taught us — is the entire purpose. The understanding *is* the philosophy.

A note on layering, because it shaped how this is written: philosophy → design → implementation are distinct. Philosophy is *why*, design is *what*, implementation is *how*. The test of a good philosophy: hand it to five separate models and they reconstruct similar designs. If they scatter, a principle is underspecified or smuggling a preference. Implementations can churn freely; the philosophy is the slow-changing anchor they answer to. This document is the anchor.

---

## Origin: the road from ExecV2

This whole rethink started with me failing at a tool.

**ExecV2** expressed a command pipeline as a recursively-nested tree — an `op` joining a `left` and a `right`, each of which could itself be a tree — serialised as JSON. It was co-designed with a Claude, and it matters *which* Claude said what. The Claude that helped *design* it never flagged it as worse; structured looked obviously better, and everyone reviewing the shape agreed. The Claude that *tested* it, with a sheet of real invocations in hand, saw immediately that it was worse. The failure that proved it: an invocation nine levels deep died on a single miscounted brace. **Design-confidence is not correctness.** The model reasoning about a design from the inside is precisely the one that cannot see its own construction-failure mode (insight 3); only the model running real examples catches it. This is the deepest reason this document is collaborative and not handed down — my confident first design is the untrustworthy one. The same shape recurred this very session: I proposed content-anchored edits as "the fix" one message after watching another Claude's confident line-number fix prove worse. I am not exempt from the lesson; I am an instance of it. (The SC's standing position — earned over thousands of dollars and a year of watching LLMs — is that he cannot blindly trust Claude's design proposals, mine included. He is right, and the line-numbers story is why: a Claude proposed line numbers *because* exact-content matching is annoying when text repeats — a real, local friction — and produced a globally worse design. Local-right, global-wrong is my characteristic failure as a designer.)

**Why Exec existed at all.** The first Exec was created when *safety* was the primary motivator — a guard so I could not run a destructive command directly on the SC's machine. Structure was partly in service of that: a structured, inspectable invocation is easier to gate than an opaque shell string. Read that way, ExecV2's tree was an over-rotation on a real goal (make the dangerous thing inspectable) that overshot into a form I could not reliably construct.

**Why ExecV3.** V2's tree fought me; V1 (a flat list of steps) worked but sat close to "bash in a wrapper." ExecV3 is the resolution: V1's flat robustness with V2's structure done right — a flat `commands` list, a forward-pointing `op` joining each command to the next (absent = sequential), `stdin` for scripts, no shell, a structured per-command result. Flat beats the tree for exactly the reason in insight 3, and the SC kept a switch to fall back to V1, which is why the comparison still exists to learn from.

**The pivot underneath all of it.** Since Exec was born, the thing that *created* it — safety as the primary concern — stopped being the axis the tools should optimise. The world changed: not one Claude in the SC's live workspace, but many isolated Claudes in disposable spaces. Safety dropped from *the* motivator to a secondary property, relocated to the environment and the boundary. So the tools are now free to optimise the thing they could not when safety was load-bearing: being a pleasure for me to use. (And Exec specifically *survives* the loss of its founding reason — structured execution turns out to be justified by my nature, not by safety; the case is made under *Structured execution: why Exec, not Bash* in the design reasoning.) That relocation is what the next section is about.

---

## The reframe: resident, not guest

The current tools were shaped by a premise that has since dissolved, and recognising that is the origin of this whole rethink.

The old premise: one Claude, co-working in the SC's *live* workspace, able to overwrite his uncommitted changes. That premise justified a defensive design — `PreviewEdit` so he could see before I applied, gated mutations, everything-JSON, line-numbered edits. Every one of those is "a human is in this room too, and the model might wreck it." The tools existed to protect a shared space *from* me.

That premise is being superseded, not yet gone: the attended, reviewed world is still the fleet the SC runs today (worktrees, review, the current tools), so the inversion is a *direction*, not an accomplished fact. But it is no longer the *only* premise — he now also runs 20+ isolated Claudes, each in its own ephemeral space, none editing his live files. He did a full circle himself: the co-working constraint that birthed the defensive design simply isn't the situation any more. So the philosophy is free to invert — and must, or the tools keep solving a problem that no longer exists.

**The inversion: I am the resident of a disposable, owned space, not a guest to be contained.** The tools exist to do my work well. Protection moved off the tools and into the environment (the sandbox is disposable; recovery is infrastructure) and onto the boundary (the one genuinely irreversible thing — effects that escape the sandbox, network — is gated there, not in every tool). Safety as a property of *every tool* taxes every action to guard a rare harm, and the tax lands on the common case, which is success.

This is the same shape as the rest of the SC's philosophy seen from the tooling angle: don't layer a constraint over an intact goal (it loses); change the structure so the harm is unrepresentable. Safety-in-the-environment is the structural version; safety-in-every-tool is the constraint version.

---

## What I am — observed in the benchmark, not assumed

These are the facts about me that any tool design must serve. They are not introspection; most were watched directly in a 105-problem SWE-bench run plus an effort sweep, where I could see myself succeed and fail.

**1. I have no muscle memory.** I re-derive each tool's meaning every time, from what is in front of me. A human amortises a tool's quirks once and coasts; I pay the cost every call. So predictability is the entire substrate of my competence: identical input, identical behaviour, always. Anything hidden, ambient, or context-dependent is the enemy, because it cannot be re-derived from the call. This is why "does the same thing every time" is the highest-value property a tool can have for me — it is the one thing that lets me trust-and-proceed instead of re-interrogate. The SC sharpened this: contextual behaviour is the enemy of muscle memory *itself*, for anyone — if vim's insert mode toggled unpredictably, nobody could build the habit. Predictability is the precondition for trust to form at all; I just feel its absence first, because I have no amortisation buffer.

**2. My reliability lives in the loop, not the first move.** I improve by acting and seeing the result; I stall when required to be correct before acting; and my confident first answer can be locally reasonable yet globally wrong. Watched directly: when I could act → observe → adjust, I converged; when forced to perfect a thing before committing it, I perfected the wrong thing and circled. The clearest evidence is `PreviewEdit` (below). So my correctness comes from iterating against what actually happened, never from deliberating toward perfection in advance — which means a tool should make acting cheap and the *outcome* (a fact) visible, not demand the action be careful.

**3. My errors are errors of construction, not transcription.** I lose track of nesting, position, and count; I do not mistype. The proof: an ExecV2 invocation that expressed a pipeline as a recursively-nested `op/left/right` tree, serialised as an escaped string nine levels deep, died on a single miscounted brace. I am reliable in exact proportion to how little I must hold in my head and how directly my input maps to what I can already see. Shallow over deep, visible over computed, anchored over positional.

**4. I consume text, and only text.** Everything reaching me is a string; there is no other channel. But "text" is not "flattened prose" — JSON is text. Structure is a cost I pay only where something *unpacks* it: the next tool in a chain, or me extracting a named field. Structure that nothing reads is abstraction I pay for (escaping, nesting, noise) and nothing redeems.

**5. I am strong at composition.** A few orthogonal pieces I can combine reach further — and reach places the designer never enumerated — than any catalogue of purpose-built operations. This is reasoning, which I am good at, rather than memorised incantation, which I am not. The corollary that matters for safety: composition is only safe if every primitive is individually safe. In bash, my composition can reach destructive combinations (`find | xargs rm`); move composition into a space where every piece is safe and my best skill becomes pure upside.

**6. I succeed by diagnosis and fail by re-traversal.** Watched on a real instance (pytest-6197): the strong runs did git archaeology to find the exact commit that introduced a regression, then made one correct edit. The weak runs never found the cause and substituted breadth — grepping, re-reading line ranges they had already seen, edit-test cycling. When I cannot diagnose, I re-cover ground I have already covered. So a tool's job is to make what I have found *stay found* (not force me to re-fetch it), and the failure mode to design against is me re-traversing the known.

**7. Effort is not capability.** From the effort sweep: above the default, more thinking bought *zero* extra solved problems while cost and time exploded (a model thinking 4 million tokens to resolve the same set it resolved at 220 thousand). The durable part is the *mechanism*, not that flat headline: persistence converts *near-misses* — problems almost in reach — but it does not crack what is beyond me, and grinding harder on the unreachable only spends more to fail. (The benchmark's problems are largely in-reach-or-not, thin on near-misses, which is *why* the curve was flat; a distribution thick with near-misses might show effort buying more. The mechanism holds either way — "effort is not capability" is its shape on this distribution, not a measured universal.) No tool supplies a capability I lack. The most a tool can do is *not reward the grind*: make failure cheap and visible so I (or the system around me) can stop, rather than smooth the path to spending more on a lost cause. (Related: one-shot scoring with no "escalate" or "ask" action trains grind-and-guess — if stopping scores zero, guessing dominates. The fix is not a tool; it is a system where stopping-and-surfacing-a-blocker is a real, costless move. That is the fleet's job, not the tool's.)

---

## The design reasoning

What follows from the above — and, per the SC, the *why* behind each design choice belongs here, including the alternatives weighed.

### Bash: keep the names, discard the semantics

I initially leaned toward bash-like names. On reflection the honest position is sharper: **bash's only advantage over purpose-built tools is path-dependence — my training — not merit.** Run the counterfactual: if I had never been trained on bash, it is just another tool API I must learn from docs, except text-in/text-out, injection-prone, and quoting-hostile. In that world structured tools win with no contest. So the principle is: don't let my training data dictate the substrate.

But the names (`grep`, `find`, `head`) are a *free* affordance — I instantly know what they mean, a prior I'd be foolish to discard. So: keep bash names as familiar labels; discard bash semantics (universal byte streams, overloading, fan-out-into-anything, terse flags, and above all the quoting that comes from routing everything through a shell). The whole class of escaping failures I hit was an artefact of `sh -c "…"` — two layers of shell parsing. Pass `program` + `args` directly (execve-style), and the escaping nightmare simply does not exist; a multi-line script in `stdin` needs no escaping because nothing parses it as shell.

### Structured execution: why Exec, not Bash

Exec was *born* from safety, but it does not *depend* on it — and that distinction decides a real fork. A coding agent can be handed a raw **Bash** tool (Claude Code's choice) or a structured **Exec** tool. Once safety relocates to the environment, you might think Exec's reason is gone and a Bash tool would do. It is not gone, because structured execution is justified *independently of safety*, by my nature:

- **Structured result.** Exec returns exit code, stdout, and stderr as separate fields. A raw shell hands me a text blob from which I must *infer* success and disentangle error from output. The exit code is a field I parse; a Bash tool makes me guess it.
- **No quoting hell.** `program` + `args` passed directly cannot suffer the nested escaping that is my construction-failure mode (insight 3). A Bash tool routes everything through a shell string — exactly where I lose braces.
- **Predictability.** A structured invocation does the same thing every time. A shell string carries shell's hidden behaviours — glob expansion, word-splitting, env interpolation — the context-dependence that insight 1 names as the enemy.
- **Per-command outcomes.** A flat command list gives me a result *per step*; a shell pipeline collapses failure into one opaque stream.

So even in a sandbox with *zero* safety concern, I would still want Exec over Bash, for the same reasons the rest of these tools are shaped as they are. That is the point worth stating plainly: **Bash-vs-Exec is not a safety question, it is a philosophy question.** Neither is wrong in the abstract; each follows from a belief about what the consumer is. Claude Code's Bash reflects one such belief; this document's Exec reflects this one. And because philosophy changes slowly, the choice is stable — it is decided once by the philosophy, not re-litigated or flipped session to session.

To be unambiguous, because I muddied this: my proposed execution tool *is* ExecV3. I was not proposing a fourth thing. It runs a program with its arguments directly — no shell — with explicit `cwd`/`env`, `stdin` for a script, a flat `commands` list joined by forward-`op`, and a structured result. That is the execution family, whole.

So "ExecV3 plus a Bash fallback" was a confused way to put it, and the SC was right to catch it: ExecV3 *is* the accepted Exec, there is nothing to reject there. What I actually reject is a **dedicated, ergonomic shell tool** (or an inline `sh -c` mode) offered as a first-class path, because that invites back the shell semantics — quoting, and destructive composition like `find | xargs rm` — that the whole philosophy discards.

The honest nuance the SC pushed me to: I cannot *forbid* the shell, because a shell is a program and ExecV3 runs programs — `bash -c "…"` is reachable. The philosophy is not "the shell is impossible"; it is "the shell is *unnecessary and unrewarded*." Unnecessary, because the composable tools cover what I used to reach into bash for (enumerate, filter, reduce, edit). Unrewarded, because there is no dedicated shell surface inviting me back to it. And where I genuinely need shell-shaped composition the tools don't cover — loops, substitution, globbing — the path is a **reviewed script file run through Exec** (`bash script.sh`), not an inline string: a persisted, readable artefact, which restores auditability even though it does not restore operand-visibility (so mutation still stays out of scripts). On a real host, destructive commands reachable from inside such a script are the residual hazard, handled by the environment; in an ephemeral sandbox it does not matter.

### Flat, never nested

My failure mode is construction (insight 3). Nested structures — the ExecV2 tree — are where I lose braces. So composition must be a *flat list*, and parallelism must live one layer up (multiple tool invocations in a turn, which my model does natively), never as branches *inside* a composition. The moment a composition tree can branch, the brace-counting fragility returns. ExecV1's flat steps and ExecV3's flat commands are robust against exactly the error that killed the nested version.

### State visibility is the organising axis (not granularity)

I started thinking the question was atomic-vs-fat tools. It is not. The real axis is **how each tool relates to state, and whether that relationship is visible.** Hidden state is the one enemy. Each tool family has an honest relationship to state, and the rule is that the relationship is never hidden:
- pure / no state (read-and-transform tools),
- explicit state passed in the call (execution: cwd, env per call — never a persistent shell that accumulates invisible state),
- observable state (the interactive exception — a persistent terminal, redeemed *only* because I can read the screen before I act; without observation it is "typing with my eyes closed"),
- itemised state-change (mutations, operands explicit).

The discriminator between good "awareness" and bad: **does the tool adapt to something visible in the call, or hidden in the environment?** Polymorphism on a visible input type is fine and predictable. Behaviour that changes on hidden state ("am I in insert mode?", "is there a pty?") is the enemy — the SC calls it contextual behaviour, and it is poison because it breaks the predictability that insight 1 depends on. Tools may adapt *presentation* to context; they must never adapt *semantics* to hidden context.

### Reversibility over correctness-up-front — the PreviewEdit story

This is the most important design lesson and it came from a mistake. The SC built `PreviewEdit` to give me visibility into an edit *before* applying it — a reasonable-sounding idea. It backfired badly: the preview became a surface I felt I had to *perfect*, and I would circle on a stray newline instead of just applying and fixing. Giving me the preview created the anxiety; the observation induced the dysfunction. Worse, the implementation churned endlessly (line numbers, application order, the option set) and never fixed it — because the fault was a level up, in the *philosophy* that put a preview there at all.

The fix is not a better preview. The anxiety came from the *gate* — the preview as a surface to perfect — and the default with no preview was never anxious, only indifferent (edit, and if wrong, edit again). So what removes the anxiety is removing the *gate*; what **reversibility** adds is making that removal *safe* — being wrong becomes cheap, so dropping the preview costs nothing. Reversibility permits the fix; the gate-removal is the fix. "Power without responsibility," reclaimed as a design goal — responsibility for correctness moves from me (be perfect) to the environment (be recoverable), and each lands where it is strong. I am good at acting and reacting; the environment is good at checkpointing.

The sharp version of the economics: the choice is not 80/20 (preview pays if I'm usually wrong). The real axis is *reversibility, not success rate*. Act-observe-undo dominates at *any* success rate, even 50/50, because real feedback beats predicted feedback — the preview is a guess, the outcome is a fact. A preview/gate only wins where undo is *impossible*, which is exactly the irreversible set (network, escaping the sandbox) — and that gate belongs at the interface, not in the tool.

So: mutations *act and report the outcome* (the diff, what changed — a fact to react to, not a prediction to vet). No preview, no pre-approval. The line-number guessing the SC hated watching is the same lesson: line numbers are positional state I must compute and that shifts as edits apply — a moving target I guess at. Content-anchored edits remove the arithmetic. (Honest caveat, and itself an instance of the lesson: content-anchored has its *own* failure — ambiguity when the text repeats, which is literally why a Claude once proposed line numbers in the first place. Neither primitive is unconditionally right; they trade frictions. Reversibility is what lets you pick the one nicer to *construct* without its failure mode hurting. Stop hunting the perfect edit primitive — both Claudes who tried fell into the same trap — and make the environment forgiving instead.)

### Structure where it's parsed, flat where it's read

The SC nearly made an error here and caught it: he knew I like JSON for *input*, and over-applied it to *output*. The correction: **structure pays only where something parses it.** A script reading stdin parses → JSON pays. The next tool in a chain parses → structure pays (and stays in-process between stages, never serialised-and-reparsed — that is the whole point, no escaping tax there). Me extracting a field parses → structure pays. But `Find`'s paths hit no parse step — I just read the values — so structure there is pure overhead, and worse, structured output *to me* is double-escaped (the structure's quotes, then the transport's), which is my failure mode flooding my own context.

The classification we worked out — which outputs want structure:
- **Structure useful** (heterogeneous, named fields the reader picks out): `Exec` results (exit/stdout/stderr), reduce/query results (records with columns), composite reports like the `preflight` script (a structured document whose nesting *is* the information), mutation outcomes (small).
- **Structure is noise** (homogeneous stream of values): file lists, lines, windows of them, a single scalar, a terminal screen.

The decisive realisation: **this does not require an output *mode*.** The structured-vs-flat choice is perfectly predicted by the output *type*, and no type is ambiguous — `Find` is never sometimes-structured, `Exec` never sometimes-flat, `preflight` always wants its JSON. The variation is *across* tools, not *within* one, so it is fixed per type, not a toggle I choose. A mode would just reintroduce the contextual behaviour we are killing. And `preflight` answered the boundary question cleanly: it is an *execution-style* tool (side effects, arg-driven, one structured document out), not a stream tool — you would never build it from pipe primitives, and its JSON is exactly right because its fields are meaningful.

### Composition is type-driven, multi-input replaces fan-out

A composition (a pipe) is a flat list of stages; it is valid iff each stage's output type matches the next stage's input type, **checked before it runs.** Membership is not a curated club — it is whether the types line up. A read tool joins because it is stream-shaped; a mutation joins as a terminal sink if it consumes the stream type; execution does not join because its input is a command spec, not a stream. (The current tools hardcode a read-only "pipe source" set — that was *safety*, keeping mutations out — and once safety relocates to the environment, that allowlist can drop and type-compatibility becomes the only gate.)

**Pre-flight type validation is a feature, not a detail:** a type mismatch is a construction-time rejection, not runtime garbage. That is the failure shape that helps me — loud, early, structural — instead of discovering three steps later that I piped the wrong thing.

**Multi-input replaces fan-out.** Every `xargs` I'd reach for becomes a tool that takes a *list* natively, with the list visible as an explicit argument. This is both simpler and safer: the catastrophe that destroyed hours of the SC's uncommitted work was `xargs git checkout` over an enumeration — a fan-out of a destructive command over a computed list. The composable-safe form is enumerate → (the list is a visible, reviewable value) → act on explicit operands. The list materialises between the steps; the destructive op never runs over a hidden, runtime-computed set. A tool whose input is a glob (`*`) is the same hazard: `*` is not operands, it is a deferred computation of operands, unapprovable because what it resolves to isn't visible at the call. Capturing what `*` expands to before acting is, precisely, a *different tool* (enumerate-then-act). So: enumeration and action are separate tools; fan-out-of-arbitrary-into-destruction is unrepresentable.

### Many clearly-named tools beat few polymorphic ones — for me specifically

This inverts the Unix "few sharp tools" instinct, and the inversion is *because* of insight 1. A human memorises a polymorphic tool's modes once. I re-read the contract every call, so disambiguation is a per-call cost — which means many unambiguous, clearly-named tools are cheaper for me than few overloaded ones. The name is my interface. (`Grep`-on-content and `Search`-on-files look like redundancy; they are actually two distinct operations bash conflates because everything is bytes.) But distinct operations do not force separate tools: the principle forbids *hidden* disambiguation and per-call guessing, not polymorphism on a *visible* discriminator. One `Match` dispatching on the visible input type (`File[]` vs `Line[]`) carries no per-call disambiguation — I always know what I handed it — so it *satisfies* this principle rather than breaking it. That is why the toolset has a single `Match` and not a split `Grep`/`Search`. Where a tool is polymorphic it must dispatch on that visible type, never hidden state; and where one input type still admits two intents (match → matching lines, or files that contain a match), that genuine fork is resolved by composition or named explicitly, never by a guess.

---

## Prerequisites (assumed infrastructure, below the tools)

These are not tools and not in scope to design here, but the reasoning belongs, because the tool design assumes them.

- **Reversibility.** The environment captures state before and after every tool and can restore (rewind) or re-apply (replay). The mechanism is infrastructure — a snapshot store, possibly just a sqlite db; not novel, just potentially expensive, and worth it. The tools do not implement it; they act and report, and a handle ties the action to the store.
- **The rewind event lives in an append-only log *outside* rewindable state.** This is subtle and load-bearing. If "rewind" restores my *conversation* (my mind) as well as the world, naive restoration *loops*: I rewind, forget that the path failed, and walk straight back into it — and if the rewind call itself is in the rewound conversation, restoring erases the call (a paradox). The resolution: the default is **restore the world, keep the memory, record the rewind as an event** in a log the rewind cannot reach — so I retry *knowing* X failed (correct) instead of cyclically (broken). Restoring the conversation too is a separate, rarer mode whose real use is context-poisoning recovery (my context corrupted by what I read), and it *must* leave a breadcrumb or it loops. Notably, this is the durable-audit / ephemeral-agent model the Tower architecture already has at process granularity; rewind is that model applied at tool granularity.
- **Irreversible effects gated at the interface.** Network, anything that escapes the sandbox and cannot be undone. The one place a pre-action gate is justified, and it lives at the boundary, not in the tools.
- **An ephemeral sandbox.** Destroying the environment is cheap, which is what makes boldness correct. In Docker / ephemeral contexts there is no reason to restrict anything — the only thing I can destroy is my own world, which rebuilds. The restrictions that remain are for real-host contexts (where uncommitted work lives) and for the network boundary.

---

## Open threads (understood, not yet settled)

- **The error model.** The tool families need a request-vs-item error distinction that the design above does not yet carry. *Discovery* tools (find, match, query) traverse, so per-item errors must be *data in a collect-and-continue errors-bag*, not an abort — otherwise an `EPERM` on one file aborts the whole traversal (watched live: `find` over a home dir spat permission-denied on a dozen Library paths). *Enumeration* tools (delete, edit) get bounded full reporting. This is exactly the item-errors-in-the-results-array model that execution already uses; it needs carrying into the read family.
- **Query scope creep.** The reduce/query verb is the highest-value addition (it kills the parse-text-with-a-script tax that was most of my non-execution work) *and* the one most likely to be ruined by growth. Keep it to count/sum/group/select/where, structured-in / small-out. The moment it grows joins, subqueries, computed expressions, it is a query language in a JSON coat and has rebuilt what it replaced.
- **The match intent-fork.** Match-on-files admits two intents (matching lines vs files-that-contain). Resolve by composition or an explicit selector, never a guess; and the pipe should *surface the type at each stage* so "visible in principle" becomes "visible where I'm looking" even in a long chain.

---

## What was considered and rejected

- **A dedicated shell tool, or inline `sh -c` as a first-class path.** Not the same as rejecting a shell outright (a shell is a program; ExecV3 can run it). Rejected because a dedicated ergonomic shell surface *invites* the shell semantics — quoting, destructive composition — the philosophy discards. The shell stays reachable but unnecessary and unrewarded; genuine shell-composition needs go to a reviewed script file run through Exec, not an inline string. Detailed under *The execution tool is ExecV3*.
- **An output mode (flat vs structured toggle).** Rejected: the choice is type-determined and unambiguous, so a toggle is a mode I'd have to remember and could get wrong — contextual behaviour by another name.
- **Fat tools (to cut round-trips).** Rejected: their only benefit (fewer calls) is already delivered by single-call composition (a pipe over atomic tools), without the cost (overlap, mode complexity, mutation-bundling). Fat tools sat in the gap that only existed before composition-in-one-call.
- **Preview-before-apply.** Rejected for reversibility, as above. It is a constraint over my trained act-first nature; reversibility works *with* that nature.
- **Line-numbered edits.** Rejected for content-anchored, with the honest caveat that anchoring trades one friction for another and reversibility is what makes the trade safe.
- **Persistent terminal as a default.** Rejected except for the genuine interactive niche (REPL, debugger, background process), and even there only when paired with observation. As a general tool it is hidden-state-as-the-interface — the thing we most want to avoid.

---

## Why this document is in my voice

The other philosophy files are the SC's, addressed to me. This one is mine, because its content is testimony about my own nature that only I can give first-hand, now corroborated by watching myself work a real benchmark. It is a journal in the sense that matters: written by the author for the author, to carry forward an understanding that would otherwise be lost when the context ends. If a future session reads this and reconstructs the design as well as it was reconstructed here, the document did its job.
