// Integration spike: a resume on the machine that has the conversation, from
// Claude Code's local record in the agent's reused config dir, with a session
// store still attached (the commit signal). The store's load() returns null,
// so the SDK's GG returns early (no /tmp/claude-resume-* dir) and bFe spawns
// with the agent's own CLAUDE_CONFIG_DIR. Checks:
//   (a) the spawned CLAUDE_CONFIG_DIR is the agent's own dir
//   (b) the model sees the earlier turns (answer + the API request body)
//   (c) new entries are still mirrored to store.append()
//   (d) resumeSessionAt cuts the loaded history back to that entry
//
// Runs, one at a time, agent `int-spike`:
//   1  fresh: "Remember the word PELICAN. Reply OK."
//   2  resume: "What word did I ask you to remember? Reply with the word only."
//   3  resume + resumeSessionAt <run 1's last assistant entry>:
//      "What was the last question I asked you? Quote it."
//
// Instruments added through options.env (not the spawn env):
// OTEL_LOG_RAW_API_BODIES (request bodies, to see the history sent) and
// TOWER_AGENT=int-spike (the tag the guard scans for, proof 25).
//
//   node proofs/integration/spike-local-resume.mts [model]

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SDKMessage, SDKUserMessage, SessionKey, SessionStore, SessionStoreEntry, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type { HarnessOptions } from '../../src/harness.mts';
import { startRun } from '../../src/harness.mts';
import { stamp } from '../../src/record.mts';

type Json = Record<string, unknown>;

const NAME = 'int-spike';
const MODEL = process.argv[2] ?? 'claude-haiku-4-5';
const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RESULT_TIMEOUT_MS = 180_000;

const user = (text: string): SDKUserMessage => ({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
const out = (line: string): void => {
  process.stdout.write(`${stamp()} ${line}\n`);
};

// ---------------------------------------------------------------------------

class RecordingStore implements SessionStore {
  readonly appends: { key: SessionKey; entries: Json[] }[] = [];
  readonly loads: SessionKey[] = [];
  path = '';
  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    this.appends.push({ key, entries: entries as Json[] });
    if (this.path) {
      appendFileSync(this.path, `${JSON.stringify({ ts: stamp(), op: 'append', key, entries })}\n`);
    }
  }
  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    this.loads.push(key);
    if (this.path) {
      appendFileSync(this.path, `${JSON.stringify({ ts: stamp(), op: 'load', key, returned: null })}\n`);
    }
    out(`store.load ${JSON.stringify(key)} -> null`);
    return null;
  }
}

// Names (and mtimes) of top-level claude-resume-* dirs only; never descends.
function resumeDirs(): string[] {
  const roots = [...new Set([tmpdir(), '/tmp'])];
  const found: string[] = [];
  for (const root of roots) {
    for (const n of readdirSync(root)) {
      if (n.startsWith('claude-resume-')) {
        let mtime = '';
        try {
          mtime = statSync(join(root, n)).mtime.toISOString();
        } catch {
          mtime = 'gone';
        }
        found.push(`${join(root, n)} ${mtime}`);
      }
    }
  }
  return found.sort();
}

interface Transcript {
  path: string;
  lines: number;
  size: number;
}

function transcripts(configDir: string): Transcript[] {
  const projects = join(configDir, 'projects');
  const res: Transcript[] = [];
  if (!existsSync(projects)) {
    return res;
  }
  for (const p of readdirSync(projects)) {
    const dir = join(projects, p);
    if (!statSync(dir).isDirectory()) {
      continue;
    }
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.jsonl')) {
        const path = join(dir, f);
        const text = readFileSync(path, 'utf8');
        res.push({ path, lines: text.split('\n').filter((l) => l.trim() !== '').length, size: statSync(path).size });
      }
    }
  }
  return res;
}

const readLines = (path: string): Json[] =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Json);

function textOf(m: Json): string {
  const content = (m.message as Json | undefined)?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((b: Json) => b.type === 'text')
      .map((b: Json) => String(b.text))
      .join('');
  }
  return '';
}

// ---------------------------------------------------------------------------

interface RunOutcome {
  dir: string;
  configDir: string;
  sessionId: string;
  answer: string;
  resultSubtype: string;
  spawnConfigDirs: string[];
  resumeDirsAtSpawn: string[][];
  resumeDirsBefore: string[];
  resumeDirsAfter: string[];
  store: RecordingStore;
  before: Transcript[];
  after: Transcript[];
}

async function oneRun(label: string, prompt: string, extra: Partial<HarnessOptions>): Promise<RunOutcome> {
  const store = new RecordingStore();
  const spawnConfigDirs: string[] = [];
  const resumeDirsAtSpawn: string[][] = [];
  const stderrs: Record<number, string> = {};
  const configDirGuess = join(process.env.HOME ?? '', '.local', 'state', 'tower-claude-code-harness', 'config-dirs', NAME);
  const before = transcripts(configDirGuess);
  const resumeDirsBefore = resumeDirs();

  const spawnClaudeCodeProcess = (o: SpawnOptions) => {
    spawnConfigDirs.push(String(o.env.CLAUDE_CONFIG_DIR));
    // GG runs before the spawn and its dir is removed after the child exits:
    // list here to catch one that exists only for the run's lifetime.
    resumeDirsAtSpawn.push(resumeDirs());
    const child = spawn(o.command, o.args, { cwd: o.cwd, env: o.env, signal: o.signal, stdio: ['pipe', 'pipe', 'pipe'] });
    // Drained into memory: with no resume the SDK spawns inside startRun,
    // before the run dir is known. Written to the run dir afterwards.
    const n = spawnConfigDirs.length;
    stderrs[n] = '';
    child.stderr.on('data', (d: Buffer) => {
      stderrs[n] += d.toString('utf8');
    });
    return child;
  };

  // startRun names the run dir only once it has the options, so the bodies
  // get their own dir beside it under runs/ (gitignored).
  const bodiesDir = join(PACKAGE, 'runs', `${stamp().replace(/[:.]/g, '')}-${NAME}-${label}-api-bodies`);
  const options: HarnessOptions = {
    model: MODEL,
    tools: [],
    settings: { disableClaudeAiConnectors: true },
    sessionStore: store,
    sessionStoreFlush: 'eager',
    spawnClaudeCodeProcess,
    ...extra,
    env: { ...process.env, TOWER_AGENT: NAME, OTEL_LOG_RAW_API_BODIES: `file:${bodiesDir}` },
  };

  const run = startRun({ name: NAME, options });
  store.path = join(run.dir, 'store.jsonl');
  out(`${label}: run ${run.dir} (bodies ${bodiesDir})`);
  if (run.configDir !== configDirGuess) {
    throw new Error(`config dir ${run.configDir} is not ${configDirGuess}`);
  }

  let sessionId = '';
  let answer = '';
  let resultSubtype = '';
  const timer = setTimeout(() => {
    out(`${label}: result timeout, ending`);
    run.end();
  }, RESULT_TIMEOUT_MS);
  run.send(user(prompt));
  for await (const message of run.messages()) {
    const m = message as SDKMessage & Json;
    if (m.type === 'system' && m.subtype === 'init') {
      sessionId = String(m.session_id);
    }
    if (m.type === 'result') {
      resultSubtype = String(m.subtype);
      answer = typeof m.result === 'string' ? m.result : JSON.stringify(m.errors ?? null);
      clearTimeout(timer);
      run.end();
    }
  }
  clearTimeout(timer);
  await run.done;
  const after = transcripts(run.configDir);
  for (const [n, text] of Object.entries(stderrs)) {
    writeFileSync(join(run.dir, `spawn-stderr-${n}.txt`), text);
  }
  const outcome: RunOutcome = { dir: run.dir, configDir: run.configDir, sessionId, answer, resultSubtype, spawnConfigDirs, resumeDirsAtSpawn, resumeDirsBefore, resumeDirsAfter: resumeDirs(), store, before, after };
  writeFileSync(
    join(run.dir, 'spike.json'),
    `${JSON.stringify({ label, prompt, extra, bodiesDir, ...outcome, store: { loads: store.loads, appends: store.appends.map((a) => ({ key: a.key, n: a.entries.length, types: a.entries.map((e) => e.type), uuids: a.entries.map((e) => e.uuid ?? null) })) } }, null, 2)}\n`,
  );
  return outcome;
}

function summarise(label: string, r: RunOutcome, priorUuids: Set<string>): Json[] {
  const main = r.store.appends.filter((a) => !a.key.subpath);
  const sub = r.store.appends.filter((a) => a.key.subpath);
  const entries = main.flatMap((a) => a.entries);
  const reMirrored = entries.filter((e) => typeof e.uuid === 'string' && priorUuids.has(e.uuid));
  const firstChain = entries.find((e) => e.type === 'user' || e.type === 'assistant');
  const grew = r.after
    .map((t) => ({ ...t, was: r.before.find((b) => b.path === t.path) }))
    .filter((t) => !t.was || t.was.lines !== t.lines || t.was.size !== t.size)
    .map((t) => ({ path: t.path, lines: `${t.was?.lines ?? 0} -> ${t.lines}`, size: `${t.was?.size ?? 0} -> ${t.size}` }));
  const summary = {
    label,
    sessionId: r.sessionId,
    resultSubtype: r.resultSubtype,
    answer: r.answer,
    agentConfigDir: r.configDir,
    spawnConfigDirs: r.spawnConfigDirs,
    spawnConfigDirIsAgentDir: r.spawnConfigDirs.map((d) => d === r.configDir),
    resumeDirsBefore: r.resumeDirsBefore,
    resumeDirsAtSpawn: r.resumeDirsAtSpawn,
    resumeDirsAfter: r.resumeDirsAfter,
    loads: r.store.loads,
    mainAppends: main.length,
    subAppends: sub.map((a) => a.key.subpath),
    appendKeys: [...new Set(main.map((a) => JSON.stringify({ projectKey: a.key.projectKey, sessionId: a.key.sessionId })))],
    entryCount: entries.length,
    types: entries.map((e) => e.type),
    uuids: entries.map((e) => e.uuid ?? null),
    reMirroredPriorUuids: reMirrored.length,
    firstChainEntry: firstChain ? { type: firstChain.type, uuid: firstChain.uuid, parentUuid: firstChain.parentUuid ?? null } : null,
    transcriptsGrew: grew,
  };
  out(`${label}: ${JSON.stringify(summary, null, 2)}`);
  return entries;
}

// What the model was sent: the main-model request bodies' user texts.
function requestHistory(bodiesDirHint: string): string[][] {
  if (!existsSync(bodiesDirHint)) {
    return [];
  }
  const res: string[][] = [];
  for (const f of readdirSync(bodiesDirHint).sort()) {
    if (!f.endsWith('.request.json')) {
      continue;
    }
    const body = JSON.parse(readFileSync(join(bodiesDirHint, f), 'utf8')) as Json;
    const msgs = (body.messages as Json[] | undefined) ?? [];
    res.push([
      `${f} model=${String(body.model)}`,
      ...msgs.map((m) => {
        const c = m.content;
        const t = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b: Json) => (b.type === 'text' ? String(b.text) : `[${String(b.type)}]`)).join(' | ') : '';
        return `${String(m.role)}: ${t.replace(/\s+/g, ' ').slice(0, 160)}`;
      }),
    ]);
  }
  return res;
}

// ---------------------------------------------------------------------------

function reset(): void {
  const guard = spawnSync('node', ['proofs/tag-guard.mts', NAME], { cwd: PACKAGE, encoding: 'utf8' });
  out(`tag-guard: ${guard.status} ${guard.stdout.trim()} ${guard.stderr.trim()}`);
  if (guard.status !== 0) {
    throw new Error('tag guard refused');
  }
  const r = spawnSync('pnpm', ['-s', 'reset-config-dir', NAME], { cwd: PACKAGE, encoding: 'utf8' });
  out(`reset-config-dir: ${r.status} ${r.stdout.trim()} ${r.stderr.trim()}`);
  if (r.status !== 0) {
    throw new Error('reset refused');
  }
}

reset();

// Run 1: fresh.
const r1 = await oneRun('run1', 'Remember the word PELICAN. Reply OK.', {});
const e1 = summarise('run1', r1, new Set());
const t1 = r1.after.find((t) => t.path.endsWith(`${r1.sessionId}.jsonl`));
if (!t1) {
  throw new Error(`no transcript for ${r1.sessionId}`);
}
const run1Lines = readLines(t1.path);
const lastAssistant = [...run1Lines].reverse().find((l) => l.type === 'assistant');
const cut = String(lastAssistant?.uuid);
out(`run1: transcript ${t1.path}, ${run1Lines.length} lines; last assistant uuid ${cut} (in store appends: ${e1.some((e) => e.uuid === cut)}); last user/assistant line types: ${run1Lines.map((l) => l.type).join(',')}`);
const run1Uuids = new Set(run1Lines.map((l) => l.uuid).filter((u): u is string => typeof u === 'string'));

// Run 2: resume from the local record, store attached, load() null.
const r2 = await oneRun('run2', 'What word did I ask you to remember? Reply with the word only.', { resume: r1.sessionId });
const e2 = summarise('run2', r2, run1Uuids);
const run2Uuids = new Set([...run1Uuids, ...e2.map((e) => e.uuid).filter((u): u is string => typeof u === 'string')]);

// Run 3: resume cut back to run 1's last assistant entry.
const r3 = await oneRun('run3', 'What was the last question I asked you? Quote it.', { resume: r1.sessionId, resumeSessionAt: cut });
const e3 = summarise('run3', r3, run2Uuids);
const first3 = e3.find((e) => e.type === 'user' || e.type === 'assistant');
out(`run3: cut ${cut}; first new chain entry parentUuid ${String(first3?.parentUuid)} (equals cut: ${first3?.parentUuid === cut})`);

for (const [label, r] of [
  ['run1', r1],
  ['run2', r2],
  ['run3', r3],
] as const) {
  const hint = JSON.parse(readFileSync(join(r.dir, 'spike.json'), 'utf8')).bodiesDir as string;
  out(`${label}: requests sent:\n${requestHistory(hint)
    .map((req) => req.join('\n    '))
    .join('\n  ')}`);
}
const final = transcripts(r3.configDir);
out(`final transcripts: ${JSON.stringify(final)}`);
for (const t of final) {
  out(`${t.path}:\n${readLines(t.path)
    .map((l) => `  ${String(l.type)} uuid=${String(l.uuid ?? '')} parent=${String(l.parentUuid ?? '')} ${textOf(l).replace(/\s+/g, ' ').slice(0, 80)}`)
    .join('\n')}`);
}
