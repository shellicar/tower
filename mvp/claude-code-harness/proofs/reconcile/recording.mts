// Reconcile: a run's recording, read back from its raw directory (proof 24's
// layout, which this proof's runner keeps): store-appends.jsonl,
// next-events.jsonl, api-bodies/.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IndexLine, Json, Recording, Rec, Req } from './holding.mts';

export function lines(path: string): Json[] {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Json);
}

export interface Loaded {
  rec: Recording;
  events: Json[];
  bodiesDir: string;
  step1ResultMs: number | undefined;
  probeSendMs: number | undefined;
}

export function readRecording(rawDir: string, model: string): Loaded {
  const bodiesDir = join(rawDir, 'api-bodies');
  const events = lines(join(rawDir, 'next-events.jsonl'));
  const entries: Rec[] = [];
  for (const a of lines(join(rawDir, 'store-appends.jsonl'))) {
    if ((a.key as Json | undefined)?.subpath) {
      continue;
    }
    for (const e of a.entries as Json[]) {
      entries.push({ seq: entries.length, ms: Number(a.ms), entry: e });
    }
  }
  const requests: Req[] = [];
  for (const e of events) {
    if (e.src === 'bodies' && e.kind === 'request') {
      const p = join(bodiesDir, String(e.file));
      if (existsSync(p)) {
        requests.push({ file: String(e.file), ms: Number(e.ms), body: JSON.parse(readFileSync(p, 'utf8')) as Json });
      }
    }
  }
  const index = lines(join(bodiesDir, 'index.jsonl')) as IndexLine[];
  const results = events.filter((e) => e.src === 'sdk' && e.kind === 'result').map((e) => Number(e.ms));
  const step1 = events.find((e) => e.src === 'proof' && e.kind === 'step1-result');
  const probe = events.find((e) => e.src === 'proof' && e.kind === 'send' && e.step === 2);
  return { rec: { model, entries, requests, index, results }, events, bodiesDir, step1ResultMs: step1 ? Number(step1.ms) : undefined, probeSendMs: probe ? Number(probe.ms) : undefined };
}
