# The orchestration layer

Above the agent and its protocol sit three distinct concerns, often conflated. The protocol *enables* all three but *implements* none of them. They are separate from the harness — the agent doesn't know they exist; it speaks the protocol, and these are built on top.

This separation matters because it's what lets the harness stay a clean, model- and language-agnostic thing while the orchestration above it evolves independently.

## A note on "orchestration"

The word is overloaded, so always qualify it:

- **Control-plane orchestration** (the Kubernetes sense) — orchestrating *resources*: spawn, schedule, lifecycle, health. This is Tower's job.
- **Workflow orchestration** (the fleet sense) — orchestrating *the work*: which role does what, routing on verdicts. This is the orchestration *logic*.

Unqualified "orchestration" is ambiguous — the same trap as unqualified "client" (bridge vs transport) or "transport" (the layer vs the bridge). Name the kind. Throughout this doc, "orchestration logic" always means the workflow sense; the control-plane sense is called out explicitly.

## Three concerns

**1. Routing — the Mailroom.**
Moving messages between agents: who can address whom, how a message reaches its target, sender identity, delivery. The postal system. It carries messages but decides *nothing* about what they mean or when to send them. The protocol is the routing substrate; the Mailroom is routing as a named capability — registered agents, stable addresses, delivery.

**2. Control plane — Tower.**
Managing agents as resources: spawn, kill, registry, lifecycle, health — plus the management frontend, the app a human uses to see and steer the fleet. The body-management layer. It brings agents up and down and shows their state. It decides nothing about the *work*; it manages the *workers*.

**3. Orchestration logic.**
The *what should happen*. Execute a scenario: which role does what, in what order, routing on verdicts, recasting on rejection, advancing on approval. This is neither routing nor control plane — it's the decision/workflow engine. It *uses* routing (to move messages) and the control plane (to spawn/kill agents), but it's its own concern. The brain, not the nervous system or the limbs.

The split is independently deferrable and independently replaceable:

- Routing without orchestration — agents talk, nobody's running a scenario.
- Control plane without orchestration — Tower manages agents a human drives by hand (the current PoC).
- Orchestration sits on top of both, deciding what neither decides.

The cloud-native world converged on exactly this split, independently: the **message bus** (routing), the **cluster control plane** like Kubernetes (lifecycle), and the **workflow engine** like Argo or Temporal (the logic). Three layers, three products, in every mature system. That it reappears here is a sign the separation is real, not a preference.

## What the orchestration logic does (the fleet)

The orchestration is automated Claude: Claude plans a mission with the human, writes it, and the system executes it across roles. A **role** (e.g. supervisor) has **functions** (check code quality, check the objective was met, check the brief matches reality); a function may be many **sessions** — a subagent per check.

The defining difference from CI/CD: **success isn't deterministic, it's judged.** CI/CD has `exit 0`; the fleet has "did the supervisor catch everything?" — a judgment, not a check. So the workflow branches on *verdicts*, not exit codes.

And the architecture handles this with no new machinery, because **a judge is just an agent whose output is a verdict.** The orchestrator routes work → judge → reads the verdict → routes on it — indifferent to whether the verdict came from a test runner or a Claude's judgment. The architecture is outcome-agnostic; subjectivity is invisible to it. This is why the concept holds without inventing anything: you didn't need a new mechanism for subjective success, you put a Claude where CI/CD puts a test runner.

Where the real design work lives, when it comes: the **scenario language**. A judgment-based workflow isn't a linear pipeline — it branches on subjective verdicts (approve / reject / revise → recast / advance / escalate). That's more than a DAG. But it's a scenario-spec concern, on top of the protocol, not an architecture gap. The architecture supports arbitrary branching; expressing it declaratively is the future pass.

## Implementation is open

Whether the orchestration logic is a program, a declarative scenario spec, or itself a Claude with routing tools is an implementation detail — and it can be more than one:

1. The control plane does it (Tower = lifecycle + orchestration).
2. A separate orchestrator service runs scenarios (Tower = control plane only).
3. The orchestrator is *an agent* — a Claude with routing tools (spawn / send / watch) driving other agents. The Router-as-Claude pattern, made first-class.

All three sit on the same protocol, so the choice doesn't have to be made up front. The protocol carries the orchestration regardless of who's doing it.

## Relationship to the harness

The harness (the agent) is the foundation. It is required, and it knows nothing of the layers above. Routing, control plane, and orchestration are all built *on* the protocol the harness speaks, and all are deferred from the harness's own scope.

This is the separation worth holding onto: a single declarative "harness spec" that does everything was the original instinct, but the cleaner shape is a **harness** (model- and language-agnostic, speaks the protocol) with the **orchestration layer** as a distinct thing above it. The harness functions alone; the orchestration is what turns many harnesses into a fleet. Keeping them separate is what keeps the harness clean enough to be the agnostic, reusable core — and lets the orchestration be a program, a spec, a model, or all three, without ever reaching back down into the harness.
