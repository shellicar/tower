// concerns/rail.svelte.ts — the staleness rail's owned store (docs/mvp/
// frontend-architecture.md). It folds its OWN slices of three event families:
// rows (the staleness list), agent facts (liveness + potential conversations),
// and approval facts (the per-conversation pending marker). It reads no other
// concern's state; the filter/group/facet machine stays in the component
// (presentation). "agents" is not a separate concern yet — the rail is its
// only consumer, and a seam appears at the second (Decision 2, default owned).

import { type Clock, approvalVoid, livenessVerdict, systemClock } from '../core/time';
import type { Transport } from '../core/transport.svelte';
import type { AgentAttachment, AgentInstance, Millis, RowState, ServerMsg } from '../types';

export class Rail {
  #rows = $state<Map<string, RowState>>(new Map());
  #tagKeys = $state<Record<string, string>>({});
  #instances = $state<Map<string, AgentInstance>>(new Map());
  #attachments = $state<Map<string, AgentAttachment>>(new Map());
  /** approval id → just what the rail's marker needs: which conversation, how
   *  fresh the holder is, whether it has settled. The live-pending set is
   *  derived against the clock. */
  #asks = $state<Map<string, { conv?: string; lastPulse: Millis; settled: boolean }>>(new Map());
  /** The clock-fed `now` behind the time verdicts (liveness, void); the rail's
   *  own ticker cadence, the clock injected so the verdicts test (Decision 1). */
  #now = $state(0);
  readonly #clock: Clock;
  readonly #transport: Transport;

  constructor(transport: Transport, clock: Clock = systemClock) {
    this.#transport = transport;
    this.#clock = clock;
    this.#now = clock.now();
    setInterval(() => (this.#now = clock.now()), 30_000);
    transport.subscribe((event) => this.#fold(event));
  }

  #fold(event: ServerMsg): void {
    switch (event.type) {
      case 'list':
        this.#rows = new Map(event.rows.map((r) => [r.conv, r]));
        if (event.tagKeys) this.#tagKeys = event.tagKeys;
        break;
      case 'row': {
        // Upsert by conv; a row never carries annotations, so held title/tags
        // survive (a rename is not fleet activity and must not touch staleness).
        const held = this.#rows.get(event.conv);
        const next = new Map(this.#rows);
        next.set(event.conv, {
          conv: event.conv,
          lastEvent: event.lastEvent,
          lastKind: event.lastKind,
          title: held?.title,
          tags: held?.tags,
        });
        this.#rows = next;
        break;
      }
      case 'agents':
        this.#instances = new Map(event.instances.map((i) => [`${i.world}/${i.instanceId}`, i]));
        this.#attachments = new Map(
          event.attachments.map((a) => [`${a.world}/${a.instanceId}/${a.conv}`, a]),
        );
        break;
      case 'agent': {
        const ikey = `${event.world}/${event.instanceId}`;
        if (event.kind === 'ready' || event.kind === 'pulse') {
          const held = this.#instances.get(ikey);
          const next = new Map(this.#instances);
          next.set(ikey, {
            world: event.world,
            instanceId: event.instanceId,
            host: event.host ?? held?.host,
            lastPulse: Math.max(event.ts, held?.lastPulse ?? 0),
            intervalS: event.intervalS ?? held?.intervalS,
          });
          this.#instances = next;
        } else if (event.kind === 'attached' && event.conv) {
          // Attaching is itself evidence of life, and may carry the liveness
          // promise a `pulse` would otherwise be the only source of — the gap
          // where an instance that dies before its first pulse read as alive
          // forever (docs/spec/agent-spec.md).
          const heldInstance = this.#instances.get(ikey);
          const nextInstances = new Map(this.#instances);
          nextInstances.set(ikey, {
            world: event.world,
            instanceId: event.instanceId,
            host: heldInstance?.host,
            lastPulse: Math.max(event.ts, heldInstance?.lastPulse ?? 0),
            intervalS: event.intervalS ?? heldInstance?.intervalS,
          });
          this.#instances = nextInstances;
          const next = new Map(this.#attachments);
          next.set(`${ikey}/${event.conv}`, {
            world: event.world,
            instanceId: event.instanceId,
            conv: event.conv,
            cwd: event.cwd,
            attachedTs: event.ts,
          });
          this.#attachments = next;
        } else if (event.kind === 'detached' && event.conv) {
          const next = new Map(this.#attachments);
          next.delete(`${ikey}/${event.conv}`);
          this.#attachments = next;
        }
        break;
      }
      case 'approvals':
        this.#asks = new Map(
          event.approvals.map((a) => [
            a.id,
            {
              conv: a.correlation?.conversationId,
              lastPulse: a.lastPulse,
              settled: a.settled !== undefined,
            },
          ]),
        );
        break;
      case 'approval': {
        const next = new Map(this.#asks);
        next.set(event.id, {
          conv: event.correlation?.conversationId,
          lastPulse: event.lastPulse,
          settled: event.settled !== undefined,
        });
        this.#asks = next;
        break;
      }
      case 'attachment_dismissed': {
        // A human dismissed it (tower's own annotation, never a claim the
        // agent detached) — drop it, same as a real `detached` would.
        const next = new Map(this.#attachments);
        next.delete(`${event.world}/${event.instanceId}/${event.conv}`);
        this.#attachments = next;
        break;
      }
      default:
        break; // not the rail's concern
    }
  }

  /** Rows by lastEvent descending — the staleness order is the product. */
  get ordered(): RowState[] {
    return [...this.#rows.values()].sort((a, b) => b.lastEvent - a.lastEvent);
  }

  get tagKeys(): Record<string, string> {
    return this.#tagKeys;
  }

  /** The row for one conversation — its header facts and annotations. Read by
   *  the open panel's header and the approvals labels: a component may read any
   *  concern, so this is the one shared annotations store, not a copy per
   *  concern (Decision 2, sharing worth the risk — live rename across rail and
   *  panel is a real requirement, and annotations are low-churn, not a hot
   *  async fold). */
  row(conv: string): RowState | undefined {
    return this.#rows.get(conv);
  }

  /** The liveness verdict for a conversation, folded here against the rail's
   *  own clock — facts in, judgement out (agent-spec: a fold, never declared).
   *  null = no live attachment (released or never served). */
  verdict(conv: string): 'alive' | 'stranded' | null {
    const best = this.#liveness(conv);
    return best ? livenessVerdict(this.#now, best.lastPulse, best.intervalS) : null;
  }

  #liveness(conv: string): AgentInstance | null {
    let best: AgentInstance | null = null;
    for (const a of this.#attachments.values()) {
      if (a.conv !== conv) continue;
      const inst = this.#instances.get(`${a.world}/${a.instanceId}`);
      if (inst && (!best || inst.lastPulse > best.lastPulse)) best = inst;
    }
    return best;
  }

  /** Potential conversations: attached, no row yet — served, silent. Transient
   *  by design; they vanish with the attachment, and the first committed
   *  message births an ordinary row. Carries the liveness verdict, so a
   *  stranded one can offer Dismiss (the RailView pattern). */
  get attachedOnly(): (AgentAttachment & { verdict: 'alive' | 'stranded' | null })[] {
    const byConv = new Map<string, AgentAttachment>();
    for (const a of this.#attachments.values()) {
      if (!this.#rows.has(a.conv) && !byConv.has(a.conv)) byConv.set(a.conv, a);
    }
    return [...byConv.values()].map((a) => ({ ...a, verdict: this.verdict(a.conv) }));
  }

  /** Conversations with a LIVE pending ask (unsettled and not void), for the
   *  rail's marker — the rail's own slice of the approval stream, derived
   *  against its clock. */
  get pendingByConv(): Set<string> {
    const set = new Set<string>();
    for (const a of this.#asks.values()) {
      if (a.settled || a.conv === undefined) continue;
      if (approvalVoid(this.#now, a.lastPulse)) continue;
      set.add(a.conv);
    }
    return set;
  }

  // ---- annotations: optimistic self-patch, reconciled by the next `list` ----
  // Owned-facts the client can reproduce; the write leads, the reconnect
  // snapshot is the authority (ws-spec: refresh is the propagation).

  setTitle(conv: string, title: string): void {
    this.#transport.send({ type: 'set_title', id: this.#transport.id(), conv, title });
    const row = this.#rows.get(conv);
    if (!row) return;
    const next = new Map(this.#rows);
    next.set(conv, { ...row, title: title === '' ? undefined : title });
    this.#rows = next;
  }

  /** A human's own decision ("connection is authority") to stop tracking a
   *  stranded potential conversation — not a claim the agent detached (that
   *  fact stays the agent's alone to publish). Persisted server-side; the
   *  removal itself happens when the `attachment_dismissed` broadcast
   *  arrives back, same as any other fold. A no-op if nothing is attached
   *  under that conversation. */
  dismissAttachment(conv: string): void {
    const a = [...this.#attachments.values()].find((a) => a.conv === conv);
    if (!a) return;
    this.#transport.send({
      type: 'dismiss_attachment',
      id: this.#transport.id(),
      world: a.world,
      instanceId: a.instanceId,
      conv,
    });
  }

  setTag(conv: string, key: string, value: string): void {
    this.#transport.send({ type: 'set_tag', id: this.#transport.id(), conv, key, value });
    const row = this.#rows.get(conv);
    if (row) {
      const tags = { ...(row.tags ?? {}) };
      if (value === '') delete tags[key];
      else tags[key] = value;
      const next = new Map(this.#rows);
      next.set(conv, { ...row, tags });
      this.#rows = next;
    }
    // A brand-new key gets its real colour on the next `list`; a placeholder
    // keeps it renderable meanwhile.
    if (value !== '' && !this.#tagKeys[key]) {
      this.#tagKeys = { ...this.#tagKeys, [key]: '#888888' };
    }
  }
}
