// Reads, for each method of each shape, the API's own account of the probe request's cache use (the
// response's usage and diagnostics.cache_miss_reason, from Claude Code's body log), and writes
// usage.json and usage.md in the run's directory.
//   node proof/usage.ts <run>
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Json = Record<string, unknown>;
const run = process.argv[2] ?? 'r4';
const root = new URL(`./out/${run}/`, import.meta.url).pathname;

function lastUserText(body: Json): string {
  const last = [...((body.messages ?? []) as Json[])].reverse().find((m) => m.role === 'user');
  const content = last?.content;
  if (typeof content === 'string') {
    return content;
  }
  return Array.isArray(content) ? (content as Json[]).map((b) => (typeof b.text === 'string' ? b.text : '')).join('\n') : '';
}

const rows: Record<string, Record<string, Json>> = {};
for (const shape of readdirSync(root).filter((s) => existsSync(join(root, s, 'methods')))) {
  for (const method of readdirSync(join(root, shape, 'methods')).sort()) {
    const bodies = join(root, shape, 'methods', method, 'bodies');
    if (!existsSync(join(bodies, 'index.jsonl'))) {
      continue;
    }
    for (const line of readFileSync(join(bodies, 'index.jsonl'), 'utf8').split('\n').filter(Boolean)) {
      const entry = JSON.parse(line) as Json;
      const request = JSON.parse(readFileSync(join(bodies, String(entry.request_file)), 'utf8')) as Json;
      if (!Array.isArray(request.tools) || request.tools.length === 0 || !lastUserText(request).includes(`PROBE-${shape.toUpperCase()}`)) {
        continue;
      }
      const responseFile = join(bodies, String(entry.response_file));
      if (!existsSync(responseFile)) {
        continue;
      }
      // Kept beside the probe request so the cache numbers can be checked without the ignored body log.
      copyFileSync(responseFile, join(root, shape, 'methods', method, 'probe.response.json'));
      const response = JSON.parse(readFileSync(responseFile, 'utf8')) as Json;
      const usage = (response.usage ?? {}) as Json;
      const miss = ((response.diagnostics ?? {}) as Json).cache_miss_reason as Json | undefined;
      (rows[method] ??= {})[shape] = { cacheRead: usage.cache_read_input_tokens, cacheCreation: usage.cache_creation_input_tokens, input: usage.input_tokens, missReason: miss?.type ?? null, missedTokens: miss?.cache_missed_input_tokens ?? null };
    }
  }
}
writeFileSync(join(root, 'usage.json'), `${JSON.stringify(rows, null, 1)}\n`);
const shapes = [...new Set(Object.values(rows).flatMap((r) => Object.keys(r)))];
const lines = [`# ${run}: cache use of each probe request, as the API reported it`, '', 'Each cell: cache_read / cache_creation input tokens, then the API\'s cache_miss_reason (missed tokens).', '', `| method | ${shapes.join(' | ')} |`, `|---|${shapes.map(() => '---').join('|')}|`];
for (const [method, byShape] of Object.entries(rows).sort(([a], [b]) => a.localeCompare(b))) {
  lines.push(`| \`${method}\` | ${shapes.map((s) => (byShape[s] === undefined ? '-' : `${String(byShape[s].cacheRead)} / ${String(byShape[s].cacheCreation)} ${byShape[s].missReason === null ? '' : `${String(byShape[s].missReason)} (${String(byShape[s].missedTokens)})`}`)).join(' | ')} |`);
}
writeFileSync(join(root, 'usage.md'), `${lines.join('\n')}\n`);
process.stdout.write(`${lines.join('\n')}\n`);
