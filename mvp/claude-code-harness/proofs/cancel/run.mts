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

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HookEvent, HookInput, SDKMessage, SDKUserMessage, SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type { HarnessOptions, Run } from '../../src/harness.mts';
import { startRun } from '../../src/harness.mts';
import { stamp } from '../../src/record.mts';
import { type Rule, startForwarder } from './forwarder.mts';
import { BodiesWatch, ClaudeFinder, clean, Events, entryBrief, hooks, type Json, loadAppends, mono, now, procStat, RecordingStore, sdkBrief, TranscriptWatch } from './lib.mts';

const HARNESS_STATE = join(homedir(), '.local', 'state', 'tower-claude-code-harness');
const STATE = join(HARNESS_STATE, 'cancel');
const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const QUIET_MS = 2500;
const STEP_TIMEOUT_MS = 240_000;

// ---------------------------------------------------------------------------
// Scenarios

type Point = 'thinking' | 'mid-text' | 'tool-exec' | 'first-byte' | 'tool-input' | 'immediate' | 'stop-hook' | 'permission' | 'tool-partial' | 'subagent-tool' | 'compact' | 'proc-found' | 'prompt-submit';
type Sig = 'SIGTERM' | 'SIGHUP' | 'SIGINT' | 'SIGKILL';
// kill:<SIG> goes to Claude Code; host:<SIG> is the SDK's host (the process
// running query()) signalling itself, for a scenario run with host: true.
type Method = 'interrupt' | 'abort' | 'push' | `kill:${Sig}` | `host:${Sig}`;

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
  // A store resume that also loads what an earlier resume (by label) of this
  // scenario appended: a resume of a resume.
  chain?: string;
}

interface Scenario {
  id: string;
  steps: Step[];
  resumes: Resume[];
  env?: Record<string, string>;
  tools?: string[];
  thinking?: HarnessOptions['thinking'];
  stopHookHoldMs?: number;
  // canUseTool holds this long when the step stops at 'permission'.
  holdPermissionMs?: number;
  // A local forwarder (forwarder.mts) in front of the API for every run of
  // the scenario; ANTHROPIC_BASE_URL points at it.
  forward?: Rule[];
  // Claude Code started as `setpriv --pdeathsig SIGINT -- <claude>` from
  // spawnClaudeCodeProcess (the integration participant's launch), instead
  // of through the capture wrapper.
  pdeathsig?: boolean;
  // The main run's SDK host is a child process of this one, so a host:<SIG>
  // stop can kill it while this process keeps recording.
  host?: boolean;
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
  // D scenarios (cancel-sdk-d).
  // Long tool input: Claude Code had received a 516-character input whole
  // before the SDK's stream events reached 100 characters, so the input is
  // long enough to still be streaming when the stop lands.
  writeTool: 'Use the Write tool to create the file numbers.txt containing the numbers one to three hundred written in words, one per line. Then reply with the word DONE only.',
  thinkThenWrite: 'First work out, carefully and step by step, how many integers from 1 to 300 are divisible by 3 or by 5 but not by 7. Then use the Write tool to create the file result.txt containing that number on the first line, followed by the numbers one to three hundred written in words, one per line. Then reply with the word DONE only.',
  // A command that writes a file, so it asks for permission (echo alone is
  // read-only and never reached canUseTool).
  permission: 'Run this exact Bash command, once: `touch permitted.txt && echo PERMITTED`. Then reply with its output only.',
  parallel: 'In one single message, make these two Bash tool calls in parallel (both at once, not one after the other): `sleep 3; echo FAST` and `sleep 20; echo SLOW`. Then reply with both outputs only.',
  subagent: 'Use the Agent tool once, with subagent_type "general-purpose" and this prompt for the subagent: "Run this exact Bash command, once: `sleep 20; echo SUB`. Then reply with its output only." Then reply with what the subagent returned, only.',
  stopHook: 'Reply with the word STOPHOOK only.',
  // Enough text for a small auto-compact window to be crossed.
  compactFill: `Here is some filler text to read; reply with the word FILLED only. ${'The quick brown fox jumps over the lazy dog. '.repeat(400)}`,
};

// F2/F3: the forwarder acts on requests whose last user message carries one
// of these markers.
const MARK = { f2a: 'ref ZXF2A', f2b: 'ref ZXF2B', f2c: 'ref ZXF2C', f3a: 'ref ZXF3A', f3b: 'ref ZXF3B', d1h: 'ref ZXD1H' };
const marked = (text: string, m: string): string => `${text} (${m})`;

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

  // D scenarios. For each: -interrupt (same process, then NEXT) and a kill
  // of Claude Code (SIGTERM; store and transcript resumes, then NEXT).
  const both = (id: string, text: string, at: Point, extra: Partial<Scenario> = {}): void => {
    out.push({ id: `${id}-interrupt`, steps: [{ text: WARM }, { text, stop: { at, method: 'interrupt' } }, { text: NEXT }], resumes: [], ...extra });
    out.push({ id: `${id}-SIGTERM`, steps: [{ text: WARM }, { text, stop: { at, method: 'kill:SIGTERM' } }], resumes: STORE_RESUMES([{ text: NEXT }]), ...extra });
  };
  // D1: request sent, nothing back yet (fires when the step's main request
  // body file appears; the first byte came about 1 s later in earlier runs).
  both('D1', PROMPTS.thinking, 'first-byte');
  // D1h: the same with the response held 8 s by the forwarder (injected
  // delay), so the stop is certain to land before the first byte.
  both('D1h', marked(PROMPTS.thinking, MARK.d1h), 'first-byte', { forward: [{ marker: MARK.d1h, action: 'hold', ms: 8000, times: 1 }] });
  // D2: while the model streams a tool call's input, with thinking before it
  // and with thinking disabled.
  both('D2-think', PROMPTS.thinkThenWrite, 'tool-input');
  both('D2-nothink', PROMPTS.writeTool, 'tool-input', { thinking: { type: 'disabled' } });
  // D3: while canUseTool holds the permission (60 s).
  both('D3', PROMPTS.permission, 'permission', { holdPermissionMs: 60_000 });
  // D4: two Bash calls asked for in parallel, 2 s after the first finished.
  both('D4', PROMPTS.parallel, 'tool-partial');
  // D5: a subagent running a 20 s Bash command, 3 s into it.
  both('D5', PROMPTS.subagent, 'subagent-tool', { tools: ['Agent', 'Bash'] });
  // D6: 1 s into a Stop hook held 10 s.
  both('D6', PROMPTS.stopHook, 'stop-hook', { stopHookHoldMs: 10_000 });
  // D7: the SDK's host dies 700 ms into thinking; Claude Code is not
  // signalled by this runner. Plain (capture wrapper: Claude Code sees stdin
  // EOF) and pdeathsig (setpriv --pdeathsig SIGINT, the integration
  // participant's launch).
  for (const sig of ['SIGKILL', 'SIGTERM'] as const) {
    out.push({ id: `D7-plain-host${sig}`, host: true, steps: [{ text: WARM }, { text: PROMPTS.thinking, stop: { at: 'thinking', method: `host:${sig}` } }], resumes: STORE_RESUMES([{ text: NEXT }]) });
    out.push({ id: `D7-pdeathsig-host${sig}`, host: true, pdeathsig: true, steps: [{ text: WARM }, { text: PROMPTS.thinking, stop: { at: 'thinking', method: `host:${sig}` } }], resumes: STORE_RESUMES([{ text: NEXT }]) });
  }
  // D8: a kill N ms after the send.
  for (const [sig, d] of [['SIGTERM', 0], ['SIGTERM', 20], ['SIGTERM', 60], ['SIGTERM', 150], ['SIGTERM', 400], ['SIGKILL', 0], ['SIGKILL', 60], ['SIGKILL', 150]] as const) {
    out.push({ id: `D8-${sig}-${d}ms`, steps: [{ text: WARM }, { text: PROMPTS.thinking, stop: { at: 'immediate', method: `kill:${sig}`, delayMs: d } }], resumes: STORE_RESUMES([{ text: NEXT }]) });
  }
  // D9: a kill during a resume. Main: killed in thinking. Resume 1 is killed
  // (in its first reply's thinking, or right after its send); resume 2
  // resumes what the main run and resume 1 left, and sends NEXT.
  const d9 = (label: string, source: 'store' | 'transcript', stop: Step['stop']): Resume[] =>
    source === 'store'
      ? [
          { label, source, steps: [{ text: PROMPTS.thinking2, stop }] },
          { label: `${label}-then-store`, source: 'store', chain: label, steps: [{ text: NEXT }] },
          { label: `${label}-then-store-at-last`, source: 'store', chain: label, at: 'last', steps: [{ text: NEXT }] },
        ]
      : [
          { label, source, steps: [{ text: PROMPTS.thinking2, stop }] },
          { label: `${label}-then-transcript`, source: 'transcript', steps: [{ text: NEXT }] },
        ];
  const d9main: Step[] = [{ text: WARM }, { text: PROMPTS.thinking, stop: { at: 'thinking', method: 'kill:SIGTERM' } }];
  out.push({ id: 'D9-store-thinking', steps: d9main, resumes: d9('store-killed', 'store', { at: 'thinking', method: 'kill:SIGTERM' }) });
  // (immediate fired before the SDK had started Claude Code: nothing to kill.)
  out.push({ id: 'D9-store-immediate', steps: d9main, resumes: d9('store-killed', 'store', { at: 'immediate', method: 'kill:SIGTERM', delayMs: 0 }) });
  // Early in the resume: 300 ms after its process appears (loading), and at
  // its UserPromptSubmit hook (just before it writes what the resume adds).
  out.push({ id: 'D9-store-loading', steps: d9main, resumes: d9('store-killed', 'store', { at: 'proc-found', method: 'kill:SIGTERM', delayMs: 300 }) });
  out.push({ id: 'D9-store-submit', steps: d9main, resumes: d9('store-killed', 'store', { at: 'prompt-submit', method: 'kill:SIGTERM', delayMs: 0 }) });
  out.push({ id: 'D9-transcript-submit', steps: d9main, resumes: d9('transcript-killed', 'transcript', { at: 'prompt-submit', method: 'kill:SIGTERM', delayMs: 0 }) });
  out.push({ id: 'D9-transcript-thinking', steps: d9main, resumes: d9('transcript-killed', 'transcript', { at: 'thinking', method: 'kill:SIGTERM' }) });
  // D10: a kill (and an interrupt) during auto-compaction, 1 s after
  // PreCompact. The window env values are the easiest that might trigger it
  // (probe first: D10-probe).
  const compactEnv = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: process.env.CANCEL_COMPACT_WINDOW ?? '100000', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: process.env.CANCEL_COMPACT_PCT ?? '15' };
  out.push({ id: 'D10-probe', env: compactEnv, steps: [{ text: WARM }, { text: PROMPTS.compactFill }, { text: NEXT }], resumes: [] });
  // Auto-compaction is checked before a request, against the previous
  // turn's usage: the step after the filler is the one that compacts.
  out.push({ id: 'D10-interrupt', env: compactEnv, steps: [{ text: WARM }, { text: PROMPTS.compactFill }, { text: NEXT, stop: { at: 'compact', method: 'interrupt', delayMs: 1000 } }, { text: AGAIN }], resumes: [] });
  out.push({ id: 'D10-SIGTERM', env: compactEnv, steps: [{ text: WARM }, { text: PROMPTS.compactFill }, { text: NEXT, stop: { at: 'compact', method: 'kill:SIGTERM', delayMs: 1000 } }], resumes: STORE_RESUMES([{ text: AGAIN }]) });

  // F1: the output limit (CLAUDE_CODE_MAX_OUTPUT_TOKENS 64, proof 23's
  // value), then NEXT in the same process.
  out.push({ id: 'F1', env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64' }, steps: [{ text: WARM }, { text: PROMPTS.thinking }, { text: NEXT }], resumes: [] });
  // F2: injected API errors (forwarder; the real API never sees these
  // requests), CLAUDE_CODE_MAX_RETRIES 2 (proof 23's value).
  const retries = { CLAUDE_CODE_MAX_RETRIES: '2' };
  out.push({ id: 'F2-429-once', env: retries, forward: [{ marker: MARK.f2a, action: 'status', status: 429, retryAfter: 1, times: 1 }], steps: [{ text: WARM }, { text: marked(PROMPTS.thinking, MARK.f2a) }, { text: NEXT }], resumes: [] });
  out.push({ id: 'F2-529-always', env: retries, forward: [{ marker: MARK.f2b, action: 'status', status: 529 }], steps: [{ text: WARM }, { text: marked(PROMPTS.thinking, MARK.f2b) }, { text: NEXT }], resumes: [] });
  out.push({ id: 'F2-500-always', env: retries, forward: [{ marker: MARK.f2c, action: 'status', status: 500 }], steps: [{ text: WARM }, { text: marked(PROMPTS.thinking, MARK.f2c) }, { text: NEXT }], resumes: [] });
  // F3: the connection cut after 5 content_block_delta events (injected).
  out.push({ id: 'F3-cut-once', env: retries, forward: [{ marker: MARK.f3a, action: 'cut', afterDeltas: 5, times: 1 }], steps: [{ text: WARM }, { text: marked(PROMPTS.thinking, MARK.f3a) }, { text: NEXT }], resumes: [] });
  out.push({ id: 'F3-cut-always', env: retries, forward: [{ marker: MARK.f3b, action: 'cut', afterDeltas: 5 }], steps: [{ text: WARM }, { text: marked(PROMPTS.thinking, MARK.f3b) }, { text: NEXT }], resumes: [] });
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

function claimSpawnDir(root: string): string {
  mkdirSync(root, { recursive: true });
  for (let n = 1; ; n += 1) {
    const dir = join(root, String(n));
    try {
      mkdirSync(dir);
      return dir;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
    }
  }
}

// The integration participant's launch (proofs/integration/spawn.mts, which
// can't be reused as is: it also sets the participant's HOME, login and
// shell prefix): setpriv execs Claude Code in place, so the kernel sends it
// SIGINT when this process dies. The capture dir gets argv.json (wrapperPid
// is this process, so ClaudeFinder finds the real binary as its child),
// stderr and exit.json; stdin and stdout are not captured.
function pdeathsigSpawn(o: SpawnOptions): SpawnedProcess {
  const captureRoot = String(o.env.HARNESS_CAPTURE_DIR);
  const real = String(o.env.HARNESS_REAL_CLAUDE);
  const env: Record<string, string | undefined> = { ...o.env };
  delete env.HARNESS_CAPTURE_DIR;
  delete env.HARNESS_REAL_CLAUDE;
  const dir = claimSpawnDir(captureRoot);
  const child: ChildProcess = spawn('setpriv', ['--pdeathsig', 'SIGINT', '--', real, ...o.args], { cwd: o.cwd, env: env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'], signal: o.signal });
  writeFileSync(join(dir, 'argv.json'), `${JSON.stringify({ startedAt: stamp(), realBinary: real, launcher: 'setpriv --pdeathsig SIGINT --', argv: o.args, cwd: o.cwd, wrapperPid: process.pid, childPid: child.pid ?? null }, null, 2)}\n`);
  const err = createWriteStream(join(dir, 'stderr.txt'));
  child.stderr?.on('data', (c: Buffer) => err.write(c));
  child.on('exit', (code, signal) => writeFileSync(join(dir, 'exit.json'), `${JSON.stringify({ at: stamp(), code, signal })}\n`));
  return child as unknown as SpawnedProcess;
}

interface RunPlan {
  agent: string;
  label: string;
  model: string;
  scenario: Scenario;
  steps: Step[];
  idleMs?: number;
  resume?: { sessionId: string; source: 'store' | 'transcript'; loadFrom?: string[]; resumeSessionAt?: string };
  // Run as the SDK host child of a recording parent: no transcript watch or
  // process finder here (the parent does them); print the run dir.
  hostMode?: boolean;
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
        pre.push([src, kind, { ...detail, bufferedAt: stamp(), bufferedMs: now(), bufferedMono: mono() }]);
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
    } else if (s.method.startsWith('host:')) {
      const sig = s.method.slice('host:'.length) as NodeJS.Signals;
      ev.write('proof', 'host-kill', { pid: process.pid, signal: sig, ms: now(), wall: Date.now() });
      process.kill(process.pid, sig);
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
    if (h === 'PreToolUse' && s?.at === 'tool-exec' && i.tool_name === 'Bash' && i.agent_id === undefined) {
      setTimeout(() => fire('2 s after PreToolUse for Bash'), 2000);
    }
    if (h === 'PostToolUse' && s?.at === 'tool-partial' && i.agent_id === undefined) {
      setTimeout(() => fire('1 s after the first PostToolUse'), 1000);
    }
    if (h === 'PreToolUse' && s?.at === 'subagent-tool' && i.tool_name === 'Bash' && i.agent_id !== undefined) {
      setTimeout(() => fire("3 s after the subagent's PreToolUse for Bash"), 3000);
    }
    if (h === 'SubagentStart' && s?.at === 'subagent-tool') {
      setTimeout(() => fire('6 s after SubagentStart (fallback)'), 6000);
    }
    if (h === 'UserPromptSubmit' && s?.at === 'prompt-submit') {
      const d = s.delayMs ?? 0;
      if (d === 0) {
        fire('at UserPromptSubmit');
      } else {
        setTimeout(() => fire(`${d} ms after UserPromptSubmit`), d);
      }
    }
    if (h === 'PreCompact' && s?.at === 'compact') {
      const d = s.delayMs ?? 1000;
      setTimeout(() => fire(`${d} ms after PreCompact`), d);
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
    canUseTool: async (toolName, input, opts) => {
      ev.write('proof', 'canUseTool', { toolName, agentID: (opts as Json).agentID ?? null });
      const hold = plan.scenario.holdPermissionMs;
      if (hold && stopOf()?.at === 'permission' && !fired.has(stepIndex)) {
        setTimeout(() => fire('1 s into a held permission request'), 1000);
        // Aborted: left pending (nothing is answered); otherwise allowed
        // after the hold.
        const aborted = await new Promise<boolean>((res) => {
          const t = setTimeout(() => res(false), hold);
          opts.signal.addEventListener('abort', () => {
            clearTimeout(t);
            ev.write('proof', 'permission-aborted', { toolName });
            res(true);
          });
        });
        if (aborted) {
          await new Promise(() => {});
        }
        ev.write('proof', 'permission-released', { toolName });
      }
      return { behavior: 'allow', updatedInput: input };
    },
    hooks: hooks(ev, onHook),
    abortController: abort,
    ...(store ? { sessionStore: store, sessionStoreFlush: 'eager' as const } : {}),
    ...(plan.resume ? { resume: plan.resume.sessionId } : {}),
    ...(plan.resume?.resumeSessionAt ? { resumeSessionAt: plan.resume.resumeSessionAt } : {}),
    env: { ...process.env, ...(plan.scenario.env ?? {}), OTEL_LOG_RAW_API_BODIES: `file:${bodies}` },
    ...(plan.scenario.pdeathsig ? { spawnClaudeCodeProcess: pdeathsigSpawn } : {}),
  };
  // Main runs only: a resume's merged user message can carry the marker too.
  const forwarder = plan.scenario.forward && !plan.resume ? await startForwarder({ port: 0, upstream: process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com', rules: plan.scenario.forward, onEvent: (e) => ev.write('fwd', String(e.kind), e) }) : undefined;
  if (forwarder) {
    (options.env as Record<string, string>).ANTHROPIC_BASE_URL = forwarder.url;
    ev.write('fwd', 'listening', { url: forwarder.url, upstream: process.env.ANTHROPIC_BASE_URL ?? null, rules: plan.scenario.forward as unknown as Json });
  }

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
    const s = stopOf();
    if (s?.at === 'proc-found') {
      const d = s.delayMs ?? 0;
      setTimeout(() => fire(`${d} ms after Claude Code's process was found`), d);
    }
  };
  if (plan.hostMode) {
    process.stdout.write(`HOSTRUN ${JSON.stringify({ dir: run.dir, rawDir, realBinary, pid: process.pid })}\n`);
  }
  writeFileSync(join(run.dir, 'cancel-plan.json'), `${JSON.stringify({ label: plan.label, agent: plan.agent, model: plan.model, scenario: plan.scenario.id, steps: plan.steps, idleMs: plan.idleMs ?? null, resume: plan.resume ? { sessionId: plan.resume.sessionId, source: plan.resume.source, resumeSessionAt: plan.resume.resumeSessionAt ?? null } : null, rawDir }, null, 2)}\n`);
  process.stdout.write(`${stamp()} ${plan.label}: run ${run.dir}\n`);
  if (!plan.hostMode) {
    transcripts.start();
    finder.start();
  }
  bodiesWatch.start();

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
      ev.write('proof', 'skip-pushed', { step: stepIndex });
      resultSeen = false;
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
  await forwarder?.close();
  if (!plan.hostMode) {
    transcripts.stop();
    finder.stop();
  }
  bodiesWatch.stop();
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

// The main run with its SDK host as a child process (`--host`), so the host
// can die (a host:<SIG> stop) while this process keeps recording: the
// transcripts, Claude Code's process, and whatever the host's store and
// bodies recorders wrote before it died.
async function runHosted(plan: RunPlan): Promise<RunOut> {
  const configDir = join(HARNESS_STATE, 'config-dirs', plan.agent);
  const pre: [string, string, Json][] = [];
  let events: Events | undefined;
  const ev = {
    write: (src: string, kind: string, detail: Json = {}): void => {
      if (events) {
        events.write(src, kind, detail);
      } else {
        pre.push([src, kind, { ...detail, bufferedAt: stamp(), bufferedMs: now(), bufferedMono: mono() }]);
      }
    },
  } as Events;
  const transcripts = new TranscriptWatch(ev);
  transcripts.prime(join(configDir, 'projects'));
  transcripts.start();
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--host', JSON.stringify({ agent: plan.agent, label: plan.label, model: plan.model, scenario: plan.scenario.id })], { stdio: ['ignore', 'pipe', 'inherit'] });
  let info: { dir: string; rawDir: string; realBinary: string; pid: number } | undefined;
  let finder: ClaudeFinder | undefined;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => child.on('exit', (code, signal) => res({ code, signal })));
  let buf = '';
  child.stdout?.on('data', (c: Buffer) => {
    buf += c.toString('utf8');
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      process.stdout.write(`[host ${child.pid}] ${line}\n`);
      if (line.startsWith('HOSTRUN ') && !info) {
        info = JSON.parse(line.slice('HOSTRUN '.length)) as { dir: string; rawDir: string; realBinary: string; pid: number };
        events = new Events(info.dir, info.rawDir);
        for (const [s, k, d] of pre.splice(0)) {
          events.write(s, k, d);
        }
        events.write('parent', 'host', { hostPid: child.pid });
        finder = new ClaudeFinder(join(info.dir, 'claude'), info.realBinary, events);
        finder.onFound = (p) => {
          if (p.configDir && p.configDir !== configDir) {
            transcripts.addLive(join(p.configDir, 'projects'));
          }
        };
        finder.start();
      }
    }
  });
  // A heartbeat: shows whether this process kept up (its own event loop)
  // while the host died.
  const tick = setInterval(() => ev.write('parent', 'tick', {}), 100);
  const x = await exited;
  ev.write('proof', 'host-exit', { pid: child.pid ?? null, code: x.code, signal: x.signal, ms: now() });
  // Claude Code can outlive its host: wait for each one found to go.
  for (const p of finder ? [...finder.found.values()] : []) {
    const gone = await finder?.waitGone(p.pid, p.starttime, 60_000);
    if (gone === undefined) {
      const st = procStat(p.pid);
      ev.write('proof', 'claude-outlived-wait', { pid: p.pid });
      if (st && st.starttime === p.starttime) {
        process.kill(p.pid, 'SIGKILL');
        ev.write('proof', 'claude-killed-cleanup', { pid: p.pid });
      }
    } else {
      ev.write('proof', 'claude-gone', { pid: p.pid, goneMs: gone });
    }
  }
  await new Promise((res) => setTimeout(res, 3000));
  clearInterval(tick);
  transcripts.stop();
  finder?.stop();
  if (!info) {
    throw new Error(`host ${child.pid} exited (${x.code ?? x.signal}) before starting a run`);
  }
  const lines = existsSync(join(info.dir, 'cancel-events.jsonl'))
    ? readFileSync(join(info.dir, 'cancel-events.jsonl'), 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as Json)
    : [];
  const init = lines.find((e) => e.src === 'sdk' && e.kind === 'system:init');
  const sessionId = typeof init?.session_id === 'string' ? init.session_id : undefined;
  const rawAppends = join(info.rawDir, 'store-appends.jsonl');
  if (x.code !== 0) {
    // The host died before copying its records into the run dir.
    copyBodies(join(info.rawDir, 'api-bodies'), info.dir);
    if (existsSync(rawAppends)) {
      writeFileSync(join(info.dir, 'store-appends.jsonl'), clean(readFileSync(rawAppends, 'utf8')));
    }
  }
  ev.write('proof', 'finished', { sessionId: sessionId ?? null });
  return { dir: info.dir, rawDir: info.rawDir, sessionId, rawAppends, error: x.code === 0 ? undefined : `host exited code=${x.code} signal=${x.signal}`, stops: lines.filter((e) => e.src === 'proof' && e.kind === 'stop') };
}

async function runScenario(agent: string, model: string, sc: Scenario, rep: number): Promise<Json> {
  const label = `${sc.id}-r${rep}`;
  const main = sc.host ? await runHosted({ agent, label, model, scenario: sc, steps: sc.steps }) : await runOne({ agent, label, model, scenario: sc, steps: sc.steps });
  const row: Json = { scenario: sc.id, rep, model, main: main.dir, mainRaw: main.rawDir, sessionId: main.sessionId ?? null, mainError: main.error ?? null, stops: main.stops, resumes: [] as Json[] };
  if (!main.sessionId) {
    return row;
  }
  const stopped = sc.steps.find((s) => s.stop);
  const outs = new Map<string, RunOut>();
  for (const res of sc.resumes) {
    const chained = res.chain ? outs.get(res.chain) : undefined;
    if (res.chain && !chained) {
      (row.resumes as Json[]).push({ label: res.label, skipped: `no resume ${res.chain} to chain from` });
      continue;
    }
    const loadFrom = [main.rawAppends, ...(chained ? [chained.rawAppends] : [])];
    const loaded = loadAppends(loadFrom, main.sessionId);
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
      resume: { sessionId: main.sessionId, source: res.source, loadFrom: res.source === 'store' ? loadFrom : undefined, resumeSessionAt: at },
    });
    outs.set(res.label, out);
    (row.resumes as Json[]).push({ label: res.label, chain: res.chain ?? null, source: res.source, at: res.at ?? null, resumeSessionAt: at ?? null, atEntry: at ? entryBrief(loaded.find((e) => e.uuid === at) ?? {}) : null, dir: out.dir, raw: out.rawDir, sessionId: out.sessionId ?? null, error: out.error ?? null });
  }
  return row;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '--host') {
    const h = JSON.parse(args[1] ?? '{}') as { agent: string; label: string; model: string; scenario: string };
    const sc = scenarios().find((x) => x.id === h.scenario);
    if (!sc) {
      throw new Error(`--host: no scenario ${h.scenario}`);
    }
    await runOne({ agent: h.agent, label: h.label, model: h.model, scenario: sc, steps: sc.steps, hostMode: true });
    return;
  }
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
