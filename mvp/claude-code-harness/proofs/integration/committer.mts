// Integration proof: the live committer. The incremental form of the offline
// build(rec, 'run') (proofs/reconcile/holding.mts; findings
// .claude/tasks/reconcile-tower-holding.md): on every event (a store append,
// a result, a recovery) it polls the request bodies, rebuilds 'run' over the
// recording so far, and publishes every message whose id tower doesn't have
// yet, in build order, each publish awaited for its JetStream ack before the
// next. So:
//   - reply pieces as they're saved (proof 24's H: each assistant entry at its
//     store append; a thinking-only piece held until a sibling with the same
//     message.id and other content arrives, or the next reply is marked
//     resumedFromIncompleteThinking; otherwise never committed; API error
//     notes are unshown),
//   - your side (prompts, tool results, reminders, the interrupt marker) in
//     the form the model received it, once the reply after it is kept
//     (reconcile's "run").
// A commit is a fact: a message already published is never published again.
// If a later build would give an already-published id a different body,
// that is recorded (committer.jsonl, kind `changed`) and nothing is sent: it
// would be a correction. Join 8 compares the published sequence with
// build(finalRecording, 'run') afterwards.
//
// Dry (a check resume): everything is computed and recorded as a
// would-publish, nothing reaches tower.
//
// TODO: undecided, each the easiest thing that runs:
//   - Carriers tower doesn't have yet: each message carries its entries' raw
//     fields and seq in `ccEntries` (reconcile's toBodies), and the entries
//     the model never sees (bookkeeping, attachments with no rendered text,
//     the API error notes) ride on the next committed message as
//     `ccUnshown: [{seq, entry}]` (reconcile found "run" can lose the tail of
//     them at a restart; nothing carries them before a next message).
//   - queryId: minted per say (a uuid); a message takes the queryId of the
//     latest say at or before its commit instant (a user side committed with
//     the next query's reply takes that next query's id). `recovered` when
//     no say is known in this lineage.
//   - turnId: build()'s (an assistant piece's is its response's message id;
//     a user-side message's is the request file it was committed from).
//   - from: reconcile's toBodies (human on a message holding a prompt, agent
//     on assistant pieces, absent otherwise).
//   - instanceId: one uuid per participant process.
//   - changes.query closure at each result, once every message due by then
//     is published; reason: success -> completed, interrupted by the
//     participant -> cancelled, any error subtype -> aborted.

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { build, type Built, type TMsg } from '../reconcile/holding.mts';
import { toBodies, type TowerBody } from '../reconcile/load.mts';
import type { Tower } from '../semantic/tower.mts';
import { appendJsonl, iso, type Json, readJsonl } from './lib.mts';
import { entryId, type Lineage } from './lineage.mts';

export interface PublishedLine {
  kind: 'message' | 'query' | 'seed';
  ts: string;
  ms: number;
  seq: number | null;
  subject: string;
  id: string;
  commitMs: number;
  hash: string;
  cc: string[];
  unshown: string[];
  queryId: string;
  instanceId: string;
  dry: boolean;
  index?: number;
}

export const NO_RESPONSE = 'No response requested.';

export function coreHash(b: TowerBody | Json): string {
  return createHash('sha256')
    .update(JSON.stringify({ id: b.id, role: b.role, turnId: b.turnId, content: b.content, ccEntries: b.ccEntries }))
    .digest('hex')
    .slice(0, 16);
}

export class Committer {
  readonly lin: Lineage;
  readonly convId: string;
  readonly instanceId: string;
  readonly dry: boolean;
  readonly tower: Tower | undefined;
  readonly log: (s: string) => void;
  readonly onPublish: (p: PublishedLine) => void;
  readonly published = new Map<string, string>(); // id -> hash
  readonly order: string[] = [];
  readonly carriedCc = new Set<string>();
  readonly carriedUnshown = new Set<string>();
  readonly closed = new Set<string>(); // `${queryId}@${resultMs}`
  readonly noted = new Set<string>();
  // Set by the participant for results it interrupted itself.
  private dirty = false;
  private running: Promise<void> | undefined;
  lastBuild: Built | undefined;
  failed: unknown;

  constructor(lin: Lineage, o: { convId: string; instanceId: string; dry: boolean; tower?: Tower; log: (s: string) => void; onPublish?: (p: PublishedLine) => void }) {
    this.lin = lin;
    this.convId = o.convId;
    this.instanceId = o.instanceId;
    this.dry = o.dry;
    this.tower = o.tower;
    this.log = o.log;
    this.onPublish = o.onPublish ?? (() => {});
    for (const p of readJsonl(join(lin.dir, 'published.jsonl')) as unknown as PublishedLine[]) {
      this.mark(p);
    }
  }

  private mark(p: PublishedLine): void {
    if (p.kind === 'query') {
      this.closed.add(`${p.queryId}@${p.commitMs}`);
      return;
    }
    if (!this.published.has(p.id)) {
      this.order.push(p.id);
    }
    this.published.set(p.id, p.hash);
    for (const c of p.cc) {
      this.carriedCc.add(c);
    }
    for (const u of p.unshown) {
      this.carriedUnshown.add(u);
    }
  }

  // Tower's messages when a lineage is seeded from tower: already committed.
  seedPublished(bodies: Json[]): void {
    for (const b of bodies) {
      const p: PublishedLine = {
        kind: 'seed',
        ts: iso(),
        ms: Date.now(),
        seq: null,
        subject: '',
        id: String(b.id),
        commitMs: 0,
        hash: coreHash(b),
        cc: ((b.ccEntries as Json[] | undefined) ?? []).map((c) => String(c.uuid)),
        unshown: ((b.ccUnshown as Json[] | undefined) ?? []).map((u) => entryId(u.entry as Json)),
        queryId: String(b.queryId),
        instanceId: String(b.instanceId ?? ''),
        dry: this.dry,
      };
      appendJsonl(join(this.lin.dir, 'published.jsonl'), p);
      this.mark(p);
    }
  }

  private note(kind: string, key: string, detail: Json): void {
    if (this.noted.has(`${kind}:${key}`)) {
      return;
    }
    this.noted.add(`${kind}:${key}`);
    appendJsonl(join(this.lin.dir, 'committer.jsonl'), { ts: iso(), ms: Date.now(), kind, ...detail });
    this.log(`committer ${this.convId.slice(0, 8)}: ${kind} ${JSON.stringify(detail).slice(0, 300)}`);
  }

  poke(): void {
    this.dirty = true;
    if (!this.running) {
      this.start();
    }
  }

  private start(): void {
    this.running = this.loop().finally(() => {
      this.running = undefined;
      // A poke that landed after the loop's last check.
      if (this.dirty) {
        this.start();
      }
    });
  }

  // Resolves once nothing is pending: every message due so far published
  // (acked) or recorded.
  async drain(): Promise<void> {
    this.poke();
    while (this.running) {
      await this.running;
    }
  }

  private async loop(): Promise<void> {
    while (this.dirty) {
      this.dirty = false;
      try {
        this.lin.pollBodies();
        const b = build(this.lin.rec, 'run');
        this.lastBuild = b;
        for (const w of b.orderWarnings) {
          this.note('order-warning', w, { warning: w });
        }
        await this.publishFrom(b);
        await this.closures(b);
      } catch (err) {
        this.failed = err;
        this.note('error', String(err), { error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
      }
    }
  }

  queryIdAt(ms: number): string {
    let q = 'recovered';
    for (const s of this.lin.says) {
      if (s.ms <= ms) {
        q = s.queryId;
      }
    }
    return q;
  }

  bodyOf(m: TMsg): TowerBody {
    const b = toBodies([m])[0] as TowerBody;
    return { ...b, instanceId: this.instanceId, queryId: this.queryIdAt(m.commitMs) } as TowerBody;
  }

  private async publish(leaf: string, body: Json): Promise<number | null> {
    if (this.dry || !this.tower) {
      return null;
    }
    const ack = await this.tower.js.publish(`conv.v2.${this.convId}.${leaf}`, JSON.stringify(body));
    return ack.seq;
  }

  private async publishFrom(b: Built): Promise<void> {
    const pos = new Map(b.all.map((m, i) => [m.id, i]));
    for (let i = 0; i < b.all.length; i += 1) {
      const m = b.all[i] as TMsg;
      const body = this.bodyOf(m);
      const h = coreHash(body);
      const had = this.published.get(m.id);
      if (had !== undefined) {
        if (had !== h) {
          this.note('changed', `${m.id}:${h}`, { id: m.id, publishedHash: had, nowHash: h, role: m.role, via: m.via });
        }
        continue;
      }
      if (m.cc.length > 0 && m.cc.every((c) => this.carriedCc.has(c.uuid))) {
        this.note('skip-held', m.id, { id: m.id, role: m.role, why: 'every entry already on tower' });
        continue;
      }
      const later = this.order.filter((id) => (pos.get(id) ?? -1) > i);
      if (later.length > 0) {
        this.note('late-insert', m.id, { id: m.id, role: m.role, before: later.slice(0, 5) });
      }
      if (JSON.stringify(m.content).includes(NO_RESPONSE)) {
        this.note('no-response-requested', m.id, { id: m.id, role: m.role });
      }
      const unshown = b.unshown.filter((r) => r.ms <= m.commitMs && !this.carriedUnshown.has(entryId(r.entry)));
      const full = { ...body, ccUnshown: unshown.map((r) => ({ seq: r.seq, entry: r.entry })) };
      const seq = await this.publish('changes.message', full);
      const p: PublishedLine = {
        kind: 'message',
        ts: iso(),
        ms: Date.now(),
        seq,
        subject: `conv.v2.${this.convId}.changes.message`,
        id: m.id,
        commitMs: m.commitMs,
        hash: h,
        cc: m.cc.map((c) => c.uuid),
        unshown: unshown.map((r) => entryId(r.entry)),
        queryId: body.queryId,
        instanceId: this.instanceId,
        dry: this.dry,
        index: i,
      };
      appendJsonl(join(this.lin.dir, 'published.jsonl'), p);
      this.mark(p);
      this.onPublish(p);
    }
  }

  private async closures(b: Built): Promise<void> {
    for (const r of this.lin.resultsFull) {
      const key = `${r.queryId}@${r.ms}`;
      if (this.closed.has(key)) {
        continue;
      }
      // Everything committed by the result's instant is published by now
      // (publishFrom ran over the same build); the closure follows it.
      const due = b.all.filter((m) => m.commitMs <= r.ms && !this.published.has(m.id) && !m.cc.every((c) => this.carriedCc.has(c.uuid)));
      if (due.length > 0) {
        continue;
      }
      const body = { ts: iso(r.ms), instanceId: this.instanceId, queryId: r.queryId, reason: r.reason };
      const seq = await this.publish('changes.query', body);
      const p: PublishedLine = { kind: 'query', ts: iso(), ms: Date.now(), seq, subject: `conv.v2.${this.convId}.changes.query`, id: r.queryId, commitMs: r.ms, hash: '', cc: [], unshown: [], queryId: r.queryId, instanceId: this.instanceId, dry: this.dry };
      appendJsonl(join(this.lin.dir, 'published.jsonl'), p);
      this.mark(p);
      this.onPublish(p);
    }
  }
}
