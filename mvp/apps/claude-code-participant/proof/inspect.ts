// Shows where two probe requests first differ inside each differing string.
//   node --import tsx proof/inspect.ts <a.json> <b.json>
import { readFileSync } from 'node:fs';

const [a, b] = process.argv.slice(2).map((path) => JSON.parse(readFileSync(path as string, 'utf8')) as unknown);

function walk(x: unknown, y: unknown, at: string): void {
  if (typeof x === 'string' && typeof y === 'string') {
    if (x !== y) {
      let i = 0;
      while (i < x.length && x[i] === y[i]) {
        i += 1;
      }
      console.log(`${at}: first difference at char ${i} of ${x.length}/${y.length}\n  a: …${JSON.stringify(x.slice(Math.max(0, i - 40), i + 120))}\n  b: …${JSON.stringify(y.slice(Math.max(0, i - 40), i + 120))}`);
    }
    return;
  }
  if (typeof x === 'object' && x !== null && typeof y === 'object' && y !== null) {
    for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) {
      walk((x as Record<string, unknown>)[key], (y as Record<string, unknown>)[key], `${at}.${key}`);
    }
    return;
  }
  if (JSON.stringify(x) !== JSON.stringify(y)) {
    console.log(`${at}: ${JSON.stringify(x)} vs ${JSON.stringify(y)}`);
  }
}

walk(a, b, '$');
