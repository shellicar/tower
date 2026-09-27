// Reconcile, offline: every option over recorded runs (proof 24's raw main
// directories, or this proof's), history and timing only; no resume.
//
//   node proofs/reconcile/offline.mts <raw dir> [...]   (JSON lines out)

import { basename } from 'node:path';
import type { Json } from './holding.mts';
import { assistantCommits, build, foldPrediction, holdingAt, kindOf, OPTIONS, sameForm } from './holding.mts';
import { compareUnits, describeEntry, probeHistory, requestUnits, towerBeforeProbeReply, towerUnits } from './compare.mts';
import { roundTrip } from './load.mts';
import { readRecording } from './recording.mts';

export const PROBE = 'Reply with the word NEXT only.';

const MODELS: Record<string, string> = { sonnet5: 'claude-sonnet-5', opus55: 'claude-opus-5-5', fable51: 'claude-fable-5-1', haiku45: 'claude-haiku-4-5' };

export function modelFromDir(dir: string): string {
  const m = /-(sonnet5|opus55|fable51|haiku45)-/.exec(basename(dir));
  if (!m) {
    throw new Error(`no model in ${dir}`);
  }
  return MODELS[m[1] as string] as string;
}

const pct = (xs: number[], p: number): number | null => {
  if (xs.length === 0) {
    return null;
  }
  const s = [...xs].sort((a, b) => a - b);
  return Math.round((s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] as number) * 10) / 10;
};

export function analyse(rawDir: string, model = modelFromDir(rawDir)): Json {
  const L = readRecording(rawDir, model);
  const { rec } = L;
  const describe = describeEntry(rec);
  const probe = probeHistory(L.bodiesDir, rec, PROBE);
  const probeReq = probe ? rec.requests.find((r) => r.file === probe.file) : undefined;
  const reqUnits = probe ? requestUnits(rec, probe.messages) : undefined;
  const raw = new Map(rec.entries.map((r) => [String(r.entry.uuid), r.entry]));
  // Where step 1 actually ended.
  const send1 = L.events.find((e) => e.src === 'proof' && e.kind === 'send' && e.step === 1);
  const stop = L.events.find((e) => e.src === 'proof' && e.kind === 'stop');
  const win = rec.entries.filter((r) => send1 && r.ms >= Number(send1.ms) && r.ms <= (L.step1ResultMs ?? 0));
  const commits = assistantCommits(rec);
  const ending = {
    cell: (/-(normal|thinking-only|limit|api-error|first-byte|thinking|mid-text|tool-input|tool-exec|[a-z-]+)$/.exec(basename(rawDir)) ?? [])[1] ?? null,
    stopped: stop ? (L.step1ResultMs !== undefined && Number(stop.ms) > L.step1ResultMs ? 'after the result' : String(stop.how)) : null,
    keptReply: win.some((r) => commits.has(String(r.entry.uuid))),
    droppedThinking: win.filter((r) => kindOf(r.entry) === 'assistant' && !commits.has(String(r.entry.uuid))).length,
    apiErrors: win.filter((r) => r.entry.isApiErrorMessage === true).length,
    partial: win.some((r) => r.entry.isAbortedMidStream === true),
  };
  const out: Json = { rawDir, model, ending, probe: probe?.file ?? null, requestShape: null, unattributed: reqUnits?.unattributed ?? null, options: {} };
  for (const option of OPTIONS) {
    const built = build(rec, option);
    const o: Json = { orderWarnings: built.orderWarnings };
    if (probe && probeReq && reqUnits) {
      const final = towerBeforeProbeReply(built.all, probeReq.ms, rec);
      const v = compareUnits(reqUnits.units, towerUnits(final), describe);
      o.final = v;
      out.requestShape = v.shape.request;
    }
    if (L.step1ResultMs !== undefined && probe && reqUnits) {
      const h = holdingAt(rec, option, L.step1ResultMs, built);
      // Against the probe's request less the probe's own entries (appended
      // after the result): what a resume at the result should rebuild.
      const later = new Set(rec.entries.filter((r) => r.ms > (L.step1ResultMs as number)).map((r) => String(r.entry.uuid)));
      const before = reqUnits.units.map((u) => ({ role: u.role, items: u.items.filter((i) => i.uuid === null || !later.has(i.uuid)) })).filter((u) => u.items.length > 0);
      const v = compareUnits(before, towerUnits(h.messages), describe);
      o.atResult = { kinds: v.kinds, missing: v.missing, placement: v.placement, notCommitted: h.notCommitted.map((r) => describe(String(r.entry.uuid))), messages: h.messages.length, shape: v.shape.tower };
      const rt = roundTrip(h, raw);
      o.roundTrip = { same: rt.same, differ: rt.differ.slice(0, 5) };
    }
    // R1: per entry the model sees, commit instant minus store append.
    const commitOf = new Map<string, number>();
    for (const m of built.all) {
      for (const c of m.cc) {
        if (!commitOf.has(c.uuid)) {
          commitOf.set(c.uuid, m.commitMs);
        }
      }
    }
    const lag: number[] = [];
    const lagUser: number[] = [];
    let never = 0;
    for (const r of rec.entries) {
      const k = kindOf(r.entry);
      if (k === 'unshown') {
        continue;
      }
      const c = commitOf.get(String(r.entry.uuid));
      if (c === undefined) {
        if (k === 'carrier') {
          never += 1;
        }
        continue;
      }
      lag.push(c - r.ms);
      if (k === 'carrier') {
        lagUser.push(c - r.ms);
      }
    }
    o.r1 = { userSide: { median: pct(lagUser, 50), max: pct(lagUser, 100), n: lagUser.length }, all: { median: pct(lag, 50), max: pct(lag, 100) }, neverCommitted: never };
    (out.options as Json)[option] = o;
  }
  // Form source: the body against proof 16's fold prediction, per main
  // request with a kept reply.
  const mains = build(rec, 'run').mains.filter((m) => m.firstReplyMs !== undefined);
  out.foldMatchesBody = `${mains.filter((m) => sameForm(m.form, foldPrediction(rec, m))).length}/${mains.length}`;
  // Placement known / fate known per carrier (advisor's two instants).
  const allMains = build(rec, 'run').mains;
  const placedAt = new Map<string, number>();
  const fateAt = new Map<string, number>();
  for (const m of allMains) {
    for (const f of m.form) {
      for (const c of f.ccEntries) {
        if (!placedAt.has(c.uuid)) {
          placedAt.set(c.uuid, m.req.ms);
        }
        if (!fateAt.has(c.uuid) && m.firstReplyMs !== undefined) {
          fateAt.set(c.uuid, m.firstReplyMs);
        }
      }
    }
  }
  const placedLag: number[] = [];
  const fateLag: number[] = [];
  for (const r of rec.entries) {
    if (kindOf(r.entry) !== 'carrier') {
      continue;
    }
    const p = placedAt.get(String(r.entry.uuid));
    const f = fateAt.get(String(r.entry.uuid));
    if (p !== undefined) {
      placedLag.push(p - r.ms);
    }
    if (f !== undefined) {
      fateLag.push(f - r.ms);
    }
  }
  out.instants = { placedAfterAppend: { median: pct(placedLag, 50), min: pct(placedLag, 0), max: pct(placedLag, 100) }, fateAfterAppend: { median: pct(fateLag, 50), max: pct(fateLag, 100) } };
  return out;
}

if (import.meta.main) {
  for (const d of process.argv.slice(2)) {
    try {
      process.stdout.write(`${JSON.stringify(analyse(d))}\n`);
    } catch (err) {
      process.stdout.write(`${JSON.stringify({ rawDir: d, error: err instanceof Error ? err.stack : String(err) })}\n`);
    }
  }
}
