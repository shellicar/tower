# Roadmap: CLI to tower v1

How to get from the current state — the fleet run by hand over tmux — to tower v1,
in stages that are each independently valuable and none of which depend on the
one after. Read alongside `project-state.md` (where the design stands) and
`orchestration-layer.md` (the three-concern split this roadmap keeps honest).

The proof this rests on: the NATS POC (prompt3). Four components built by four
sessions that never saw each other's code interoperated on first contact, because the
spec was the only surface. The same discipline — protocol as the only coupling —
is what makes every stage below safe to attempt and safe to abandon.

## The metaphor

Nobody manages 200 servers by ssh'ing to each one; they manage centrally — and keep
ssh as the fallback. Today the fleet IS managed by ssh: window-hopping, capture-pane,
send-keys. Tower is the central management plane. `tmux attach` is ssh, and it stays.

## Principles

1. **Additive by default.** Every stage adds a surface; none quietly removes one.
   Agent chat stays reachable (attach to the pane; later, attach via protocol). Files
   stay reachable (the slaved viewport, or the worktree directly). Existing ways of
   working are superseded and left standing, not migrated away. If a fork in the road
   ever genuinely demands removing a capability, that is a real decision made at the
   fork — what this principle rules out is capability disappearing as a side effect.

2. **The mission model is data, not code.** Per the fleet VISION: the structure —
   missions, roles, phases — is compensation for substrate and economic constraints,
   and is expected to change as those move. A mission is a way to coordinate multiple
   LLM sessions toward a goal; that is the whole definition the apps may rely on.
   The daemon routes on opaque signals; the dashboard renders what arrives; what
   happens after a signal lives in a scenario spec (or a Claude), never compiled into
   an app. Changing the model must mean editing a spec, not three codebases.

3. **The review surface is a first-class surface.** Review is where the SC's time
   actually goes. The unit of review is the mission: debrief, diff, verdict actions
   in one place. It arrives late (stage 6) but constrains early: signals carry
   debrief pointers from the start so the review surface can exist later without
   re-plumbing.

4. **Attention slaving.** The file viewport follows the agent being attended — it is
   a projection of the attended session, not an independently navigated surface. The
   existing tmux `pane-focus-in` → VS Code workspace-retarget script is the working
   model: the keyboard stays with the conversation; the files follow. Chat and files
   on demand, per principle 1.

5. **Mission kinds.** Software-development missions, fleet/AI-infrastructure
   missions, environment missions (dotfiles, tmux) — the per-server tmux/VS Code
   split is this taxonomy made physical. "Repo + branch + PR" is one kind of mission,
   not the definition. Queue views and the review surface must not assume every
   mission ends in a diff.

Tower is not the assistant. The VISION's assistant — one interface that makes
everything happen behind the scenes — is a Claude. Tower is that assistant's window:
the one place to see what is going on. The AIDE leaves room for the assistant; it
does not implement it.

Tower is also not the only view. Any consumer of the same events is a peer of the
dashboard — an SDLC tool making the agent a first-class concern on a work item
(lifecycle events as PBI comments, a status badge, a click-through to the tower
panel) is the canonical example. That costs a subscriber, not a redesign; nothing
about tower's view is privileged.

## Stages

Node is never fixed, only vacated. The capabilities node blocks (images, persistence,
distribution) land on the Rust side where they are trivial, at the stage where they
belong. The protocol is the only coupling between stages.

### Stage 1 — See

A NATS event tap in the existing node CLI: publish `{conversation, run, event type,
timestamp}` on the conversation's events subject for run, turn, tool, and approval
activity (idle is a derived state — quiet since the last event — not an event).
See `tap-spec.md` for the contract. Pure-JS NATS
client — deliberately no new native dependencies. The POC tower dashboard adapts to
the real fleet: one panel per conversation, ordered by last activity.

The tap also publishes per-turn `usage` events (tokens, cost) — the CLI already has
the data — and the broker retains the stream (JetStream), so unheard events are
recorded, not lost. This is the Cage's *record now, analyse later*: the analytics substrate
exists before any dashboard asks questions of it.

*Value: the ~110-session fleet becomes visible — "mission X quiet 2 hours."*
*Retires: window-hopping as monitoring.*

### Stage 2 — Signal

Done stops being something the SC notices and becomes something the session says: a
tool in the CLI that publishes `phase_done` with a debrief pointer. The dashboard
distinguishes working / waiting-on-you / done.

Signals leave room for a prediction to ride — run-level in the run-start label,
phase-level as an optional field on `phase_done` (the tap spec carries the single
story) — and it can stay empty for a year. When one is made, it is timestamped
before the work and scoreable after — the record the bookie will need, captured
from the start.

*Value: state is declared, not guessed.*
*Retires: capture-pane-and-classify.*

### Stage 3 — Orchestrate one hop

The dispatch daemon — the first production Rust component, deliberately tiny.
Subscribes to `phase_done`; on operator-done, spawns the supervisor via tmux exactly
as the current scripts do, delivers the brief as a message, and on supervisor-done
notifies the SC (alerter). It routes on signals and interprets nothing; the
operator → supervisor → notify chain is read from a scenario spec, not hard-coded
(principle 2).

*Value: operator → supervisor → SC unattended — roughly two-thirds of the current
interaction removed.*
*Retires: Claude-as-Router for the mechanical hop.*

### Stage 4 — The real agent

The POC agent grows into the architecture docs' headless agent: real Messages API,
auth, tools, audit. Persistence lands here (bundled SQLite, no ABI pain); images stop
needing sharp. New sessions run on it; node sessions keep working over the same
subjects until they drain.

*Value: the fleet substrate stops being node — version pinning and native-module
grief end structurally, not by workaround.*
*Retires: the node wrapper double-processes.*

### Stage 5 — The Rust TUI

The POC TUI grows against the real agent, implementing the tui-architecture doc's
layer contract (the cell grid; the ghost class impossible by construction). A single
static binary: the distributable client app exists.

*Value: node independence for anything installed on someone else's machine.*
*Retires: the node CLI as the human-facing client.*

### Stage 6 — Tower proper

The daemon takes over spawning from tmux (control plane). Missions become first-class
in the dashboard: queue and activity views, verdict routing, and the review surface —
per-mission debrief, diff, and verdict actions, with "open in editor" as the
attention-slaved escape hatch.

*Value: the AIDE surface — agent-based, not file-based.*
*Retires: tmux as orchestrator. Never tmux as terminal, and never the attach
fallback.*

This stage is not the summit; it is the trailhead of the next leg. The full AIDE —
the review surface matured, the bookie, the assistant's window — starts here and
gets its own document when it is real.

## What this roadmap does not decide

- The scenario-spec language (stage 3 starts with the smallest thing that is data).
- Session resume/persistence/transfer design (deferred in project-state.md; the
  audit floor covers it).
- Whether the orchestration logic is ultimately a program, a spec, or a Claude — the
  protocol carries all three (orchestration-layer.md), and stage 3 deliberately does
  not foreclose it.
