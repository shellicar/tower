// Compares, per shape, the request each resume method sent for the probe with
// the request the `local` method sent (Claude Code's own record: today's
// behaviour). The request sent before the resume is not part of it.
//
// Normalised before comparing, on both sides, and nothing else:
//   - metadata.user_id's device_id (a store resume runs Claude Code in a fresh
//     temporary config dir, which gets its own device id)
//   - the config dir path (a store resume's temporary dir, /tmp/claude-resume-<uuid>,
//     and the participant's own config dir) -> <CONFIG_DIR>
//   - the participant's private HOME (/tmp/tower-participant-home-<random>,
//     new for every process) -> <PRIVATE_HOME>
//   - cc_prompt_id=<uuid> in the billing header (new for every prompt)
// The report states how many replacements of each were made. The `local2`
// method resumes the same way as `local`: its differences from `local` are
// the noise any two resumes have.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { filesEnding, type Json, OUT, type Plan, type ShapeMeta, shapeOutDir } from './lib.js';
import { probeFor } from './shapes.js';

function lastUserText(body: Json): string {
  const messages = (body.messages ?? []) as Json[];
  const last = [...messages].reverse().find((m) => m.role === 'user');
  const content = last?.content;
  if (typeof content === 'string') {
    return content;
  }
  return Array.isArray(content) ? (content as Json[]).map((b) => (typeof b.text === 'string' ? b.text : '')).join('\n') : '';
}

/** The main-loop request that carries the probe, from a method's raw body log. */
export function probeRequest(bodiesDir: string, probe: string): { file: string; body: Json } | undefined {
  for (const name of filesEnding(bodiesDir, '.request.json').sort()) {
    const body = JSON.parse(readFileSync(join(bodiesDir, name), 'utf8')) as Json;
    if (Array.isArray(body.tools) && body.tools.length > 0 && lastUserText(body).includes(probe)) {
      return { file: join(bodiesDir, name), body };
    }
  }
  return undefined;
}

type Norm = { body: Json; replaced: { deviceId: number; configDir: number; privateHome: number; promptId: number } };

export function norm(body: Json, configDir: string): Norm {
  const replaced = { deviceId: 0, configDir: 0, privateHome: 0, promptId: 0 };
  let text = JSON.stringify(body);
  for (const pattern of [/\/tmp\/claude-resume-[0-9a-f-]+/g, new RegExp(configDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')]) {
    text = text.replace(pattern, () => {
      replaced.configDir += 1;
      return '<CONFIG_DIR>';
    });
  }
  // The participant's private HOME is a new random directory per process.
  text = text.replace(/\/tmp\/tower-participant-home-[A-Za-z0-9]+/g, () => {
    replaced.privateHome += 1;
    return '<PRIVATE_HOME>';
  });
  // Claude Code mints a prompt id for each prompt; it is in the billing header.
  text = text.replace(/cc_prompt_id=[0-9a-f-]+/g, () => {
    replaced.promptId += 1;
    return 'cc_prompt_id=<PROMPT_ID>';
  });
  const out = JSON.parse(text) as Json;
  const metadata = out.metadata as Json | undefined;
  if (metadata !== undefined && typeof metadata.user_id === 'string') {
    try {
      const user = JSON.parse(metadata.user_id) as Json;
      if ('device_id' in user) {
        delete user.device_id;
        replaced.deviceId += 1;
      }
      metadata.user_id = JSON.stringify(user);
    } catch {
      // not JSON: left as it is
    }
  }
  return { body: out, replaced };
}

function short(value: unknown): string {
  const text = typeof value === 'string' ? JSON.stringify(value) : (JSON.stringify(value) ?? 'undefined');
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}

/** Paths at which two JSON values differ, with the two values there. */
function paths(a: unknown, b: unknown, at: string, found: string[], limit = 8): void {
  if (found.length >= limit || JSON.stringify(a) === JSON.stringify(b)) {
    return;
  }
  const aObj = typeof a === 'object' && a !== null;
  const bObj = typeof b === 'object' && b !== null;
  if (aObj && bObj && Array.isArray(a) === Array.isArray(b)) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    for (const key of keys) {
      paths((a as Json)[key], (b as Json)[key], `${at}.${key}`, found, limit);
    }
    return;
  }
  found.push(`${at}: ${short(a)} vs ${short(b)}`);
}

function brief(message: Json | undefined): string {
  if (message === undefined) {
    return '(none)';
  }
  const content = message.content;
  const blocks = typeof content === 'string' ? [{ type: 'string', text: content }] : ((content ?? []) as Json[]);
  const parts = blocks.map((block) => {
    const type = String(block.type);
    const cache = block.cache_control === undefined ? '' : '+cc';
    if (typeof block.text === 'string') {
      return `${type}${cache}(${short(block.text.length > 50 ? `${block.text.slice(0, 50)}…` : block.text)})`;
    }
    if (type === 'tool_use') {
      return `tool_use${cache}(${String(block.name)} ${String(block.id).slice(-6)})`;
    }
    if (type === 'tool_result') {
      return `tool_result${cache}(${String(block.tool_use_id).slice(-6)})`;
    }
    return `${type}${cache}`;
  });
  return `${String(message.role)}[${parts.join(' + ')}]`;
}

/** Every difference between two normalised requests, as short lines. */
export function diff(reference: Json, got: Json): string[] {
  const out: string[] = [];
  for (const key of new Set([...Object.keys(reference), ...Object.keys(got)])) {
    if (key === 'messages') {
      continue;
    }
    if (JSON.stringify(reference[key]) !== JSON.stringify(got[key])) {
      const found: string[] = [];
      paths(reference[key], got[key], key, found, 4);
      out.push(...found);
    }
  }
  const a = (reference.messages ?? []) as Json[];
  const b = (got.messages ?? []) as Json[];
  if (a.length !== b.length) {
    out.push(`messages: ${a.length} vs ${b.length}`);
  }
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) {
      out.push(`messages[${i}] ${brief(a[i])} vs ${brief(b[i])}`);
      const found: string[] = [];
      paths(a[i], b[i], `messages[${i}]`, found, 4);
      out.push(...found.map((line) => `    ${line}`));
    }
  }
  return out;
}

export type MethodReport = { method: string; status: 'same' | 'same, noise only' | 'differs' | 'no request' | 'failed'; differences: string[]; note?: string; result?: Json; replaced?: Norm['replaced']; requestFile?: string };

export function compareShape(run: string, shape: string): { shape: string; reference?: string; methods: MethodReport[] } {
  const out = shapeOutDir(run, shape);
  const meta = JSON.parse(readFileSync(join(out, 'meta.json'), 'utf8')) as ShapeMeta;
  const methodsDir = join(out, 'methods');
  const names = existsSync(methodsDir) ? readdirSync(methodsDir).sort() : [];
  const probe = probeFor(shape);
  const requests = new Map<string, { body: Json; norm: Norm; result: Json }>();
  const reports: MethodReport[] = [];
  for (const name of names) {
    const dir = join(methodsDir, name);
    const result = existsSync(join(dir, 'result.json')) ? (JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) as Json) : {};
    const found = probeRequest(join(dir, 'bodies'), probe);
    if (found === undefined) {
      reports.push({ method: name, status: result.error === undefined ? 'no request' : 'failed', differences: [], result });
      continue;
    }
    copyFileSync(found.file, join(dir, 'probe.request.json'));
    requests.set(name, { body: found.body, norm: norm(found.body, meta.configDir), result });
  }
  const reference = requests.get('local');
  // What two local resumes differ by (the `local2` control): the noise.
  const noise = new Set<string>();
  for (const name of ['local2', 'local3']) {
    const control = requests.get(name);
    if (reference !== undefined && control !== undefined) {
      for (const line of diff(reference.norm.body, control.norm.body)) {
        noise.add(line);
      }
    }
  }
  for (const [name, request] of requests) {
    if (name === 'local') {
      reports.push({ method: name, status: 'same', differences: [], result: request.result, replaced: request.norm.replaced, note: 'the reference', requestFile: `methods/${name}/probe.request.json` });
      continue;
    }
    const all = reference === undefined ? ['no local reference request'] : diff(reference.norm.body, request.norm.body);
    const differences = all.map((line) => (noise.has(line) ? `[noise, also local vs local2] ${line}` : line));
    const real = all.filter((line) => !noise.has(line));
    const status = all.length === 0 ? 'same' : real.length === 0 ? 'same, noise only' : 'differs';
    reports.push({ method: name, status, differences, result: request.result, replaced: request.norm.replaced, requestFile: `methods/${name}/probe.request.json` });
  }
  return { shape, ...(reference === undefined ? {} : { reference: 'local' }), methods: reports.sort((x, y) => x.method.localeCompare(y.method)) };
}

/** How many difference lines per method the markdown report shows. */
const SHOWN = 12;

export function compareRun(plan: Plan): void {
  const lines: string[] = [`# Resume comparison, run ${plan.run}`, '', 'Reference: the `local` method (Claude Code reads its own record). Each other method is compared with it, request for request.', ''];
  const all: unknown[] = [];
  for (const shape of plan.shapes) {
    const out = shapeOutDir(plan.run, shape);
    if (!existsSync(join(out, 'meta.json'))) {
      continue;
    }
    const report = compareShape(plan.run, shape);
    all.push(report);
    lines.push(`## ${shape}`, '', 'Summary (what differs, by location):', '');
    for (const m of report.methods) {
      const where = [...new Set(m.differences.filter((d) => !d.startsWith(' ') && !d.startsWith('[noise')).map((d) => d.replace(/^(messages\[\d+\]|[^:\s]+).*$/, '$1')))];
      lines.push(`- \`${m.method}\`: ${m.status}${where.length === 0 ? '' : `; differs at ${where.join(', ')}`}`);
    }
    lines.push('', 'Detail:', '');
    for (const m of report.methods) {
      lines.push(`- \`${m.method}\`: ${m.status}${m.note === undefined ? '' : ` (${m.note})`}${m.result?.error === undefined ? '' : ` ERROR ${String(m.result.error).split('\n')[0]}`}`);
      // The full list is in report.json.
      for (const d of m.differences.slice(0, SHOWN)) {
        lines.push(`    - ${d}`);
      }
      if (m.differences.length > SHOWN) {
        lines.push(`    - … ${m.differences.length - SHOWN} more lines in report.json`);
      }
    }
    lines.push('');
  }
  mkdirSync(join(OUT, plan.run), { recursive: true });
  writeFileSync(join(OUT, plan.run, 'report.md'), `${lines.join('\n')}\n`);
  writeFileSync(join(OUT, plan.run, 'report.json'), `${JSON.stringify(all, null, 1)}\n`);
  console.log(`report: ${join(OUT, plan.run, 'report.md')}`);
}

// Run offline over saved bodies: node --import tsx proof/compare.ts
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { readPlan } = await import('./lib.js');
  compareRun(readPlan());
}
