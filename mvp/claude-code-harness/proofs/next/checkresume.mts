// Proof 24: what a resume with resumeSessionAt did to the session. For each
// resume from a holding with resumeSessionAt, from its own store appends:
//   - the session id it appended under (the same as the main run's?)
//   - the parentUuid of the first entry it appended (the resumeSessionAt
//     entry?)
//   - which entries of the holding came after the resumeSessionAt entry (cut
//     by the resume)
//
//   node proofs/next/checkresume.mts <p24-index.json> [...]

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Json } from './history.mts';

function lines(path: string): Json[] {
  return existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as Json)
    : [];
}

for (const f of process.argv.slice(2)) {
  for (const row of JSON.parse(readFileSync(f, 'utf8')) as Json[]) {
    const holdings = JSON.parse(readFileSync(join(String(row.rawDir), 'holdings.json'), 'utf8')) as { way: string; entries: Json[]; resume?: Json }[];
    for (const [hash, res] of Object.entries(row.resumes as Record<string, Json>)) {
      const ways = res.ways as string[];
      const h = holdings.find((x) => ways.includes(x.way) && x.resume?.resumeSessionAt !== undefined);
      if (!h) {
        continue;
      }
      const at = String(h.resume?.resumeSessionAt);
      const idx = h.entries.findIndex((e) => e.uuid === at);
      const cut = h.entries.slice(idx + 1).map((e) => `${String(e.type)}${e.subtype ? `:${String(e.subtype)}` : ''}${(e.attachment as Json | undefined)?.type ? `:${String((e.attachment as Json).type)}` : ''}`);
      const appends = lines(join(String(res.rawDir), 'store-appends.jsonl')).filter((a) => !(a.key as Json).subpath);
      const sessions = [...new Set(appends.map((a) => String((a.key as Json).sessionId)))];
      const firstChained = appends.flatMap((a) => a.entries as Json[]).find((e) => typeof e.uuid === 'string');
      process.stdout.write(`${JSON.stringify({ model: row.model, cell: row.cell, way: ways[0], hash, sameSession: sessions.length === 1 && sessions[0] === row.sessionId, firstNewParentIsAt: firstChained?.parentUuid === at, firstNewType: firstChained?.type, cutAfterAt: cut })}\n`);
    }
  }
}
