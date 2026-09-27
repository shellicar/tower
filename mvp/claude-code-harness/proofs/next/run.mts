// Proof 24, live: every way of committing, at a query's end, what Claude Code
// builds its next query on, tested against Claude Code itself.
//
// One session per cell on one model:
//   step 0  warm-up, run to the end (a baseline turn)
//   step 1  the cell's prompt, ended by interrupt() at the cell's ending (or
//           left to end by itself: normal, thinking-only, limit, api-error)
//   at step 1's `result`: each way computes its holding, and the instant it
//           had it is recorded
//   step 2  the probe, sent into the same running Claude Code: Claude Code's
//           own continuation (L). Its request is the ground truth.
// Then, for each distinct holding, a resume through a session store whose
// load() returns that holding (T), with the same probe. T's first request is
// compared with L's: the history, and the cache numbers.
//
// Choices made for this proof, not decisions (TODO: undecided, each the
// easiest thing that runs; none is a proposal for the participant):
//   - Triggers as proof 23: first-byte on the step's request file; thinking
//     700 ms into an open thinking block; mid-text at 60 characters of text;
//     tool-input at 100 characters of tool input; tool-exec 2 s after
//     PreToolUse. Each is a race; the analysis sorts runs by where they
//     actually stopped.
//   - Every holding carries every entry that is not a user or assistant
//     message (attachments, system entries, bookkeeping), as proof 20's
//     A-silent did, so the commit rule is the only thing that varies.
//   - A way that leaves out an entry relinks its child to the dropped
//     entry's parent (proof 8: a broken chain loads only the tail).
//   - disableClaudeAiConnectors: true, Stephen's 27 Sep baseline, so the
//     account's connectors don't change the tools between requests.
//   - Order: L first, then each T. T reads what L wrote to the cache.
//   - The api-error cell: API_TIMEOUT_MS=800 (Haiku 100) and CLAUDE_CODE_MAX_RETRIES=2
//     in the process env for the whole run (proof 23's retry cell), so the
//     warm-up, step 1 and the probe all end in API errors; the probe's
//     request body is still written, but it gets no usage. Its resumes run
//     without them. Tried first and dropped: API_TIMEOUT_MS through
//     applyFlagSettings' env for step 1 only (no timeout happened), and
//     setModel() to a model that doesn't exist (refused by Claude Code:
//     proofs/next/setmodel-probe.mts).
//   - P24_RECORDER=1 sets CLAUDE_CODE_ELEGANT_MEADOW=1 (undocumented) in the
//     main run and its resumes: Claude Code's own request recorder, which
//     writes each request's messages into the transcript.
//   - A priming run (the warm-up only, no resumes) after the reset, so the
//     cells don't start on a config directory with nothing cached (the
//     first run's resume re-announced the session context).
//   - The limit cell: CLAUDE_CODE_MAX_OUTPUT_TOKENS 256 (Sonnet, Haiku) or
//     64 (Opus, Fable: 256 didn't cut their thinking in proof 23).
//   - Raw bodies and store appends stay under
//     ~/.local/state/tower-claude-code-harness/proof-24/; the run directory
//     gets copies with tokens and email addresses redacted.
//
//   node proofs/next/run.mts <model> <cell|all> [...]

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HookCallbackMatcher, HookEvent, HookInput, SDKMessage, SDKUserMessage, SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import type { HarnessOptions, Run } from '../../src/harness.mts';
import { startRun } from '../../src/harness.mts';
import { redact, stamp } from '../../src/record.mts';
import type { Json } from './history.mts';
import { entryBlocks } from './history.mts';
import { fold, foldKeepErrors, isMarker, isPartial, lastChainEntry, relink, sdkEventBlocks, sdkReader, withTailAttachment, without } from './ways.mts';
import { randomUUID } from 'node:crypto';

const HARNESS_STATE = join(homedir(), '.local', 'state', 'tower-claude-code-harness');
const STATE = join(HARNESS_STATE, 'proof-24');
const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const QUIET_MS = 2500;
const STEP_TIMEOUT_MS = 240_000;
const POLL_MS = 5;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const clean = (text: string): string => redact(text).text.replace(EMAIL, '[email redacted]');
const now = (): number => performance.timeOrigin + performance.now();

// ---------------------------------------------------------------------------
// Cells

type Ending = 'first-byte' | 'thinking' | 'mid-text' | 'tool-input' | 'tool-exec';

interface Cell {
  id: string;
  prompt: string;
  ending?: Ending;
  env?: Record<string, string>; // process env for the whole run
  resumeEnv?: Record<string, string>; // process env for its resumes, if not env
}

const WARM = 'Reply with the word READY only.';
const PROBE = 'Reply with the word NEXT only.';
const HARD = 'Work out, carefully and step by step, how many integers from 1 to 300 are divisible by 3 or by 5 but not by 7.';
const NO_TOOLS = 'Answer in your reply itself; do not use any tools.';
// 800 ms timed out every attempt on Sonnet, Opus and Fable in proof 23;
// Haiku answered inside it (proof 24 pilot), so Haiku gets 100 ms.
const errorEnv = (model: string): Record<string, string> => ({ API_TIMEOUT_MS: /haiku/.test(model) ? '100' : '800', CLAUDE_CODE_MAX_RETRIES: '2' });

function cells(model: string): Cell[] {
  // P24_LIMIT overrides (Sonnet at 256 never hit the limit in rounds 1 and 2).
  const limit = process.env.P24_LIMIT ?? (/opus|fable/.test(model) ? '64' : '256');
  return [
    { id: 'normal', prompt: `What is 17 times 23? Work it out, then reply with the number only. ${NO_TOOLS}` },
    { id: 'thinking-only', prompt: `Think carefully about whether 391 is prime. Then end your turn with an empty reply: write no text at all, not even a single word or punctuation mark. ${NO_TOOLS}` },
    { id: 'limit', prompt: `${HARD} Reply with the number only. ${NO_TOOLS}`, env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: limit } },
    { id: 'api-error', prompt: `What is 17 times 23? Work it out, then reply with the number only. ${NO_TOOLS}`, env: errorEnv(model), resumeEnv: {} },
    { id: 'first-byte', prompt: `What is 17 times 23? Reply with the number only. ${NO_TOOLS}`, ending: 'first-byte' },
    { id: 'thinking', prompt: `${HARD} Reply with the number only. ${NO_TOOLS}`, ending: 'thinking' },
    { id: 'mid-text', prompt: `Write the numbers one to sixty in words, one per line, nothing else. ${NO_TOOLS}`, ending: 'mid-text' },
    { id: 'tool-input', prompt: 'Use the Write tool to create story.txt containing a 300-word story about a lighthouse keeper. Call the Write tool straight away, with no text before it.', ending: 'tool-input' },
    // Opus ran proof 23's prompt in the background in round 1 and finished
    // before the stop; "in the foreground" added from round 2.
    { id: 'tool-exec', prompt: 'Run this exact Bash command in the foreground (not in the background), once: `sleep 20; echo DONE`. Then reply with its output only.', ending: 'tool-exec' },
  ];
}

const short = (model: string): string => model.replace(/^claude-/, '').replace(/[^A-Za-z0-9]/g, '');
const agentName = (model: string): string => `p24-${short(model)}${process.env.P24_RECORDER === '1' ? '-rec' : ''}`;

// ---------------------------------------------------------------------------
// Recording

class Events {
  readonly path: string;
  readonly raw: string;
  constructor(dir: string, rawDir: string) {
    this.path = join(dir, 'next-events.jsonl');
    this.raw = join(rawDir, 'next-events.jsonl');
  }
  write(src: string, kind: string, detail: Json = {}): void {
    const line = JSON.stringify({ ts: stamp(), ms: now(), src, kind, ...detail });
    appendFileSync(this.raw, `${line}\n`);
    appendFileSync(this.path, `${clean(line)}\n`);
  }
}

class RecordingStore implements SessionStore {
  readonly all: Json[] = [];
  readonly rawPath: string;
  readonly events: Events;
  readonly toLoad: Json[] | undefined;
  constructor(events: Events, rawPath: string, toLoad?: Json[]) {
    this.events = events;
    this.rawPath = rawPath;
    this.toLoad = toLoad;
  }
  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    appendFileSync(this.rawPath, `${JSON.stringify({ ts: stamp(), ms: now(), key, entries })}\n`);
    if (!key.subpath) {
      this.all.push(...(entries as Json[]));
    }
    this.events.write('store', 'append', { subpath: key.subpath ?? null, count: entries.length, types: (entries as Json[]).map((e) => e.type) });
  }
  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    if (!this.toLoad || key.subpath) {
      this.events.write('store', 'load', { subpath: key.subpath ?? null, returned: null });
      return null;
    }
    this.events.write('store', 'load', { returned: this.toLoad.length });
    return this.toLoad as SessionStoreEntry[];
  }
}

class BodiesWatch {
  readonly dir: string;
  readonly events: Events;
  readonly seen = new Set<string>();
  timer: NodeJS.Timeout | undefined;
  onRequest: (file: string, body: Json) => void = () => {};
  constructor(dir: string, events: Events) {
    this.dir = dir;
    this.events = events;
  }
  start(): void {
    this.timer = setInterval(() => this.poll(), POLL_MS);
  }
  stop(): void {
    clearInterval(this.timer);
    this.poll();
  }
  poll(): void {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const f of names) {
      if (this.seen.has(f) || !f.endsWith('.json')) {
        continue;
      }
      let body: Json;
      try {
        body = JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as Json;
      } catch {
        continue; // still being written
      }
      this.seen.add(f);
      if (f.endsWith('.request.json')) {
        this.events.write('bodies', 'request', { file: f, model: body.model, thread: body.thread ?? null, messages: Array.isArray(body.messages) ? body.messages.length : null, tools: Array.isArray(body.tools) ? body.tools.length : null });
        this.onRequest(f, body);
      } else {
        this.events.write('bodies', 'response', { file: f, id: body.id, stop_reason: body.stop_reason, usage: body.usage ?? null, diagnostics: body.diagnostics ?? null });
      }
    }
  }
}

const HOOKS: HookEvent[] = ['UserPromptSubmit', 'PreToolUse', 'Stop', 'StopFailure'];

function hooks(events: Events, onPreToolUse: (input: HookInput) => void): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const out: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
  for (const h of HOOKS) {
    out[h] = [
      {
        hooks: [
          async (input) => {
            const i = input as Json;
            events.write('hook', h, { tool_name: i.tool_name, error: i.error, lastLen: typeof i.last_assistant_message === 'string' ? i.last_assistant_message.length : undefined });
            if (h === 'PreToolUse') {
              onPreToolUse(input);
            }
            return { continue: true };
          },
        ],
      },
    ];
  }
  return out;
}

function user(text: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
}

function copyDir(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const f of existsSync(from) ? readdirSync(from) : []) {
    if (f !== 'latest') {
      writeFileSync(join(to, f), clean(readFileSync(join(from, f), 'utf8')));
    }
  }
}

function resetConfigDir(name: string): string {
  const r = spawnSync('pnpm', ['-s', 'reset-config-dir', name], { cwd: PACKAGE, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`reset-config-dir ${name} refused (${r.status}): ${r.stderr}`);
  }
  return r.stdout.trim();
}

function baseOptions(model: string, store: SessionStore, bodies: string, env: Record<string, string>, ev: Events, onPreToolUse: (i: HookInput) => void): HarnessOptions {
  return {
    model,
    thinking: { type: 'adaptive', display: 'summarized' },
    includePartialMessages: true,
    tools: ['Bash', 'Write'],
    canUseTool: async (toolName, input) => {
      ev.write('proof', 'canUseTool', { toolName });
      return { behavior: 'allow', updatedInput: input };
    },
    hooks: hooks(ev, onPreToolUse),
    settings: { disableClaudeAiConnectors: true },
    sessionStore: store,
    sessionStoreFlush: 'eager',
    env: { ...process.env, ...env, ...(process.env.P24_RECORDER === '1' ? { CLAUDE_CODE_ELEGANT_MEADOW: '1' } : {}), OTEL_LOG_RAW_API_BODIES: `file:${bodies}` },
  };
}

// ---------------------------------------------------------------------------
// The ways, at step 1's result.

const isConversation = (e: Json): boolean => (e.type === 'user' || e.type === 'assistant') && e.message !== undefined;

// A holding in entry form: the conversation entries named, plus every other
// entry (see the choices above), relinked where an entry is left out.
function holdingFrom(all: Json[], keep: Set<string>): Json[] {
  const drop = new Set<string>();
  for (const e of all) {
    if (isConversation(e) && typeof e.uuid === 'string' && !keep.has(e.uuid)) {
      drop.add(e.uuid);
    }
  }
  return relink(all, drop);
}

interface Holding {
  way: string;
  atMs: number; // ms after the result message arrived
  entries: Json[];
  // The conversation as tower would show it, when the holding also carries
  // entries the model never sees. Defaults to entries.
  conversation?: Json[];
  // Resume options beyond the store (extraArgs, resumeSessionAt).
  resume?: Json;
  note?: string;
}

async function waysAtResult(sessionId: string, store: RecordingStore, sdkSteps: { prompt: string; messages: Json[] }[], resultMs: number, run: Run, ev: Events, contextUsage: boolean): Promise<Holding[]> {
  const out: Holding[] = [];
  const snap = store.all.map((e) => e);
  out.push({ way: 'store', atMs: now() - resultMs, entries: snap });

  const f = fold(snap);
  out.push({ way: 'store+fold', atMs: now() - resultMs, entries: f.kept, note: f.dropped.map((d) => `${d.rule}:${d.uuid.slice(0, 8)}`).join(',') });

  // Routes around the resume's "No response requested." (see ways.mts).
  const fk = foldKeepErrors(snap);
  out.push({ way: 'fold+errors', atMs: now() - resultMs, entries: fk.kept, conversation: f.kept });
  for (const type of ['prompt_snapshot', 'credential_org']) {
    const t = withTailAttachment(fk.kept, type, randomUUID);
    out.push({ way: `fold+errors+${type}`, atMs: now() - resultMs, entries: t.entries, conversation: f.kept, note: t.added ? `appended ${type}` : 'nothing appended' });
  }
  const st = withTailAttachment(snap, 'prompt_snapshot', randomUUID);
  out.push({ way: 'store+prompt_snapshot', atMs: now() - resultMs, entries: st.entries, note: st.added ? 'appended prompt_snapshot' : 'nothing appended' });
  // API error entries dropped too, with the attachment: does the attachment
  // alone do for the output-limit and API-error endings?
  const ft = withTailAttachment(f.kept, 'prompt_snapshot', randomUUID);
  out.push({ way: 'fold+prompt_snapshot', atMs: now() - resultMs, entries: ft.entries, note: ft.added ? 'appended prompt_snapshot' : 'nothing appended' });
  // Without the marker, the partial reply, or both (Stephen allows these).
  const nm = without(fk.kept, isMarker);
  out.push({ way: 'fold+errors-marker', atMs: now() - resultMs, entries: nm.entries, note: `removed ${nm.removed}` });
  const np = without(fk.kept, isPartial);
  out.push({ way: 'fold+errors-partial', atMs: now() - resultMs, entries: np.entries, note: `removed ${np.removed}` });
  const npm = without(fk.kept, (e) => isMarker(e) || isPartial(e));
  out.push({ way: 'fold+errors-partial-marker', atMs: now() - resultMs, entries: npm.entries, note: `removed ${npm.removed}` });
  const npmt = withTailAttachment(np.entries, 'prompt_snapshot', randomUUID);
  out.push({ way: 'fold+errors-partial+prompt_snapshot', atMs: now() - resultMs, entries: npmt.entries, note: `removed ${np.removed}; ${npmt.added ? 'appended' : 'nothing appended'}` });
  // Options that reach the resume code: --reply-on-resume (extraArgs), and
  // resumeSessionAt the chain's last entry.
  out.push({ way: 'fold+errors,reply-on-resume', atMs: now() - resultMs, entries: fk.kept, resume: { extraArgs: { 'reply-on-resume': null } } });
  // resumeSessionAt (documented): the chain's last entry, so nothing is cut.
  for (const [name, entries] of [['fold+errors', fk.kept], ['fold', f.kept], ['store', snap]] as const) {
    const lastE = lastChainEntry(entries);
    if (lastE) {
      out.push({ way: `${name},resumeSessionAt-last`, atMs: now() - resultMs, entries, resume: { resumeSessionAt: lastE.uuid } });
    }
  }

  const r = await sdkReader(sessionId, snap);
  out.push({ way: 'sdk-reader', atMs: now() - resultMs, entries: holdingFrom(snap, new Set(r.uuids)) });

  // SDK events: the prompts as sent (matched to their store entries by
  // text) and the SDK's main-thread assistant and user messages (by uuid).
  const keep = new Set<string>();
  const sent = new Set(sdkSteps.map((s) => s.prompt));
  for (const e of snap) {
    const c = (e.message as Json | undefined)?.content;
    if (e.type === 'user' && typeof c === 'string' && sent.has(c) && typeof e.uuid === 'string') {
      keep.add(e.uuid);
    }
  }
  for (const s of sdkSteps) {
    for (const m of s.messages) {
      if ((m.type === 'assistant' || m.type === 'user') && (m.parent_tool_use_id ?? null) === null && m.isReplay !== true && typeof m.uuid === 'string') {
        keep.add(m.uuid);
      }
    }
  }
  const evHolding = holdingFrom(snap, keep);
  const unmatched = sdkEventBlocks(sdkSteps).length - entryBlocks(evHolding).length;
  out.push({ way: 'sdk-events', atMs: now() - resultMs, entries: evHolding, note: unmatched !== 0 ? `${unmatched} SDK blocks with no store entry` : undefined });

  if (contextUsage) {
    // TODO: undecided. Probing Claude Code's own view with get_context_usage
    // ('full' counts with the token-count API). Recorded, not a holding.
    const t = now();
    try {
      const u = await run.query.getContextUsage({ detail: 'full' });
      ev.write('proof', 'context-usage', { ms: now() - t, afterResultMs: now() - resultMs, totalTokens: u.totalTokens, categories: u.categories.map((c) => ({ name: c.name, tokens: c.tokens, kind: c.kind })), messageBreakdown: (u as Json).messageBreakdown ?? null });
    } catch (err) {
      ev.write('proof', 'context-usage-error', { error: String(err) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The main run.

interface MainOut {
  dir: string;
  rawDir: string;
  sessionId: string;
  holdings: Holding[];
  stopped: string | null;
  probeFile: string | undefined;
}

function newRawDir(model: string, label: string): string {
  const d = join(STATE, `${stamp().replace(/[:.]/g, '')}-${short(model)}-${label}`);
  mkdirSync(join(d, 'api-bodies'), { recursive: true });
  return d;
}

async function runMain(model: string, cell: Cell, contextUsage: boolean): Promise<MainOut> {
  const rawDir = newRawDir(model, cell.id);
  const bodies = join(rawDir, 'api-bodies');
  const pre: [string, string, Json][] = [];
  let events: Events | undefined;
  const ev = { write: (s: string, k: string, d: Json = {}) => (events ? events.write(s, k, d) : pre.push([s, k, d])) } as Events;
  const store = new RecordingStore(ev, join(rawDir, 'store-appends.jsonl'));
  let run: Run | undefined;
  let step = 0;
  let stopped: string | null = null;
  const fire = (how: string): void => {
    if (stopped || !run || step !== 1 || waysDone !== undefined) {
      return;
    }
    stopped = how;
    ev.write('proof', 'stop', { how });
    void run.interrupt().then(
      (res) => ev.write('proof', 'interrupt-returned', { result: (res ?? null) as unknown as Json }),
      (err: unknown) => ev.write('proof', 'interrupt-error', { error: String(err) }),
    );
  };
  const onPreToolUse = (input: HookInput): void => {
    if (cell.ending === 'tool-exec' && (input as Json).tool_name === 'Bash') {
      setTimeout(() => fire('2 s after PreToolUse for Bash'), 2000);
    }
  };
  const options = baseOptions(model, store, bodies, cell.env ?? {}, ev, onPreToolUse);
  const bw = new BodiesWatch(bodies, ev);
  let probeFile: string | undefined;
  bw.onRequest = (file, body) => {
    const main = String(body.model).startsWith(model) && body.thinking !== undefined;
    if (!main) {
      return;
    }
    const text = JSON.stringify(body.messages ?? []);
    if (step === 1 && cell.ending === 'first-byte' && text.includes(cell.prompt.slice(0, 30))) {
      fire(`request file ${file}`);
    }
    if (step === 2 && probeFile === undefined && text.includes(PROBE)) {
      probeFile = file;
    }
  };
  run = startRun({ name: agentName(model), options });
  events = new Events(run.dir, rawDir);
  for (const [s, k, d] of pre) {
    events.write(s, k, d);
  }
  writeFileSync(join(run.dir, 'next-plan.json'), `${JSON.stringify({ model, cell, rawDir, role: 'main' }, null, 2)}\n`);
  process.stdout.write(`${stamp()} ${cell.id}: main ${run.dir}\n`);
  bw.start();

  const steps = [WARM, cell.prompt, PROBE];
  const sdkSteps: { prompt: string; messages: Json[] }[] = [];
  let sessionId = '';
  let holdings: Holding[] = [];
  let quiet: NodeJS.Timeout | undefined;
  let stepTimer: NodeJS.Timeout | undefined;
  let resultSeen = false;
  let waysDone: Promise<void> | undefined;
  const stream = { thinkingOpen: false, textChars: 0, inputChars: 0 };
  const send = async (): Promise<void> => {
    const text = steps[step];
    if (text === undefined || !run) {
      ev.write('proof', 'end', {});
      run?.end();
      return;
    }
    ev.write('proof', 'send', { step, text });
    sdkSteps.push({ prompt: text, messages: [] });
    resultSeen = false;
    Object.assign(stream, { thinkingOpen: false, textChars: 0, inputChars: 0 });
    run.send(user(text));
    clearTimeout(stepTimer);
    stepTimer = setTimeout(() => {
      ev.write('proof', 'step-timeout', { step });
      run?.end();
    }, STEP_TIMEOUT_MS);
  };
  const advance = (): void => {
    quiet = undefined;
    step += 1;
    void (async () => {
      if (step === 2 && waysDone) {
        await waysDone;
      }
      await send();
    })();
  };
  void send();
  try {
    for await (const message of run.messages()) {
      const m = message as SDKMessage & Json;
      const rec = sdkSteps[sdkSteps.length - 1];
      rec?.messages.push(m as Json);
      if (m.type === 'system' && m.subtype === 'init') {
        sessionId = String(m.session_id);
      }
      if (m.type !== 'stream_event') {
        ev.write('sdk', m.type === 'system' ? `system:${String(m.subtype)}` : String(m.type), { uuid: m.uuid, subtype: m.subtype });
      }
      if (quiet) {
        clearTimeout(quiet);
        quiet = undefined;
      }
      if (m.type === 'stream_event' && (m.parent_tool_use_id ?? null) === null && step === 1) {
        const e = m.event as unknown as Json;
        const block = e.content_block as Json | undefined;
        const delta = e.delta as Json | undefined;
        if (e.type === 'content_block_start' && block?.type === 'thinking') {
          stream.thinkingOpen = true;
          if (cell.ending === 'thinking') {
            setTimeout(() => (stream.thinkingOpen ? fire('700 ms into an open thinking block') : ev.write('proof', 'trigger-missed', {})), 700);
          }
        }
        if (e.type === 'content_block_stop') {
          stream.thinkingOpen = false;
        }
        if (e.type === 'content_block_delta' && delta?.type === 'text_delta') {
          stream.textChars += String(delta.text ?? '').length;
          if (cell.ending === 'mid-text' && stream.textChars >= 60) {
            fire(`${stream.textChars} text characters streamed`);
          }
        }
        if (e.type === 'content_block_delta' && delta?.type === 'input_json_delta') {
          stream.inputChars += String(delta.partial_json ?? '').length;
          if (cell.ending === 'tool-input' && stream.inputChars >= 100) {
            fire(`${stream.inputChars} tool input characters streamed`);
          }
        }
      }
      if (m.type === 'result') {
        resultSeen = true;
        if (step === 1 && !waysDone) {
          // Not awaited here: a control call (getContextUsage) needs this
          // loop to keep reading. The store is snapshotted synchronously.
          const resultMs = now();
          ev.write('proof', 'step1-result', { storeEntries: store.all.length });
          waysDone = waysAtResult(sessionId, store, sdkSteps.slice(0, 2), resultMs, run, ev, contextUsage).then((hs) => {
            holdings = hs;
            for (const h of hs) {
              ev.write('way', h.way, { atMs: h.atMs, entries: h.entries.length, note: h.note });
            }
          });
        }
      }
      if (resultSeen) {
        quiet = setTimeout(advance, QUIET_MS);
      }
    }
  } catch (err) {
    ev.write('proof', 'messages-error', { error: err instanceof Error ? err.message : String(err) });
  }
  clearTimeout(quiet);
  clearTimeout(stepTimer);
  try {
    await run.done;
  } catch (err) {
    ev.write('proof', 'run-done-error', { error: err instanceof Error ? err.message : String(err) });
  }
  await waysDone;
  await new Promise((r) => setTimeout(r, 1500));
  bw.stop();
  copyDir(bodies, join(run.dir, 'api-bodies'));
  writeFileSync(join(rawDir, 'holdings.json'), JSON.stringify(holdings));
  writeFileSync(join(run.dir, 'holdings.json'), clean(JSON.stringify(holdings)));
  writeFileSync(join(run.dir, 'store-appends.jsonl'), clean(existsSync(join(rawDir, 'store-appends.jsonl')) ? readFileSync(join(rawDir, 'store-appends.jsonl'), 'utf8') : ''));
  process.stdout.write(`${stamp()} ${cell.id}: main done, stopped: ${stopped ?? 'no'}, holdings ${holdings.map((h) => `${h.way}:${h.entries.length}`).join(' ')}\n`);
  return { dir: run.dir, rawDir, sessionId, holdings, stopped, probeFile };
}

// ---------------------------------------------------------------------------
// A resume from one holding.

async function runResume(model: string, cell: Cell, sessionId: string, label: string, entries: Json[], resumeExtra: Json = {}): Promise<{ dir: string; rawDir: string }> {
  const rawDir = newRawDir(model, `${cell.id}-${label}`);
  const bodies = join(rawDir, 'api-bodies');
  const pre: [string, string, Json][] = [];
  let events: Events | undefined;
  const ev = { write: (s: string, k: string, d: Json = {}) => (events ? events.write(s, k, d) : pre.push([s, k, d])) } as Events;
  const store = new RecordingStore(ev, join(rawDir, 'store-appends.jsonl'), entries);
  // P24_RESUME_ENV (JSON) adds to the resumes' env only, e.g. to try
  // CLAUDE_CODE_RESUME_TOLERATES_CONTEXT_APPENDS (undocumented).
  const extra = JSON.parse(process.env.P24_RESUME_ENV ?? '{}') as Record<string, string>;
  const options: HarnessOptions = { ...baseOptions(model, store, bodies, { ...(cell.resumeEnv ?? cell.env ?? {}), ...extra }, ev, () => {}), resume: sessionId, ...(resumeExtra as Partial<HarnessOptions>) };
  const bw = new BodiesWatch(bodies, ev);
  const run = startRun({ name: agentName(model), options });
  events = new Events(run.dir, rawDir);
  for (const [s, k, d] of pre) {
    events.write(s, k, d);
  }
  writeFileSync(join(run.dir, 'next-plan.json'), `${JSON.stringify({ model, cell, rawDir, role: 'resume', label, sessionId, loaded: entries.length }, null, 2)}\n`);
  bw.start();
  let quiet: NodeJS.Timeout | undefined;
  const timer = setTimeout(() => run.end(), STEP_TIMEOUT_MS);
  run.send(user(PROBE));
  ev.write('proof', 'send', { step: 0, text: PROBE });
  try {
    for await (const message of run.messages()) {
      const m = message as SDKMessage & Json;
      if (m.type !== 'stream_event') {
        ev.write('sdk', m.type === 'system' ? `system:${String(m.subtype)}` : String(m.type), { uuid: m.uuid, subtype: m.subtype });
      }
      clearTimeout(quiet);
      if (m.type === 'result') {
        quiet = setTimeout(() => run.end(), QUIET_MS);
      }
    }
  } catch (err) {
    ev.write('proof', 'messages-error', { error: err instanceof Error ? err.message : String(err) });
  }
  clearTimeout(quiet);
  clearTimeout(timer);
  try {
    await run.done;
  } catch (err) {
    ev.write('proof', 'run-done-error', { error: err instanceof Error ? err.message : String(err) });
  }
  await new Promise((r) => setTimeout(r, 1000));
  bw.stop();
  copyDir(bodies, join(run.dir, 'api-bodies'));
  writeFileSync(join(run.dir, 'store-appends.jsonl'), clean(existsSync(join(rawDir, 'store-appends.jsonl')) ? readFileSync(join(rawDir, 'store-appends.jsonl'), 'utf8') : ''));
  process.stdout.write(`${stamp()} ${cell.id}: resume ${label} (${entries.length} entries) ${run.dir}\n`);
  return { dir: run.dir, rawDir };
}

// The warm-up alone, run to the end, so the config directory has what Claude
// Code caches on a first run before any cell starts.
async function runPrime(model: string): Promise<void> {
  const rawDir = newRawDir(model, 'prime');
  const pre: [string, string, Json][] = [];
  let events: Events | undefined;
  const ev = { write: (s: string, k: string, d: Json = {}) => (events ? events.write(s, k, d) : pre.push([s, k, d])) } as Events;
  const store = new RecordingStore(ev, join(rawDir, 'store-appends.jsonl'));
  const run = startRun({ name: agentName(model), options: baseOptions(model, store, join(rawDir, 'api-bodies'), {}, ev, () => {}) });
  events = new Events(run.dir, rawDir);
  for (const [s, k, d] of pre) {
    events.write(s, k, d);
  }
  run.send(user(WARM));
  for await (const m of run.messages()) {
    if (m.type === 'result') {
      run.end();
    }
  }
  try {
    await run.done;
  } catch (err) {
    ev.write('proof', 'run-done-error', { error: String(err) });
  }
  process.stdout.write(`${stamp()} prime: ${run.dir}\n`);
}

const hashOf = (h: Holding): string => createHash('sha256').update(JSON.stringify([h.entries, h.resume ?? null])).digest('hex').slice(0, 12);

async function runCell(model: string, cell: Cell, contextUsage: boolean): Promise<Json> {
  const main = await runMain(model, cell, contextUsage);
  const row: Json = { model, cell: cell.id, main: main.dir, rawDir: main.rawDir, sessionId: main.sessionId, stopped: main.stopped, probeFile: main.probeFile ?? null, ways: {}, resumes: {} };
  const byHash = new Map<string, string[]>();
  for (const h of main.holdings) {
    const k = hashOf(h);
    (row.ways as Json)[h.way] = { atMs: h.atMs, entries: h.entries.length, hash: k, note: h.note ?? null };
    byHash.set(k, [...(byHash.get(k) ?? []), h.way]);
  }
  if (!main.sessionId) {
    return row;
  }
  for (const [k, ways] of byHash) {
    const h = main.holdings.find((x) => hashOf(x) === k);
    if (!h) {
      continue;
    }
    const r = await runResume(model, cell, main.sessionId, ways[0]?.replace(/[^A-Za-z0-9+-]/g, '_') ?? 'resume', h.entries, h.resume ?? {});
    (row.resumes as Json)[k] = { ways, dir: r.dir, rawDir: r.rawDir };
  }
  return row;
}

async function main(): Promise<void> {
  const [model, ...wanted] = process.argv.slice(2);
  if (!model || wanted.length === 0) {
    process.stderr.write('usage: node proofs/next/run.mts <model> <cell|all> [...]\n');
    process.exit(2);
  }
  const all = cells(model);
  const chosen = wanted.includes('all') ? all : wanted.map((w) => all.find((c) => c.id === w) ?? (() => { throw new Error(`no cell ${w}`); })());
  mkdirSync(STATE, { recursive: true });
  if (process.env.P24_NO_RESET !== '1') {
    process.stdout.write(`${stamp()} reset ${resetConfigDir(agentName(model))}\n`);
  }
  const contextUsage = process.env.P24_CONTEXT_USAGE === '1';
  if (process.env.P24_NO_PRIME !== '1') {
    await runPrime(model);
  }
  const indexPath = join(PACKAGE, 'runs', `p24-index-${short(model)}-${stamp().replace(/[:.]/g, '')}.json`);
  const index: Json[] = [];
  for (const cell of chosen) {
    try {
      index.push(await runCell(model, cell, contextUsage));
    } catch (err) {
      index.push({ model, cell: cell.id, failed: err instanceof Error ? err.message : String(err) });
      process.stdout.write(`${stamp()} ${cell.id}: failed ${String(err)}\n`);
    }
    writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  }
  process.stdout.write(`${stamp()} INDEX ${indexPath}\n`);
}

await main();
