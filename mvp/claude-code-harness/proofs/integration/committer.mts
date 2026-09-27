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
// Integration attempt 3: the commit option is a variant, run+last or
// run+entry (build()'s options of those names: at each query's end the
// unfinished tail is committed in the form its latest request sent it, or as
// written), passed on every serve. Bugs 1 and 2 are fixed in build()
// (BuildOpts gateReplies, placeUnanchored), always on here, and a reply piece
// is published only once every entry of the user side it answers is on tower
// (acked). A shadow committer (TODO: undecided, a test method, not the
// participant's design) computes the other variant over the same recording
// and publishes it under the conversation id `<id>~shadow`, with its own
// records (published.shadow.jsonl, committer.shadow.jsonl).
//
// TODO: undecided. Whether the participant carries a variant choice at all,
// and whether it has a default: here the serve must name one (no default).
//
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
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build, type BuildOpts, type Built, kindOf, type TMsg } from '../reconcile/holding.mts';
import { toBodies, type TowerBody } from '../reconcile/load.mts';
import type { Tower } from '../semantic/tower.mts';
import { appendJsonl, iso, type Json, readJsonl } from './lib.mts';
import { entryId, type Lineage } from './lineage.mts';

export interface PublishedLine {
  kind: 'message' | 'query' | 'seed' | 'held';
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

export type CommitOption = 'run+last' | 'run+entry';
export const COMMIT_OPTIONS: CommitOption[] = ['run+last', 'run+entry'];

export class Committer {
  readonly lin: Lineage;
  readonly convId: string;
  readonly option: CommitOption;
  // '' for the live committer, '.shadow' for the shadow.
  readonly suffix: string;
  readonly subjectId: string;
  shadow: Committer | undefined;
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
  // Part B's variants (each TODO: undecided): build options, and whether the
  // held user side is published at each query's end (held-carrier).
  readonly opts: BuildOpts;
  readonly heldCarrier: boolean;
  readonly heldAt = new Set<string>();

  constructor(lin: Lineage, o: { convId: string; instanceId: string; dry: boolean; tower?: Tower; log: (s: string) => void; onPublish?: (p: PublishedLine) => void; variants?: string[]; option: CommitOption; shadow?: boolean }) {
    this.lin = lin;
    this.convId = o.convId;
    if (!COMMIT_OPTIONS.includes(o.option)) {
      throw new Error(`commit option ${String(o.option)}: must be one of ${COMMIT_OPTIONS.join(', ')}`);
    }
    this.option = o.option;
    this.suffix = o.shadow ? '.shadow' : '';
    this.subjectId = o.shadow ? `${o.convId}~shadow` : o.convId;
    this.shadow = undefined;
    this.instanceId = o.instanceId;
    this.dry = o.dry;
    this.tower = o.tower;
    this.log = o.log;
    this.onPublish = o.onPublish ?? (() => {});
    const v = new Set(o.variants ?? []);
    this.opts = { gateReplies: true, placeUnanchored: true, ...(v.has('commit-dangling') ? { commitDangling: true } : {}), ...(v.has('anchor-fallback') ? { anchorFallback: true } : {}) };
    this.heldCarrier = v.has('held-carrier');
    // The offline build (join 8) reads the same options.
    writeFileSync(join(lin.dir, `build-options${this.suffix}.json`), `${JSON.stringify({ option: this.option, opts: this.opts, variants: [...v] })}\n`);
    for (const p of readJsonl(this.file('published')) as unknown as PublishedLine[]) {
      this.mark(p);
    }
  }

  file(name: 'published' | 'committer'): string {
    return join(this.lin.dir, `${name}${this.suffix}.jsonl`);
  }

  private mark(p: PublishedLine): void {
    if (p.kind === 'query') {
      this.closed.add(`${p.queryId}@${p.commitMs}`);
      return;
    }
    if (p.kind === 'held') {
      this.heldAt.add(`${p.queryId}@${p.commitMs}`);
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
      appendJsonl(this.file('published'), p);
      this.mark(p);
    }
  }

  private note(kind: string, key: string, detail: Json): void {
    if (this.noted.has(`${kind}:${key}`)) {
      return;
    }
    this.noted.add(`${kind}:${key}`);
    appendJsonl(this.file('committer'), { ts: iso(), ms: Date.now(), kind, option: this.option, ...detail });
    this.log(`committer${this.suffix} ${this.option} ${this.convId.slice(0, 8)}: ${kind} ${JSON.stringify(detail).slice(0, 300)}`);
  }

  poke(): void {
    this.shadow?.poke();
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
    await this.shadow?.drain();
  }

  private async loop(): Promise<void> {
    while (this.dirty) {
      this.dirty = false;
      try {
        this.lin.pollBodies();
        const b = build(this.lin.rec, this.option, { ...this.opts, alreadyCommitted: this.lin.seeded });
        this.lastBuild = b;
        for (const w of b.orderWarnings) {
          this.note('order-warning', w, { warning: w });
        }
        for (const u of b.unanchored) {
          this.note('unanchored', u.file, { file: u.file, reason: u.reason, fallback: u.fallback });
        }
        // Reply pieces never committed because what they answer has no place
        // (a piece tower already holds, seeded from it, isn't ours to hold).
        for (const h of b.heldReplies) {
          if (!this.carriedCc.has(h.uuid)) {
            this.note('reply-held', h.uuid, { uuid: h.uuid, why: h.why });
          }
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
    const ack = await this.tower.js.publish(`conv.v2.${this.subjectId}.${leaf}`, JSON.stringify(body));
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
      // Bug 1's fix, at publish: a reply piece goes out only once every entry
      // of the user side it answers is on tower (acked). Build order puts
      // that user side first; if it isn't on tower, nothing after it goes.
      const answers = b.answers.get(m.id);
      if (m.role === 'assistant' && answers && !answers.every((u) => this.carriedCc.has(u))) {
        this.note('reply-waits', m.id, { id: m.id, missing: answers.filter((u) => !this.carriedCc.has(u)) });
        break;
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
        subject: `conv.v2.${this.subjectId}.changes.message`,
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
      appendJsonl(this.file('published'), p);
      this.mark(p);
      this.onPublish(p);
    }
  }

  // held-carrier (TODO: undecided, Part B way 4): at a query's end, the user
  // side "run" still holds (carriers by then that no committed message
  // carries) rides on tower as raw entries on a leaf of its own, never shown
  // and never a message, so a resume from tower can hand them to Claude Code
  // (load() adds them) instead of ending on a dangling tool_use. An empty
  // record is published too when an earlier one held something, so the
  // latest record is always what is held now.
  private async publishHeld(b: Built, ms: number, queryId: string): Promise<void> {
    const inMessages = new Set(b.all.filter((m) => m.commitMs <= ms).flatMap((m) => m.cc.map((c) => c.uuid)));
    const held = this.lin.rec.entries.filter((r) => r.ms <= ms && kindOf(r.entry) === 'carrier' && !inMessages.has(String(r.entry.uuid)) && !this.carriedCc.has(String(r.entry.uuid)));
    if (held.length === 0 && this.heldAt.size === 0) {
      return;
    }
    const body = { ts: iso(ms), instanceId: this.instanceId, queryId, entries: held.map((r) => ({ seq: r.seq, entry: r.entry })) };
    const seq = await this.publish('changes.held', body);
    const p: PublishedLine = { kind: 'held', ts: iso(), ms: Date.now(), seq, subject: `conv.v2.${this.subjectId}.changes.held`, id: `held@${ms}`, commitMs: ms, hash: '', cc: held.map((r) => String(r.entry.uuid)), unshown: [], queryId, instanceId: this.instanceId, dry: this.dry };
    appendJsonl(this.file('published'), p);
    this.mark(p);
    this.onPublish(p);
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
      if (this.heldCarrier && !this.heldAt.has(key)) {
        await this.publishHeld(b, r.ms, r.queryId);
      }
      const body = { ts: iso(r.ms), instanceId: this.instanceId, queryId: r.queryId, reason: r.reason };
      const seq = await this.publish('changes.query', body);
      const p: PublishedLine = { kind: 'query', ts: iso(), ms: Date.now(), seq, subject: `conv.v2.${this.subjectId}.changes.query`, id: r.queryId, commitMs: r.ms, hash: '', cc: [], unshown: [], queryId: r.queryId, instanceId: this.instanceId, dry: this.dry };
      appendJsonl(this.file('published'), p);
      this.mark(p);
      this.onPublish(p);
    }
  }
}
