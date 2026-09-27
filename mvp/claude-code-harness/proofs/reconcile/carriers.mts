// Reconcile: what the resume column assumes about two carriers tower does
// not have. For each run and option, at step 1's result:
//   lost     the unshown entries (never seen by the model) a restart would
//            lose if each rode as a field on the next message committed at
//            or after its append: those appended after the option's last
//            committed message.
//   order    whether load() without `seq` (entries in tower's message order,
//            each message's ccEntries in its listed order, unshown entries
//            left out) gives the same order as `seq` for the entries tower
//            holds.
//
//   node proofs/reconcile/carriers.mts <rc-index.json> [...]

import { readFileSync } from 'node:fs';
import type { Json } from './holding.mts';
import { build, holdingAt, OPTIONS } from './holding.mts';
import { readRecording } from './recording.mts';

const out: Json[] = [];
for (const f of process.argv.slice(2)) {
  for (const row of JSON.parse(readFileSync(f, 'utf8')) as Json[]) {
    if (!row.rawDir) {
      continue;
    }
    const L = readRecording(String(row.rawDir), String(row.model));
    const at = L.step1ResultMs;
    if (at === undefined) {
      continue;
    }
    for (const option of OPTIONS) {
      const built = build(L.rec, option);
      const h = holdingAt(L.rec, option, at, built);
      const lastCommit = Math.max(...h.messages.map((m) => m.commitMs), Number.NEGATIVE_INFINITY);
      const lost = h.unshown.filter((r) => r.ms > lastCommit).map((r) => (r.entry.type === 'attachment' ? `attachment:${String((r.entry.attachment as Json).type)}` : r.entry.type === 'system' ? `system:${String(r.entry.subtype)}` : r.entry.isApiErrorMessage === true ? 'assistant:api-error' : String(r.entry.type)));
      const towerOrder = h.messages.flatMap((m) => m.cc.map((c) => c.seq));
      const seqOrder = [...towerOrder].sort((a, b) => a - b);
      out.push({ model: row.model, cell: row.cell, option, lost, sameOrder: JSON.stringify(towerOrder) === JSON.stringify(seqOrder) });
    }
  }
}
const models = [...new Set(out.map((o) => String(o.model)))].sort();
for (const option of OPTIONS) {
  const rs = out.filter((o) => o.option === option);
  const lostTypes = new Map<string, Set<string>>();
  for (const r of rs) {
    for (const t of new Set(r.lost as string[])) {
      lostTypes.set(t, (lostTypes.get(t) ?? new Set()).add(`${String(r.model).replace('claude-', '')}/${String(r.cell)}`));
    }
  }
  const order = models.map((m) => `${m.replace('claude-', '')} ${rs.filter((r) => r.model === m && r.sameOrder).length}/${rs.filter((r) => r.model === m).length}`).join(', ');
  process.stdout.write(`${option}: tower order = record order: ${order}\n`);
  for (const [t, where] of lostTypes) {
    process.stdout.write(`  lost ${t}: ${[...where].length} runs (${[...new Set([...where].map((w) => w.split('/')[1]))].join(', ')})\n`);
  }
}
