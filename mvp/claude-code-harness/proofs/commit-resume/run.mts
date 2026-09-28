// Store commit against resume from tower: resume a fresh Claude Code from
// each planned holding (plan.mts) through the SDK's sessionStore load(), send
// the probe, and keep the request it sends. The Messages API is the local
// fake (fake-api.mts): nothing reaches the model; account calls pass through.
//
// Each job: startRun under this proof's one agent name, a store whose load()
// returns the holding's entries per key (and listSubkeys its subpaths),
// resume: <session id>, resumeSessionAt when the holding names one, the main
// run's model, thinking, tools and env, the cancel runs' hooks and
// canUseTool (allow). The probe is sent at once; the input ends after the
// first result, or after 90 s.
//
// Choices made for these runs, not decisions (TODO: undecided): the timeout;
// one job at a time; TZ=UTC, so Claude Code's local date is still the
// recordings' date (28 Sep) after midnight in Brisbane and no "the date has
// changed" reminder is added; entries' cwd rewritten (HoldingStore.load).
//
//   node proofs/commit-resume/run.mts <plan-dir> [--only <job id,...>] [--limit N]

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SessionKey, SessionStore, SessionStoreEntry, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { startRun } from '../../src/harness.mts';
import { stamp } from '../../src/record.mts';
import { type Events, hooks } from '../cancel/lib.mts';
import { startFakeApi } from './fake-api.mts';

type Json = Record<string, unknown>;
const AGENT = 'commit-resume';
const MODEL = 'claude-sonnet-5';
const JOB_TIMEOUT_MS = 90_000;
const CWD = join(homedir(), '.local', 'state', 'tower-claude-code-harness', 'work', AGENT);

interface Job {
  id: string;
  holding: string;
  probe: string;
  options: { thinking: Json; tools: string[]; env: Record<string, string> };
  sessionId: string;
  first: string;
}

class HoldingStore implements SessionStore {
  readonly byKey: Map<string, Json[]>;
  readonly appendsPath: string;
  readonly log: Json[] = [];
  constructor(holding: { appends: { key: SessionKey; entries: Json[] }[] }, appendsPath: string) {
    this.byKey = new Map(holding.appends.map((a) => [a.key.subpath ?? '', a.entries]));
    this.appendsPath = appendsPath;
  }
  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    appendFileSync(this.appendsPath, `${JSON.stringify({ ts: stamp(), ms: Date.now(), key, entries })}\n`);
  }
  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const e = this.byKey.get(key.subpath ?? '');
    this.log.push({ op: 'load', key, returned: e ? e.length : null });
    if (!e) {
      return null;
    }
    // The recordings ran in another working directory (work/cancel-sdk,
    // work/cancel-sdk-d); a resume elsewhere adds an "Environment update"
    // reminder to its request (entries' cwd and the environment attachment's
    // snapshot). A participant resumes where the conversation ran, so every
    // occurrence of the recording's path is replaced with this run's: the
    // test harness's doing, applied to every rule and to OWN alike.
    const text = JSON.stringify(e).replace(/\/home\/stephen\/\.local\/state\/tower-claude-code-harness\/work\/cancel-sdk(-d)?(?![A-Za-z0-9_-])/g, CWD);
    return JSON.parse(text) as SessionStoreEntry[];
  }
  async listSubkeys(): Promise<string[]> {
    const subs = [...this.byKey.keys()].filter((k) => k !== '');
    this.log.push({ op: 'listSubkeys', returned: subs });
    return subs;
  }
}

const user = (text: string): SDKUserMessage => ({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });

function lastUserText(body: Json): string {
  const msgs = (body.messages ?? []) as Json[];
  const last = [...msgs].reverse().find((m) => m.role === 'user');
  const c = last?.content;
  if (typeof c === 'string') {
    return c;
  }
  return Array.isArray(c) ? (c as Json[]).map((b) => (typeof b.text === 'string' ? b.text : '')).join('\n') : '';
}

async function runJob(planDir: string, job: Job): Promise<Json> {
  const outDir = join(planDir, 'out', job.id);
  // A rerun starts from an empty output directory (this proof's own files).
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, 'otel'), { recursive: true });
  const holding = JSON.parse(readFileSync(join(planDir, 'holdings', `${job.holding}.json`), 'utf8')) as { appends: { key: SessionKey; entries: Json[] }[]; resumeSessionAt: string | null };
  const store = new HoldingStore(holding, join(outDir, 'store-appends.jsonl'));
  const fakeEvents: Json[] = [];
  const fake = await startFakeApi({ upstream: process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com', dir: outDir, onEvent: (e) => fakeEvents.push({ wall: Date.now(), ...e }) });
  const sdk: Json[] = [];
  const noEvents = { write: () => {} } as unknown as Events;
  const started = Date.now();
  let error: string | undefined;
  let runDir: string | undefined;
  try {
    const run = startRun({
      name: AGENT,
      options: {
        model: MODEL,
        thinking: job.options.thinking as never,
        includePartialMessages: true,
        tools: job.options.tools,
        canUseTool: async (_n, input) => ({ behavior: 'allow', updatedInput: input }),
        hooks: hooks(noEvents, () => {}),
        sessionStore: store,
        sessionStoreFlush: 'eager',
        resume: job.sessionId,
        ...(holding.resumeSessionAt ? { resumeSessionAt: holding.resumeSessionAt } : {}),
        env: { ...process.env, ...job.options.env, ANTHROPIC_BASE_URL: fake.url, OTEL_LOG_RAW_API_BODIES: `file:${join(outDir, 'otel')}`, TZ: 'UTC' },
      },
    });
    runDir = run.dir;
    // The account's claude.ai connectors connect in the background; a
    // request sent before they do carries 2 tools instead of 10 (seen in the
    // recorded store-at-last resume of D1-SIGTERM r2 too). Wait until none
    // is pending (at most 20 s), so the tools list isn't a timing race.
    const until = Date.now() + 20_000;
    let statuses: Json[] = [];
    while (Date.now() < until) {
      statuses = (await run.query.mcpServerStatus()) as unknown as Json[];
      if (statuses.length > 0 && statuses.every((s) => s.status !== 'pending')) {
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    sdk.push({ wall: Date.now(), mcp: statuses.map((s) => `${String(s.name)}:${String(s.status)}`) });
    run.send(user(job.probe));
    const timer = setTimeout(() => {
      sdk.push({ wall: Date.now(), timeout: true });
      run.end();
    }, JOB_TIMEOUT_MS);
    for await (const m of run.messages()) {
      const mm = m as Json;
      sdk.push({ wall: Date.now(), type: mm.type, subtype: mm.subtype ?? null, ...(mm.type === 'result' ? { is_error: mm.is_error ?? null, result: String(mm.result ?? '').slice(0, 300), errors: mm.errors ?? null } : {}) });
      if (mm.type === 'result') {
        run.end();
      }
    }
    clearTimeout(timer);
    try {
      await run.done;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  await fake.close();
  // The probe's request: the first faked request with tools whose last user
  // message carries the probe.
  const req = fake.requests.find((r) => Array.isArray(r.body.tools) && (r.body.tools as unknown[]).length > 0 && lastUserText(r.body).includes(job.probe));
  const out: Json = {
    id: job.id,
    first: job.first,
    holding: job.holding,
    resumeSessionAt: holding.resumeSessionAt,
    probe: job.probe,
    runDir: runDir ?? null,
    error: error ?? null,
    ms: Date.now() - started,
    wire: req?.file ?? null,
    faked: fake.requests.map((r) => ({ n: r.n, file: r.file, tools: Array.isArray(r.body.tools) ? (r.body.tools as unknown[]).length : 0, model: r.body.model ?? null })),
    storeLog: store.log,
    sdk,
    fake: fakeEvents,
  };
  writeFileSync(join(outDir, 'job.json'), `${JSON.stringify(out, null, 1)}\n`);
  return out;
}

async function main(): Promise<void> {
  const planDir = process.argv[2] ? resolve(process.argv[2]) : undefined;
  if (!planDir) {
    process.stderr.write('usage: run.mts <plan-dir> [--only ids] [--limit N]\n');
    process.exit(2);
  }
  const args = process.argv.slice(3);
  const only = args.includes('--only') ? new Set(String(args[args.indexOf('--only') + 1]).split(',')) : undefined;
  const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Number.POSITIVE_INFINITY;
  const redo = args.includes('--redo');
  let jobs = JSON.parse(readFileSync(join(planDir, 'jobs.json'), 'utf8')) as Job[];
  if (only) {
    jobs = jobs.filter((j) => only.has(j.id));
  }
  let n = 0;
  for (const job of jobs) {
    if (n >= limit) {
      break;
    }
    if (!redo && existsSync(join(planDir, 'out', job.id, 'job.json'))) {
      continue;
    }
    n += 1;
    const r = await runJob(planDir, job);
    process.stdout.write(`${stamp()} ${n}/${jobs.length} ${job.id} ${job.first} ${r.ms}ms wire=${r.wire ? 'yes' : 'NO'}${r.error ? ` error=${String(r.error).slice(0, 120)}` : ''}\n`);
  }
}

await main();
