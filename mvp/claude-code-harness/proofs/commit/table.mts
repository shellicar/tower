// Proof 23: one table from several analysed rounds (the .summary.json files
// analyse.mts writes): per model and cell, where each round stopped, what
// Claude Code wrote after the prompt, and what the next request kept.
//
//   node proofs/commit/table.mts <summary.json> [...]

import { readFileSync } from 'node:fs';

type Json = Record<string, unknown>;

const rows = new Map<string, { file: string; c: Json }[]>();
for (const file of process.argv.slice(2)) {
  for (const c of JSON.parse(readFileSync(file, 'utf8')) as Json[]) {
    const key = `${String(c.model)} ${String(c.cell)}`;
    rows.set(key, [...(rows.get(key) ?? []), { file, c }]);
  }
}
const out: string[] = [];
for (const [key, runs] of [...rows].sort()) {
  out.push(`### ${key}`);
  for (const { file, c } of runs) {
    out.push(`- ${file}: actual ${String(c.actual)}${(c.streamedAfterStop as string[] | undefined)?.length ? `; streamed after the stop: ${(c.streamedAfterStop as string[]).join(', ')}` : ''}; store missed ${String(c.missingFromStore)}`);
    out.push(`  - wrote: ${((c.wrote as string[] | undefined) ?? []).slice(1).join(' | ') || '(nothing after the prompt)'}`);
    for (const [label, k] of Object.entries((c.kept ?? {}) as Record<string, Json>)) {
      const lines = (k.lines as string[] | undefined) ?? [];
      out.push(`  - kept (${label}, ${String(k.thread)}): ${k.continues ? `continues ${String(k.continues)}; ` : ''}prompt ${String(k.prompt)}; ${lines.join(' | ')}`);
    }
  }
  out.push('');
}
process.stdout.write(`${out.join('\n')}\n`);
