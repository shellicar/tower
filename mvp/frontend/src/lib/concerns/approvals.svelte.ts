// concerns/approvals.svelte.ts — the approvals' owned store (docs/mvp/
// frontend-architecture.md). It folds its OWN slice of the approval stream:
// void is derived against its clock, answer is an id-correlated request, and
// the settlement arrives as an `approval` event like any other. This is the
// "shared value" done by events, not a shared store: the badge, the view, the
// rail marker, and the panel each fold what they need from the same stream —
// no approval surface is shared. The conversation LABEL for an ask comes from
// the rail/rows concern (the component reads it), not folded here.

import { type Clock, approvalVoid, systemClock } from '../core/time';
import type { Transport } from '../core/transport.svelte';
import type { ApprovalState, ServerMsg } from '../types';

export class Approvals {
  #approvals = $state<Map<string, ApprovalState>>(new Map());
  /** Transient outcome of the last answer per approval id, for display. */
  #answerNotes = $state<Map<string, string>>(new Map());
  #now = $state(0);
  readonly #clock: Clock;
  readonly #transport: Transport;

  constructor(transport: Transport, clock: Clock = systemClock) {
    this.#transport = transport;
    this.#clock = clock;
    this.#now = clock.now();
    setInterval(() => (this.#now = clock.now()), 1_000);
    transport.subscribe((event) => this.#fold(event));
  }

  #fold(event: ServerMsg): void {
    switch (event.type) {
      case 'approvals':
        // The outstanding snapshot replaces the map — once per connection.
        this.#approvals = new Map(event.approvals.map((a) => [a.id, a]));
        break;
      case 'approval': {
        // Upsert by id: an unknown id is a new ask being born.
        const { type: _type, ...state } = event;
        const next = new Map(this.#approvals);
        next.set(state.id, state);
        this.#approvals = next;
        break;
      }
      default:
        break; // not this concern's
    }
  }

  /** Pending asks oldest-first — a waiting Claude burns wall-clock. */
  get pendingApprovals(): ApprovalState[] {
    return [...this.#approvals.values()]
      .filter((a) => !a.settled)
      .sort((a, b) => a.raisedTs - b.raisedTs);
  }

  /** Void is this client's derivation (~3 missed 15s pulses): the holder died.
   *  A void ask stays visible, greyed, to be dismissed — not answered. */
  isVoid(a: ApprovalState): boolean {
    return approvalVoid(this.#now, a.lastPulse);
  }

  /** The asks actually waiting on a human: pending AND alive. */
  get liveApprovals(): ApprovalState[] {
    return this.pendingApprovals.filter((a) => !this.isVoid(a));
  }

  /** Live asks for one conversation — the panel's in-context answer surface. */
  liveForConv(conv: string): ApprovalState[] {
    return this.liveApprovals.filter((a) => a.correlation?.conversationId === conv);
  }

  answerNote(id: string): string | undefined {
    return this.#answerNotes.get(id);
  }

  /** Answer a pending approval. First valid answer wins; losing the race comes
   *  back as `rejected`/`already_settled` and is shown, not treated as error.
   *  The settlement arrives as an `approval` event. */
  async answer(id: string, approved: boolean): Promise<void> {
    const notes = new Map(this.#answerNotes);
    notes.delete(id);
    this.#answerNotes = notes;
    const res = await this.#transport.request({
      type: 'answer',
      id: this.#transport.id(),
      approval: id,
      approved,
    });
    if (res.type === 'answer_result' && res.outcome !== 'accepted') {
      const note =
        res.outcome === 'rejected' ? `rejected: ${res.reason}` : 'unreachable — the holder is gone';
      const next = new Map(this.#answerNotes);
      next.set(id, note);
      this.#answerNotes = next;
    }
  }

  /** Drop an ask from this client's view — local, not an answer (nobody settles
   *  an abandoned ask). Its holder pulsing again resurrects it, which is right. */
  dismiss(id: string): void {
    const next = new Map(this.#approvals);
    next.delete(id);
    this.#approvals = next;
  }
}
