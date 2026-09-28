// Cancel scenarios over the SDK: what Claude Code 2.1.282 (the SDK's
// bundled binary) writes, and when, when a query is cut short (interrupt(),
// a signal to Claude Code's own process, the SDK's abort), what a resume
// loads and writes, and what the next request carries.
//
// One scenario = a main run (steps sent in order, each after the previous
// one's result and a quiet period; one step can carry a stop), then, when
// the main run's Claude Code is gone, resume runs under the same agent name
// (same config dir), each its own harness run:
//   store        the SDK resumes through a sessionStore whose load() returns
//                exactly what the main run's store got (the participant's
//                route)
//   transcript   no sessionStore: Claude Code loads its own transcript from
//                the agent's config dir (run last: it appends to that file)
// each with or without resumeSessionAt:
//   at=last           the last non-system entry of what is loaded (proof 24's
//                     and the integration participant's value: nothing cut)
//   at=before-prompt  the cancelled prompt's parentUuid (cuts the prompt and
//                     everything after it)
//
// Recorded per run (runs/<id>/cancel-events.jsonl, raw copy under
// ~/.local/state/tower-claude-code-harness/cancel/): SDK messages, every
// transcript line under the agent's projects/ and under a store resume's
// temp config dir, every store append, request/response bodies
// (OTEL_LOG_RAW_API_BODIES), hooks, and the Claude Code process (found as
// the capture wrapper's child; pid, start time, exit).
//
// Choices made for these runs, not decisions (TODO: undecided, each the
// easiest thing that runs; none is a proposal for the participant):
//   - Stop points: thinking = 700 ms into an open thinking block; mid-text =
//     60 characters of text streamed; tool-exec = 2 s after PreToolUse for
//     Bash (the command sleeps 20 s); first-byte = the step's main request
//     file seen; tool-input = 100 characters of tool input streamed;
//     immediate = N ms after the send; stop-hook = 1 s into a Stop hook held
//     for 10 s. Each is a race; the events show where it actually landed.
//   - A kill goes to the real binary (the capture wrapper's child), not the
//     wrapper: the SDK then sees its child exit.
//   - Tools Bash and Write, every call approved by canUseTool (unless the
//     scenario holds permission).
//   - resumeSessionAt values: see above.
//
//   node proofs/cancel/run.mts <model> <scenario> [--reps N] [--agent NAME]
//
// Raw bodies and store appends stay outside the repo; the run directory
// gets copies with tokens and email addresses redacted.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HookEvent, HookInput, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { HarnessOptions, Run } from '../../src/harness.mts';
import { startRun } from '../../src/harness.mts';
import { stamp } from '../../src/record.mts';
import { BodiesWatch, ClaudeFinder, clean, Events, entryBrief, hooks, type Json, loadAppends, now, RecordingStore, sdkBrief, TranscriptWatch } from './lib.mts';

const HARNESS_STATE = join(homedir(), '.local', 'state', 'tower-claude-code-harness');
const STATE = join(HARNESS_STATE, 'cancel');
const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const QUIET_MS = 2500;
const STEP_TIMEOUT_MS = 240_000;

// ---------------------------------------------------------------------------
// Scenarios

type Point = 'thinking' | 'mid-text' | 'tool-exec' | 'first-byte' | 'tool-input' | 'immediate' | 'stop-hook';
type Method = 'interrupt' | 'abort' | 'push' | `kill:${'SIGTERM' | 'SIGHUP' | 'SIGINT' | 'SIGKILL'}`;

interface Step {
  text: string;
  stop?: { at: Point; method: Method; delayMs?: number };
}

interface Resume {
  label: string;
  source: 'store' | 'transcript';
  at?: 'last' | 'before-prompt';
  steps: Step[];
  // With no steps: how long to wait before ending the input.
  idleMs?: number;
}

interface Scenario {
  id: string;
  steps: Step[];
  resumes: Resume[];
  env?: Record<string, string>;
  tools?: string[];
  thinking?: HarnessOptions['thinking'];
  stopHookHoldMs?: number;
}

const WARM = 'Reply with the word READY only.';
const NEXT = 'Reply with the word NEXT only.';
const AGAIN = 'Reply with the word AGAIN only.';
const NO_TOOLS = 'Answer in your reply itself; do not use any tools.';
const HARD = 'Work out, carefully and step by step, how many integers from 1 to 300 are divisible by 3 or by 5 but not by 7.';
export const PROMPTS = {
  thinking: `${HARD} Reply with the number only. ${NO_TOOLS}`,
  thinking2: 'Work out, carefully and step by step, how many integers from 1 to 400 are divisible by 4 or by 6 but not by 9. Reply with the number only. Answer in your reply itself; do not use any tools.',
  text: `Write the numbers one to sixty in words, one per line, nothing else. ${NO_TOOLS}`,
  toolExec: 'Run this exact Bash command, once: `sleep 20; echo DONE`. Then reply with its output only.',
};

const STORE_RESUMES = (steps: Step[]): Resume[] => [
  { label: 'store', source: 'store', steps },
  { label: 'store-at-last', source: 'store', at: 'last', steps },
  { label: 'store-at-before-prompt', source: 'store', at: 'before-prompt', steps },
  { label: 'transcript', source: 'transcript', steps },
];

function scenarios(): Scenario[] {
  const out: Scenario[] = [];
  // A: send, interrupt, send again (same process).
  out.push({ id: 'A-thinking', steps: [{ text: WARM }, { text: PROMPTS.thinking, stop: { at: 'thinking', method: 'interrupt' } }, { text: NEXT }], resumes: [] });
  out.push({ id: 'A-text', steps: [{ text: WARM }, { text: PROMPTS.text, stop: { at: 'mid-text', method: 'interrupt' } }, { text: NEXT }], resumes: [] });
  out.push({ id: 'A-tool', steps: [{ text: WARM }, { text: PROMPTS.toolExec, stop: { at: 'tool-exec', method: 'interrupt' } }, { text: NEXT }], resumes: [] });
  // B: kill Claude Code during thinking, resume, send again.
  for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT', 'SIGKILL'] as const) {
    out.push({ id: `B-thinking-${sig}`, steps: [{ text: WARM }, { text: PROMPTS.thinking, stop: { at: 'thinking', method: `kill:${sig}` } }], resumes: STORE_RESUMES([{ text: NEXT }]) });
    // C: the same kill during a tool run and mid-reply.
    out.push({ id: `C-tool-${sig}`, steps: [{ text: WARM }, { text: PROMPTS.toolExec, stop: { at: 'tool-exec', method: `kill:${sig}` } }], resumes: STORE_RESUMES([{ text: NEXT }]) });
    out.push({ id: `C-text-${sig}`, steps: [{ text: WARM }, { text: PROMPTS.text, stop: { at: 'mid-text', method: `kill:${sig}` } }], resumes: STORE_RESUMES([{ text: NEXT }]) });
  }
  // E1: resume without sending: each resume idles, then one sends.
  out.push({
    id: 'E1-SIGTERM',
    steps: [{ text: WARM }, { text: PROMPTS.thinking, stop: { at: 'thinking', method: 'kill:SIGTERM' } }],
    resumes: [
      { label: 'store-idle', source: 'store', steps: [], idleMs: 15_000 },
      { label: 'store-at-last-idle', source: 'store', at: 'last', steps: [], idleMs: 15_000 },
      { label: 'transcript-idle', source: 'transcript', steps: [], idleMs: 15_000 },
      { label: 'transcript-after-idle', source: 'transcript', steps: [{ text: NEXT }] },
    ],
  });
  out.push({
    id: 'E1-interrupt',
    steps: [{ text: WARM }, { text: PROMPTS.thinking, stop: { at: 'thinking', method: 'interrupt' } }],
    resumes: [
      { label: 'store-idle', source: 'store', steps: [], idleMs: 15_000 },
      { label: 'transcript-idle', source: 'transcript', steps: [], idleMs: 15_000 },
      { label: 'transcript-after-idle', source: 'transcript', steps: [{ text: NEXT }] },
    ],
  });
  // E2: two interrupts in a row, then a reply.
  out.push({ id: 'E2', steps: [{ text: WARM }, { text: PROMPTS.thinking, stop: { at: 'thinking', method: 'interrupt' } }, { text: PROMPTS.thinking2, stop: { at: 'thinking', method: 'interrupt' } }, { text: NEXT }], resumes: [] });
  // E3: a message pushed into a running query.
  out.push({ id: 'E3-thinking', steps: [{ text: WARM }, { text: PROMPTS.thinking, stop: { at: 'thinking', method: 'push' } }, { text: NEXT }], resumes: [] });
  out.push({ id: 'E3-tool', steps: [{ text: WARM }, { text: PROMPTS.toolExec, stop: { at: 'tool-exec', method: 'push' } }, { text: NEXT }], resumes: [] });
  return out;
}

// ---------------------------------------------------------------------------

const user = (text: string): SDKUserMessage => ({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });

function textOf(e: Json): string | undefined {
  const c = (e.message as Json | undefined)?.content;
  if (typeof c === 'string') {
    return c;
  }
  if (Array.isArray(c)) {
    const t = (c as Json[]).find((b) => b.type === 'text');
    return typeof t?.text === 'string' ? t.text : undefined;
  }
  return undefined;
}

// The last non-system entry (the integration participant's lastChain).
function lastChain(entries: Json[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i] as Json;
    if (typeof e.uuid === 'string' && e.type !== 'system' && e.type !== 'progress') {
      return e.uuid;
    }
  }
  return undefined;
}

function resetConfigDir(name: string): string {
  const r = spawnSync('pnpm', ['-s', 'reset-config-dir', name], { cwd: PACKAGE, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`reset-config-dir ${name} refused (${r.status}): ${r.stderr}`);
  }
  return r.stdout.trim();
}

function copyBodies(from: string, runDir: string): void {
  const to = join(runDir, 'api-bodies');
  mkdirSync(to, { recursive: true });
  for (const entry of existsSync(from) ? readdirSync(from) : []) {
    if (entry === 'latest') {
      continue;
    }
    writeFileSync(join(to, entry), clean(readFileSync(join(from, entry), 'utf8')));
  }
}

interface RunPlan {
  agent: string;
  label: string;
  model: string;
  scenario: Scenario;
  steps: Step[];
  idleMs?: number;
  resume?: { sessionId: string; source: 'store' | 'transcript'; loadFrom?: string; resumeSessionAt?: string };
}

interface RunOut {
  dir: string;
  rawDir: string;
  sessionId: string | undefined;
  rawAppends: string;
  error: string | undefined;
  stops: Json[];
}

async function runOne(plan: RunPlan): Promise<RunOut> {
  const rawDir = join(STATE, `${stamp().replace(/[:.]/g, '')}-${plan.agent}-${plan.label.replace(/[^A-Za-z0-9-]/g, '_')}`);
  const bodies = join(rawDir, 'api-bodies');
  mkdirSync(bodies, { recursive: true });
  const rawAppends = join(rawDir, 'store-appends.jsonl');
  const abort = new AbortController();
  const pre: [string, string, Json][] = [];
  let events: Events | undefined;
  const ev = {
    write: (src: string, kind: string, detail: Json = {}): void => {
      if (events) {
        events.write(src, kind, detail);
      } else {
        pre.push([src, kind, { ...detail, bufferedAt: stamp(), bufferedMs: now() }]);
      }
    },
  } as Events;

  let run: Run | undefined;
  let finder: ClaudeFinder | undefined;
  let stepIndex = -1;
  const stops: Json[] = [];
  const fired = new Set<number>();
  let pushedNext = false;
  const stream = { thinkingOpen: false, textChars: 0, inputChars: 0 };

  const stopOf = (): Step['stop'] | undefined => plan.steps[stepIndex]?.stop;
  const fire = (how: string): void => {
    const s = stopOf();
    if (!s || fired.has(stepIndex) || !run) {
      return;
    }
    fired.add(stepIndex);
    const rec: Json = { step: stepIndex, at: s.at, method: s.method, how, ms: now(), wall: Date.now() };
    stops.push(rec);
    ev.write('proof', 'stop', rec);
    if (s.method === 'interrupt') {
      const r = run;
      void r.interrupt().then(
        (res) => ev.write('proof', 'interrupt-returned', { result: (res ?? null) as unknown as Json }),
        (err: unknown) => ev.write('proof', 'interrupt-error', { error: String(err) }),
      );
    } else if (s.method === 'abort') {
      abort.abort();
      ev.write('proof', 'abort-called', {});
    } else if (s.method === 'push') {
      const next = plan.steps[stepIndex + 1];
      if (next) {
        pushedNext = true;
        ev.write('proof', 'push', { step: stepIndex + 1, text: next.text });
        run.send(user(next.text));
      }
    } else {
      const sig = s.method.slice('kill:'.length) as NodeJS.Signals;
      const k = finder?.kill(sig) ?? { sent: false, why: 'no finder' };
      ev.write('proof', 'kill', k);
      rec.kill = k;
      if (k.sent && finder) {
        void finder.waitGone(Number(k.pid), String(k.starttime), 30_000).then((gone) => ev.write('proof', 'kill-gone', { pid: k.pid, goneMs: gone ?? null, afterMs: gone ? gone - Number(k.ms) : null }));
      }
    }
  };

  const onHook = async (h: HookEvent, input: HookInput): Promise<void> => {
    const i = input as Json;
    const s = stopOf();
    if (h === 'PreToolUse' && s?.at === 'tool-exec' && i.tool_name === 'Bash') {
      setTimeout(() => fire('2 s after PreToolUse for Bash'), 2000);
    }
    if (h === 'Stop' && plan.scenario.stopHookHoldMs) {
      if (s?.at === 'stop-hook') {
        setTimeout(() => fire('1 s into the held Stop hook'), 1000);
      }
      await new Promise((r) => setTimeout(r, plan.scenario.stopHookHoldMs));
    }
  };

  const store = plan.resume?.source === 'transcript' ? undefined : new RecordingStore(ev, rawAppends, plan.resume?.loadFrom);
  const options: HarnessOptions = {
    model: plan.model,
    thinking: plan.scenario.thinking ?? { type: 'adaptive', display: 'summarized' },
    includePartialMessages: true,
    tools: plan.scenario.tools ?? ['Bash', 'Write'],
    canUseTool: async (toolName, input) => {
      ev.write('proof', 'canUseTool', { toolName });
      return { behavior: 'allow', updatedInput: input };
    },
    hooks: hooks(ev, onHook),
    abortController: abort,
    ...(store ? { sessionStore: store, sessionStoreFlush: 'eager' as const } : {}),
    ...(plan.resume ? { resume: plan.resume.sessionId } : {}),
    ...(plan.resume?.resumeSessionAt ? { resumeSessionAt: plan.resume.resumeSessionAt } : {}),
    env: { ...process.env, ...(plan.scenario.env ?? {}), OTEL_LOG_RAW_API_BODIES: `file:${bodies}` },
  };

  const configDir = join(HARNESS_STATE, 'config-dirs', plan.agent);
  const transcripts = new TranscriptWatch(ev);
  transcripts.prime(join(configDir, 'projects'));
  const bodiesWatch = new BodiesWatch(bodies, ev);
  bodiesWatch.onRequest = (r) => {
    const s = stopOf();
    if (s?.at !== 'first-byte' || fired.has(stepIndex)) {
      return;
    }
    const b = r.body;
    if (!String(b.model).startsWith(plan.model) || b.thinking === undefined) {
      return;
    }
    if (!JSON.stringify(b.messages).includes(plan.steps[stepIndex]?.text.slice(0, 40) ?? '\u0000')) {
      return;
    }
    fire(`request file ${r.file}`);
  };

  run = startRun({ name: plan.agent, options });
  events = new Events(run.dir, rawDir);
  for (const [s, k, d] of pre) {
    events.write(s, k, d);
  }
  const realBinary = (JSON.parse(readFileSync(join(run.dir, 'run.json'), 'utf8')) as Json).realBinary as string;
  finder = new ClaudeFinder(join(run.dir, 'claude'), realBinary, events);
  finder.onFound = (p) => {
    if (p.configDir && p.configDir !== configDir) {
      transcripts.addLive(join(p.configDir, 'projects'));
    }
  };
  writeFileSync(join(run.dir, 'cancel-plan.json'), `${JSON.stringify({ label: plan.label, agent: plan.agent, model: plan.model, scenario: plan.scenario.id, steps: plan.steps, idleMs: plan.idleMs ?? null, resume: plan.resume ? { sessionId: plan.resume.sessionId, source: plan.resume.source, resumeSessionAt: plan.resume.resumeSessionAt ?? null } : null, rawDir }, null, 2)}\n`);
  process.stdout.write(`${stamp()} ${plan.label}: run ${run.dir}\n`);
  transcripts.start();
  bodiesWatch.start();
  finder.start();

  // Drive.
  let sessionId: string | undefined;
  let quiet: NodeJS.Timeout | undefined;
  let stepTimer: NodeJS.Timeout | undefined;
  let resultSeen = false;
  const r = run;
  const send = (): void => {
    stepIndex += 1;
    const step = plan.steps[stepIndex];
    if (step === undefined) {
      ev.write('proof', 'end', {});
      r.end();
      return;
    }
    if (pushedNext && plan.steps[stepIndex - 1]?.stop?.method === 'push') {
      // Sent already by the push; move on after its result.
      pushedNext = false;
      // Its result has come by now (the quiet period follows the last
      // result), so go straight on to the step after it.
      ev.write('proof', 'skip-pushed', { step: stepIndex });
      resultSeen = false;
      send();
      return;
    }
    ev.write('proof', 'send', { step: stepIndex, text: step.text });
    resultSeen = false;
    stream.thinkingOpen = false;
    stream.textChars = 0;
    stream.inputChars = 0;
    r.send(user(step.text));
    if (step.stop?.at === 'immediate') {
      const d = step.stop.delayMs ?? 0;
      if (d === 0) {
        fire('immediately after send');
      } else {
        setTimeout(() => fire(`${d} ms after send`), d);
      }
    }
    clearTimeout(stepTimer);
    stepTimer = setTimeout(() => {
      ev.write('proof', 'step-timeout', { step: stepIndex });
      r.end();
    }, STEP_TIMEOUT_MS);
  };
  const advance = (): void => {
    quiet = undefined;
    send();
  };
  if (plan.steps.length === 0) {
    stepIndex = 0;
    setTimeout(() => {
      ev.write('proof', 'end-idle', { idleMs: plan.idleMs ?? 0 });
      r.end();
    }, plan.idleMs ?? 0);
  } else {
    send();
  }
  try {
    for await (const message of r.messages()) {
      const m = message as SDKMessage & Json;
      const { kind, detail } = sdkBrief(m);
      ev.write('sdk', kind, detail);
      if (m.type === 'system' && m.subtype === 'init') {
        sessionId = String(m.session_id);
      }
      if (quiet) {
        clearTimeout(quiet);
        quiet = undefined;
      }
      const s = stopOf();
      if (m.type === 'stream_event' && (m.parent_tool_use_id ?? null) === null && s && !fired.has(stepIndex)) {
        const e = m.event as unknown as Json;
        const block = e.content_block as Json | undefined;
        const delta = e.delta as Json | undefined;
        if (e.type === 'content_block_start' && block?.type === 'thinking') {
          stream.thinkingOpen = true;
          if (s.at === 'thinking') {
            const at = stepIndex;
            setTimeout(() => {
              if (stream.thinkingOpen && stepIndex === at) {
                fire('700 ms into an open thinking block');
              } else {
                ev.write('proof', 'trigger-missed', { step: at, why: 'thinking block closed within 700 ms' });
              }
            }, 700);
          }
        }
        if (e.type === 'content_block_stop' && stream.thinkingOpen) {
          stream.thinkingOpen = false;
        }
        if (e.type === 'content_block_delta' && delta?.type === 'text_delta') {
          stream.textChars += String(delta.text ?? '').length;
          if (s.at === 'mid-text' && stream.textChars >= 60) {
            fire(`${stream.textChars} text characters streamed`);
          }
        }
        if (e.type === 'content_block_delta' && delta?.type === 'input_json_delta') {
          stream.inputChars += String(delta.partial_json ?? '').length;
          if (s.at === 'tool-input' && stream.inputChars >= 100) {
            fire(`${stream.inputChars} tool input characters streamed`);
          }
        }
      }
      if (m.type === 'result') {
        resultSeen = true;
      }
      if (resultSeen && plan.steps.length > 0) {
        quiet = setTimeout(advance, QUIET_MS);
      }
    }
  } catch (err) {
    ev.write('proof', 'messages-error', { error: err instanceof Error ? err.message : String(err) });
  }
  clearTimeout(quiet);
  clearTimeout(stepTimer);
  let error: string | undefined;
  try {
    await r.done;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  ev.write('proof', 'run-done', { error: error ?? null });
  // Late writes.
  await new Promise((res) => setTimeout(res, 3000));
  transcripts.stop();
  bodiesWatch.stop();
  finder.stop();
  const still = finder.current();
  if (still) {
    ev.write('proof', 'still-running', { pid: still.pid });
  }
  copyBodies(bodies, r.dir);
  if (existsSync(rawAppends)) {
    writeFileSync(join(r.dir, 'store-appends.jsonl'), clean(readFileSync(rawAppends, 'utf8')));
  }
  ev.write('proof', 'finished', { sessionId: sessionId ?? null });
  process.stdout.write(`${stamp()} ${plan.label}: done${error ? ` (error: ${error})` : ''}\n`);
  return { dir: r.dir, rawDir, sessionId, rawAppends, error, stops };
}

async function runScenario(agent: string, model: string, sc: Scenario, rep: number): Promise<Json> {
  const label = `${sc.id}-r${rep}`;
  const main = await runOne({ agent, label, model, scenario: sc, steps: sc.steps });
  const row: Json = { scenario: sc.id, rep, model, main: main.dir, mainRaw: main.rawDir, sessionId: main.sessionId ?? null, mainError: main.error ?? null, stops: main.stops, resumes: [] as Json[] };
  if (!main.sessionId) {
    return row;
  }
  const loaded = loadAppends(main.rawAppends, main.sessionId);
  const stopped = sc.steps.find((s) => s.stop);
  for (const res of sc.resumes) {
    let at: string | undefined;
    if (res.at === 'last') {
      at = lastChain(loaded);
    } else if (res.at === 'before-prompt') {
      const prompt = loaded.find((e) => e.type === 'user' && textOf(e) === stopped?.text);
      at = typeof prompt?.parentUuid === 'string' ? prompt.parentUuid : undefined;
    }
    if (res.at && !at) {
      (row.resumes as Json[]).push({ label: res.label, skipped: `no entry for at=${res.at}` });
      continue;
    }
    const out = await runOne({
      agent,
      label: `${label}-${res.label}`,
      model,
      scenario: sc,
      steps: res.steps,
      idleMs: res.idleMs,
      resume: { sessionId: main.sessionId, source: res.source, loadFrom: res.source === 'store' ? main.rawAppends : undefined, resumeSessionAt: at },
    });
    (row.resumes as Json[]).push({ label: res.label, source: res.source, at: res.at ?? null, resumeSessionAt: at ?? null, atEntry: at ? entryBrief(loaded.find((e) => e.uuid === at) ?? {}) : null, dir: out.dir, raw: out.rawDir, sessionId: out.sessionId ?? null, error: out.error ?? null });
  }
  return row;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (n: string): string | undefined => {
    const i = args.indexOf(n);
    if (i < 0) {
      return undefined;
    }
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const reps = Number(flag('--reps') ?? '1');
  const agent = flag('--agent') ?? 'cancel-sdk';
  const reset = args.includes('--reset');
  const [model, ...wanted] = args.filter((a) => a !== '--reset');
  if (!model || wanted.length === 0) {
    process.stderr.write('usage: node proofs/cancel/run.mts <model> <scenario...> [--reps N] [--agent NAME] [--reset]\n');
    process.exit(2);
  }
  const all = scenarios();
  const chosen = wanted.flatMap((w) => {
    const hit = all.filter((s) => s.id === w || (w.endsWith('*') && s.id.startsWith(w.slice(0, -1))));
    if (hit.length === 0) {
      throw new Error(`no scenario ${w}; known: ${all.map((s) => s.id).join(' ')}`);
    }
    return hit;
  });
  mkdirSync(STATE, { recursive: true });
  if (reset) {
    process.stdout.write(`${stamp()} reset ${resetConfigDir(agent)}\n`);
  }
  const index: Json[] = [];
  const indexPath = join(PACKAGE, 'runs', `cancel-index-${agent}-${stamp().replace(/[:.]/g, '')}.json`);
  for (let rep = 1; rep <= reps; rep += 1) {
    for (const sc of chosen) {
      try {
        index.push(await runScenario(agent, model, sc, rep));
      } catch (err) {
        index.push({ scenario: sc.id, rep, failed: err instanceof Error ? err.message : String(err) });
        process.stdout.write(`${stamp()} ${sc.id}: failed ${String(err)}\n`);
      }
      writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
    }
  }
  process.stdout.write(`${stamp()} INDEX ${indexPath}\n`);
}

await main();
