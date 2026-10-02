// Prints one run's report.json as a method-by-shape table and writes it to matrix.md beside it.
//   node proof/matrix.ts <run>
import { readFileSync, writeFileSync } from 'node:fs';

type Method = { method: string; status: string; differences: string[] };
type Shape = { shape: string; methods: Method[] };

const run = process.argv[2] ?? 'r4';
const dir = new URL(`./out/${run}/`, import.meta.url);
const shapes = JSON.parse(readFileSync(new URL('report.json', dir), 'utf8')) as Shape[];

const names = [...new Set(shapes.flatMap((s) => s.methods.map((m) => m.method)))].sort();
const cell = (m: Method | undefined): string => {
  if (m === undefined) {
    return '-';
  }
  if (m.status === 'same') {
    return 'same';
  }
  if (m.status === 'same, noise only') {
    return 'same*';
  }
  if (m.status !== 'differs') {
    return m.status;
  }
  const where = [...new Set(m.differences.filter((d) => !d.startsWith(' ') && !d.startsWith('[noise')).map((d) => d.replace(/^(messages\[\d+\]|[^:\s]+).*$/, '$1')))];
  const compact = where.map((w) => w.replace(/^messages\[\d+\]$/, 'messages[]').replace(/^safeguards\.0\.classifier_context\./, 'safeguards.'));
  return `DIFF ${[...new Set(compact)].join(' ')}`;
};

const lines = [`# ${run}: each method's probe request against the local resume`, '', '`same*` is same apart from lines that two local resumes differ by as well.', '', `| method | ${shapes.map((s) => s.shape).join(' | ')} |`, `|---|${shapes.map(() => '---').join('|')}|`];
for (const name of names) {
  lines.push(`| \`${name}\` | ${shapes.map((s) => cell(s.methods.find((m) => m.method === name))).join(' | ')} |`);
}
writeFileSync(new URL('matrix.md', dir), `${lines.join('\n')}\n`);
process.stdout.write(`${lines.join('\n')}\n`);
