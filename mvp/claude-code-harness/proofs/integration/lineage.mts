// Integration proof: one conversation's recording, the thing the committer
// runs over. Durable (under INTEGRATION_STATE), shared by every process that
// serves the conversation on this machine, in reconcile's raw layout
// (proofs/reconcile/recording.mts) so the offline build() reads it too:
//
//   <lineage>/store-appends.jsonl  {ts, ms, key, entries, how}   every main-key
//                                  append (how: live | recovered | seed)
//   <lineage>/next-events.jsonl    {ts, ms, src, kind, ...}      request files
//                                  (src bodies), results (src sdk), says
//                                  (src participant)
//   <lineage>/api-bodies/          OTEL_LOG_RAW_API_BODIES for every Claude
//                                  Code serving this lineage
//   <lineage>/published.jsonl      every publish (or would-publish, dry), with
//                                  its JetStream sequence
//   <lineage>/committer.jsonl      what the committer noticed (a body that
//                                  would change, a late insert, a skip)
//   <lineage>/lineage.json         origin and what it was seeded from
//
// A lineage is one continuous recording. A conversation gets a new one when
// it is resumed from tower (seeded with tower's entries, marked as already
// committed): what this machine held before is then stale (tower is the
// authority), and mixing it into build() would misattribute requests. A dry
// check gets its own lineage, a copy of the real one as of an instant.
//
// Instants are Date.now() ms (lib.mts). A request's instant is its file's
// mtime.
//
// TODO: undecided. A request's instant: built as the body file's mtime
// (reconcile used when a 5 ms poll first saw it; the mtime also serves a
// file a crashed process never saw).
//
// TODO: undecided. Which request bodies the committer's recording takes:
// built as those with a thread or tools (proof 24/reconcile's own test for a
// main-loop request; the session-title request has neither). All are kept
// on disk. Found on Haiku 4.5: its title request uses the served model's
// dated id (claude-haiku-4-5-20251001, which build()'s startsWith counts as
// served) and its body file can carry the same mtime as the main request's;
// build()'s attribution window (entries before the next served request)
// is then empty and the first run is never committed.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IndexLine, Rec, Recording, Req } from '../reconcile/holding.mts';
import { appendJsonl, iso, type Json, readJsonl } from './lib.mts';

export type How = 'live' | 'recovered' | 'seed';

export interface LineageMeta {
  convId: string;
  name: string;
  origin: 'fresh' | 'local' | 'tower' | 'dry';
  createdAt: string;
  model: string;
  seededFromTower?: { upto: number; messages: number; entries: number };
  dryOf?: string;
  asOfMs?: number;
}

export interface Say {
  ms: number;
  queryId: string;
  text: string;
}

export interface Result {
  ms: number;
  queryId: string;
  subtype: string;
  reason: string;
}

// Proof 17's entry identity (orphan-tag.mts entryId/canon).
function canon(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canon).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const obj = value as Json;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export const entryId = (e: Json): string => (typeof e.uuid === 'string' ? `uuid:${e.uuid}` : `content:${canon(e)}`);

const mainLoop = (body: Json): boolean => body.thread !== undefined && body.thread !== null ? true : Array.isArray(body.tools) && body.tools.length > 0;

export function convRoot(agent: string, convId: string, root: string): string {
  return join(root, agent, 'conv', convId);
}

export class Lineage {
  readonly dir: string;
  readonly bodies: string;
  readonly meta: LineageMeta;
  readonly rec: Recording;
  readonly ids = new Set<string>();
  readonly says: Say[] = [];
  readonly resultsFull: Result[] = [];
  readonly seenRequests = new Set<string>();
  private nextSeq = 0;

  private constructor(dir: string, meta: LineageMeta) {
    this.dir = dir;
    this.bodies = join(dir, 'api-bodies');
    this.meta = meta;
    mkdirSync(this.bodies, { recursive: true });
    this.rec = { model: meta.model, entries: [], requests: [], index: [], results: [], tailTriggers: [] };
    for (const a of readJsonl(join(dir, 'store-appends.jsonl'))) {
      if ((a.key as Json | undefined)?.subpath) {
        continue;
      }
      for (const e of a.entries as Json[]) {
        this.push(e, Number(a.ms), typeof a.seq === 'number' && (a.entries as Json[]).length === 1 ? a.seq : undefined);
      }
    }
    for (const e of readJsonl(join(dir, 'next-events.jsonl'))) {
      if (e.src === 'bodies' && e.kind === 'request') {
        const p = join(this.bodies, String(e.file));
        this.seenRequests.add(String(e.file));
        if (existsSync(p)) {
          const body = JSON.parse(readFileSync(p, 'utf8')) as Json;
          if (mainLoop(body)) {
            this.rec.requests.push({ file: String(e.file), ms: Number(e.ms), body });
          }
        }
      } else if (e.src === 'sdk' && e.kind === 'result') {
        this.rec.results.push(Number(e.ms));
        this.resultsFull.push({ ms: Number(e.ms), queryId: String(e.queryId), subtype: String(e.subtype), reason: String(e.reason) });
      } else if (e.src === 'participant' && (e.kind === 'say' || e.kind === 'turn')) {
        this.says.push({ ms: Number(e.ms), queryId: String(e.queryId), text: String(e.text) });
      } else if (e.src === 'participant' && e.kind === 'tail-trigger') {
        (this.rec.tailTriggers as number[]).push(Number(e.ms));
      }
    }
    this.rec.requests.sort((a, b) => a.ms - b.ms);
    this.says.sort((a, b) => a.ms - b.ms);
  }

  static create(dir: string, meta: LineageMeta): Lineage {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'lineage.json'), `${JSON.stringify(meta, null, 2)}\n`);
    return new Lineage(dir, meta);
  }

  static open(dir: string): Lineage {
    const meta = JSON.parse(readFileSync(join(dir, 'lineage.json'), 'utf8')) as LineageMeta;
    return new Lineage(dir, meta);
  }

  private push(e: Json, ms: number, seq?: number): boolean {
    const id = entryId(e);
    if (this.ids.has(id)) {
      return false;
    }
    this.ids.add(id);
    const s = seq ?? this.nextSeq;
    this.nextSeq = Math.max(this.nextSeq, s + 1);
    this.rec.entries.push({ seq: s, ms, entry: e });
    return true;
  }

  has(e: Json): boolean {
    return this.ids.has(entryId(e));
  }

  // A store append (or recovered / seeded entries). Entries already held
  // (by uuid, or by content for entries without one) are skipped: a
  // store-resumed Claude Code that re-mirrors loaded entries adds nothing.
  append(key: Json, entries: Json[], how: How, ms: number = Date.now()): { added: Json[]; skipped: number } {
    if (key.subpath) {
      appendJsonl(join(this.dir, 'store-appends.jsonl'), { ts: iso(ms), ms, key, entries, how });
      return { added: [], skipped: 0 };
    }
    const added: Json[] = [];
    let skipped = 0;
    for (const e of entries) {
      if (this.push(e, ms)) {
        added.push(e);
      } else {
        skipped += 1;
      }
    }
    if (added.length > 0) {
      appendJsonl(join(this.dir, 'store-appends.jsonl'), { ts: iso(ms), ms, key, entries: added, how });
    }
    if (skipped > 0) {
      appendJsonl(join(this.dir, 'next-events.jsonl'), { ts: iso(), ms: Date.now(), src: 'store', kind: 'skipped-held', count: skipped, how });
    }
    return { added, skipped };
  }

  // Seeded entries keep the seq tower gave them (ccEntries' seq).
  seed(key: Json, entries: { seq: number; entry: Json }[], ms: number): void {
    for (const { seq, entry } of entries) {
      if (this.push(entry, ms, seq)) {
        appendJsonl(join(this.dir, 'store-appends.jsonl'), { ts: iso(ms), ms, key, entries: [entry], how: 'seed', seq });
      }
    }
  }

  // New request bodies since the last poll. Synchronous: run before every
  // build so a reply piece is never built before its request is known.
  pollBodies(): number {
    let names: string[];
    try {
      names = readdirSync(this.bodies);
    } catch {
      return 0;
    }
    let n = 0;
    for (const f of names.sort()) {
      if (this.seenRequests.has(f) || !f.endsWith('.request.json')) {
        continue;
      }
      const p = join(this.bodies, f);
      let body: Json;
      let mtimeMs: number;
      try {
        body = JSON.parse(readFileSync(p, 'utf8')) as Json;
        mtimeMs = statSync(p).mtimeMs;
      } catch {
        continue; // still being written
      }
      this.seenRequests.add(f);
      const req: Req = { file: f, ms: mtimeMs, body };
      if (mainLoop(body)) {
        this.rec.requests.push(req);
        this.rec.requests.sort((a, b) => a.ms - b.ms);
      }
      appendJsonl(join(this.dir, 'next-events.jsonl'), { ts: iso(mtimeMs), ms: mtimeMs, src: 'bodies', kind: 'request', file: f, seenMs: Date.now(), model: body.model, messages: Array.isArray(body.messages) ? body.messages.length : null });
      n += 1;
    }
    this.rec.index = readJsonl(join(this.bodies, 'index.jsonl')) as IndexLine[];
    return n;
  }

  addSay(s: Say, extra: Json = {}): void {
    this.says.push(s);
    appendJsonl(join(this.dir, 'next-events.jsonl'), { ts: iso(s.ms), ms: s.ms, src: 'participant', kind: 'say', queryId: s.queryId, text: s.text, ...extra });
  }

  // A queryId boundary that isn't a say: a turn Claude Code started itself
  // (its minted id, from `ms` on), or the pending say's id resuming after it.
  addTurn(s: Say, extra: Json = {}): void {
    this.says.push(s);
    this.says.sort((a, b) => a.ms - b.ms);
    appendJsonl(join(this.dir, 'next-events.jsonl'), { ts: iso(s.ms), ms: s.ms, src: 'participant', kind: 'turn', queryId: s.queryId, text: s.text, ...extra });
  }

  addResult(r: Result, extra: Json = {}): void {
    this.rec.results.push(r.ms);
    this.resultsFull.push(r);
    appendJsonl(join(this.dir, 'next-events.jsonl'), { ts: iso(r.ms), ms: r.ms, src: 'sdk', kind: 'result', queryId: r.queryId, subtype: r.subtype, reason: r.reason, ...extra });
  }

  // A crash recovery's own trigger (participant.mts's serve()): the last run
  // ended with no `result`, so run+last/run+entry's tail commit, which
  // otherwise only fires at a clean query end, would never fire at all.
  // Deliberately not a Result: it never touches changes.query (the wire
  // closure `reason` for this case is left open by design.md; see
  // committer.mts and participant.mts).
  addTailTrigger(ms: number, extra: Json = {}): void {
    (this.rec.tailTriggers as number[]).push(ms);
    appendJsonl(join(this.dir, 'next-events.jsonl'), { ts: iso(ms), ms, src: 'participant', kind: 'tail-trigger', ...extra });
  }

  event(kind: string, detail: Json = {}): void {
    appendJsonl(join(this.dir, 'next-events.jsonl'), { ts: iso(), ms: Date.now(), src: 'participant', kind, ...detail });
  }

  entriesUpTo(ms: number): Rec[] {
    return this.rec.entries.filter((r) => r.ms <= ms);
  }

  // A dry check's lineage: this one as of an instant (entries, requests,
  // says and results at or before it, publishes of messages committed at or
  // before it), so a check resume records what it would commit without
  // touching the real recording.
  copyAsOf(dir: string, asOfMs: number, name: string): Lineage {
    const meta: LineageMeta = { ...this.meta, name, origin: 'dry', createdAt: iso(), dryOf: this.dir, asOfMs };
    const d = Lineage.create(dir, meta);
    for (const a of readJsonl(join(this.dir, 'store-appends.jsonl'))) {
      if (Number(a.ms) <= asOfMs) {
        appendJsonl(join(dir, 'store-appends.jsonl'), a);
      }
    }
    for (const e of readJsonl(join(this.dir, 'next-events.jsonl'))) {
      if (Number(e.ms) <= asOfMs && ['request', 'result', 'say', 'turn', 'tail-trigger'].includes(String(e.kind))) {
        appendJsonl(join(dir, 'next-events.jsonl'), e);
        if (e.kind === 'request' && existsSync(join(this.bodies, String(e.file)))) {
          copyFileSync(join(this.bodies, String(e.file)), join(d.bodies, String(e.file)));
        }
      }
    }
    for (const l of readJsonl(join(this.bodies, 'index.jsonl'))) {
      if (existsSync(join(d.bodies, String(l.request_file)))) {
        appendJsonl(join(d.bodies, 'index.jsonl'), l);
      }
    }
    for (const p of readJsonl(join(this.dir, 'published.jsonl'))) {
      if (p.kind === 'message' && Number(p.commitMs) <= asOfMs) {
        appendJsonl(join(dir, 'published.jsonl'), { ...p, copiedFrom: this.dir });
      }
    }
    return Lineage.open(dir);
  }
}

// The conversation's current lineage on this machine, if any.
export function currentLineage(root: string): string | undefined {
  const p = join(root, 'current');
  if (!existsSync(p)) {
    return undefined;
  }
  const name = readFileSync(p, 'utf8').trim();
  return existsSync(join(root, name, 'lineage.json')) ? join(root, name) : undefined;
}

export function setCurrent(root: string, dir: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'current'), `${dir.slice(root.length + 1)}\n`);
}
