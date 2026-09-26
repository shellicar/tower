// Proof 23: when does Claude Code commit? (Stephen, 27 Sep: "you commit once
// claude code has *committed* it"; "the outcome is to *TEST* it / see what
// options there are, and how accurate they are against what claude code
// itself does".)
//
// One session per cell (an ending and a stop method) on one model:
//
//   step 0  warm-up prompt, run to the end (the session title request and
//           the account's connectors get out of the way; a baseline turn)
//   step 1  the cell's prompt, stopped at the cell's ending by interrupt()
//           (the first Ctrl-C) or by the SDK's abort (Options.abortController)
//   step 2  the probe prompt. After interrupt() it goes into the same running
//           Claude Code; after an abort there is no process left, so it goes
//           into resumes of the session (see below).
//
// Ground truth is the probe's request: its history is what Claude Code kept.
//
// Resumes, each a separate run under the same agent name (same config dir):
//   store       resume with a sessionStore whose load() returns exactly what
//               append() received during the cell's run (the SDK resumes
//               through the store)
//   transcript  resume with no sessionStore: Claude Code loads its own
//               transcript from the config directory
// After an abort both run (the probe is sent into each). After an interrupt
// (and after a cell with no stop) the transcript resume runs too, with a
// second probe, to compare what is on disk with what the running Claude Code
// had in memory, and to get the history whole when the probe's request only
// continues a server-side thread.
//
// Every candidate signal is recorded in the same runs, passively, into
// commit-events.jsonl: SDK messages (stream events, per-block assistant
// messages, result, session_state_changed, api_retry), store appends, the
// transcript file's new lines, request and response files and index.jsonl
// lines from OTEL_LOG_RAW_API_BODIES, and hooks (UserPromptSubmit,
// PreToolUse, PostToolUse, PostToolUseFailure, Stop, StopFailure,
// MessageDisplay, SessionEnd).
//
// Choices made for this proof, not decisions (TODO: undecided, each the
// easiest thing that runs; none is a proposal for the participant):
//   - Triggers: first-byte fires on the step's main request file; thinking
//     700 ms after the thinking block starts (only if it is still open);
//     after-thinking on the thinking block's content_block_stop; mid-text
//     once 60 characters of text have streamed; tool-input once 100
//     characters of tool input have streamed; tool-exec 2 s after PreToolUse
//     for Bash. Each is a race: the analysis sorts runs by where they
//     actually stopped.
//   - Retry: CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS=1 (Claude Code's own
//     first-byte window, undocumented), so the first attempt of every
//     request fails before any byte and is retried. No traffic goes through
//     the proof.
//   - Thinking-only reply: asked for in the prompt (natural), and by
//     CLAUDE_CODE_MAX_OUTPUT_TOKENS=256 (limit), proof 20's route.
//   - Tools: Bash and Write, every call approved by canUseTool.
//   - Raw request bodies and raw store appends stay under
//     ~/.local/state/tower-claude-code-harness/proof-23/; the run directory
//     gets copies with tokens and email addresses redacted.
//
//   node proofs/commit/run.mts <model> <cell> [<cell> ...]
//
// Cells: normal, thinking-only, thinking-only-limit, retry, and
// <ending>:<method> with ending first-byte, thinking, after-thinking,
// mid-text, tool-input, tool-exec and method interrupt or abort. `all` runs
// every cell.

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HookCallbackMatcher, HookEvent, HookInput, SDKMessage, SDKUserMessage, SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import type { HarnessOptions, Run } from '../../src/harness.mts';
import { startRun } from '../../src/harness.mts';
import { redact, stamp } from '../../src/record.mts';

type Json = Record<string, unknown>;

const HARNESS_STATE = join(homedir(), '.local', 'state', 'tower-claude-code-harness');
const STATE = join(HARNESS_STATE, 'proof-23');
const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const QUIET_MS = 2500;
const STEP_TIMEOUT_MS = 240_000;
const POLL_MS = 5;

// From proof 20 (proofs/semantic/publish.mts on proof-20-body-copy): the
// copies under runs/ lose email addresses; raw copies stay outside the repo.
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
export function redactEmails(text: string): string {
  return text.replace(EMAIL, '[email redacted]');
}
const clean = (text: string): string => redactEmails(redact(text).text);

const now = (): number => performance.timeOrigin + performance.now();

// ---------------------------------------------------------------------------
// Cells

const ENDINGS = ['first-byte', 'thinking', 'after-thinking', 'mid-text', 'tool-input', 'tool-exec'] as const;
type Ending = (typeof ENDINGS)[number];
type Method = 'interrupt' | 'abort';

interface Cell {
  id: string;
  prompt: string;
  ending?: Ending;
  method?: Method;
  env?: Record<string, string>;
}

const WARM = 'Reply with the word READY only.';
const PROBE = 'Reply with the word NEXT only.';
const PROBE_AGAIN = 'Reply with the word AGAIN only.';

const HARD = 'Work out, carefully and step by step, how many integers from 1 to 300 are divisible by 3 or by 5 but not by 7.';
// Haiku answered a numbers prompt by writing a file; prompts that want a
// reply in text say so.
const NO_TOOLS = 'Answer in your reply itself; do not use any tools.';

const PROMPTS: Record<Ending, string> = {
  'first-byte': `What is 17 times 23? Reply with the number only. ${NO_TOOLS}`,
  thinking: `${HARD} Reply with the number only. ${NO_TOOLS}`,
  'after-thinking': `${HARD} Then write the numbers one to thirty in words, one per line, and finally the answer. ${NO_TOOLS}`,
  'mid-text': `Write the numbers one to sixty in words, one per line, nothing else. ${NO_TOOLS}`,
  'tool-input': 'Use the Write tool to create story.txt containing a 300-word story about a lighthouse keeper. Call the Write tool straight away, with no text before it.',
  'tool-exec': 'Run this exact Bash command, once: `sleep 20; echo DONE`. Then reply with its output only.',
};

// The retry cell: Claude Code's own API timeout, set short enough that every
// attempt fails (Haiku, 27 Sep: API_TIMEOUT_MS 800 failed every attempt; 830,
// 870, 950, 1000, 1100 and 2500 never timed out; CLAUDE_STREAM_FIRST_BYTE_
// TIMEOUT_MS is clamped to at least 10 s and produced no retry). So the cell
// is a request retried and then given up, an API-error ending. A retry that
// then succeeds was not produced without routing traffic.
// P23_RETRY_ENV (JSON) overrides it.
const RETRY_ENV = JSON.parse(process.env.P23_RETRY_ENV ?? '{"API_TIMEOUT_MS":"800","CLAUDE_CODE_MAX_RETRIES":"2"}') as Record<string, string>;

function cells(): Cell[] {
  const out: Cell[] = [
    { id: 'normal', prompt: `What is 17 times 23? Work it out, then reply with the number only. ${NO_TOOLS}` },
    { id: 'thinking-only', prompt: `Think carefully about whether 391 is prime. Then end your turn with an empty reply: write no text at all, not even a single word or punctuation mark. ${NO_TOOLS}` },
    { id: 'thinking-only-limit', prompt: `${HARD} Reply with the number only. ${NO_TOOLS}`, env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '256' } },
    { id: 'retry', prompt: `What is 17 times 23? Work it out, then reply with the number only. ${NO_TOOLS}`, env: RETRY_ENV },
  ];
  for (const ending of ENDINGS) {
    for (const method of ['interrupt', 'abort'] as const) {
      out.push({ id: `${ending}:${method}`, prompt: PROMPTS[ending], ending, method });
    }
  }
  return out;
}

const short = (model: string): string => model.replace(/^claude-/, '').replace(/[^A-Za-z0-9]/g, '');
const agentName = (model: string): string => `p23-${short(model)}`;

// ---------------------------------------------------------------------------
// Recording

class Events {
  readonly path: string;
  readonly raw: string;
  constructor(dir: string, rawDir: string) {
    this.path = join(dir, 'commit-events.jsonl');
    this.raw = join(rawDir, 'commit-events.jsonl');
  }
  write(src: string, kind: string, detail: Json = {}): void {
    // ms is monotonic (timeOrigin + now()); wall is Date.now(), the clock
    // file mtimes are on. WSL steps the wall clock (a 170 ms gap between
    // the two was seen within one process), so compare mtimes with wall only.
    const line = JSON.stringify({ ts: stamp(), ms: now(), wall: Date.now(), src, kind, ...detail });
    appendFileSync(this.raw, `${line}\n`);
    appendFileSync(this.path, `${clean(line)}\n`);
  }
}

type Block = Json & { type?: string };

function blockBrief(b: Block): Json {
  const out: Json = { type: b.type };
  if (typeof b.text === 'string') {
    out.textLen = b.text.length;
    out.text = b.text.slice(0, 80);
  }
  if (typeof b.thinking === 'string') {
    out.thinkingLen = b.thinking.length;
  }
  if (typeof b.signature === 'string') {
    out.sig = b.signature.slice(0, 16);
    out.sigLen = b.signature.length;
  }
  if (b.type === 'tool_use') {
    out.id = b.id;
    out.name = b.name;
    out.inputLen = JSON.stringify(b.input ?? null).length;
  }
  if (b.type === 'tool_result') {
    out.tool_use_id = b.tool_use_id;
    out.is_error = b.is_error;
    out.content = JSON.stringify(b.content ?? null).slice(0, 120);
  }
  return out;
}

function contentBrief(content: unknown): unknown {
  if (typeof content === 'string') {
    return [{ type: 'string', textLen: content.length, text: content.slice(0, 120) }];
  }
  if (Array.isArray(content)) {
    return (content as Block[]).map(blockBrief);
  }
  return content;
}

// One transcript/store entry, reduced to what the analysis needs.
export function entryBrief(e: Json): Json {
  const m = e.message as Json | undefined;
  const out: Json = { uuid: e.uuid, parentUuid: e.parentUuid, type: e.type };
  for (const k of ['subtype', 'isMeta', 'isApiErrorMessage', 'isAbortedMidStream', 'isCompactSummary', 'promptId', 'requestId', 'timestamp', 'apiError', 'error', 'toolUseResult']) {
    if (e[k] !== undefined) {
      out[k] = k === 'toolUseResult' ? JSON.stringify(e[k]).slice(0, 120) : e[k];
    }
  }
  const att = e.attachment as Json | undefined;
  if (att) {
    out.attachment = att.type;
  }
  if (m) {
    out.role = m.role;
    out.msgId = m.id;
    out.stop_reason = m.stop_reason;
    out.content = contentBrief(m.content);
  }
  if (typeof e.content === 'string') {
    out.content = [{ type: 'string', text: e.content.slice(0, 120) }];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Watchers: transcript file and request/response bodies, polled.

class TranscriptWatch {
  readonly projects: string;
  readonly events: Events;
  sessionId: string | undefined;
  file: string | undefined;
  offset = 0;
  pending = '';
  timer: NodeJS.Timeout | undefined;
  lines = 0;
  constructor(configDir: string, events: Events) {
    this.projects = join(configDir, 'projects');
    this.events = events;
  }
  start(): void {
    this.timer = setInterval(() => this.poll(), POLL_MS);
  }
  stop(): void {
    clearInterval(this.timer);
    this.poll();
  }
  find(): void {
    if (this.file || !this.sessionId || !existsSync(this.projects)) {
      return;
    }
    for (const p of readdirSync(this.projects)) {
      const f = join(this.projects, p, `${this.sessionId}.jsonl`);
      if (existsSync(f)) {
        this.file = f;
        // Only lines this run adds: a resume appends to an existing file.
        this.offset = this.startOffset ?? 0;
        this.events.write('transcript', 'file', { file: f, from: this.offset });
        return;
      }
    }
  }
  startOffset: number | undefined;
  // For a resume: remember where the file ends before the run starts.
  prime(sessionId: string): void {
    this.sessionId = sessionId;
    if (!existsSync(this.projects)) {
      return;
    }
    for (const p of readdirSync(this.projects)) {
      const f = join(this.projects, p, `${sessionId}.jsonl`);
      if (existsSync(f)) {
        this.startOffset = statSync(f).size;
      }
    }
  }
  poll(): void {
    this.find();
    if (!this.file) {
      return;
    }
    let size: number;
    try {
      size = statSync(this.file).size;
    } catch {
      return;
    }
    if (size <= this.offset) {
      return;
    }
    const buf = readFileSync(this.file);
    const chunk = buf.subarray(this.offset, size).toString('utf8');
    this.offset = size;
    this.pending += chunk;
    let at = this.pending.indexOf('\n');
    while (at >= 0) {
      const line = this.pending.slice(0, at);
      this.pending = this.pending.slice(at + 1);
      at = this.pending.indexOf('\n');
      if (line.trim() === '') {
        continue;
      }
      this.lines += 1;
      try {
        this.events.write('transcript', 'line', { n: this.lines, entry: entryBrief(JSON.parse(line) as Json) });
      } catch {
        this.events.write('transcript', 'unparsed', { n: this.lines, len: line.length });
      }
    }
  }
}

interface SeenRequest {
  file: string;
  body: Json;
  seenMs: number;
}

class BodiesWatch {
  readonly dir: string;
  readonly events: Events;
  readonly seen = new Set<string>();
  indexOffset = 0;
  timer: NodeJS.Timeout | undefined;
  onRequest: (r: SeenRequest) => void = () => {};
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
      if (this.seen.has(f) || f === 'index.jsonl' || f === 'latest') {
        continue;
      }
      const path = join(this.dir, f);
      if (f.endsWith('.request.json')) {
        let body: Json;
        try {
          body = JSON.parse(readFileSync(path, 'utf8')) as Json;
        } catch {
          continue; // still being written
        }
        this.seen.add(f);
        const seenMs = now();
        const msgs = (body.messages as Json[] | undefined) ?? [];
        const last = msgs[msgs.length - 1];
        const firstUser = msgs.find((m) => m.role === 'user' && JSON.stringify(m.content).includes('Reply with') );
        this.events.write('bodies', 'request', {
          file: f,
          mtimeMs: statSync(path).mtimeMs,
          model: body.model,
          thread: body.thread ?? null,
          diagnostics: body.diagnostics ?? null,
          hasThinking: body.thinking !== undefined,
          tools: Array.isArray(body.tools) ? (body.tools as Json[]).length : null,
          messages: msgs.length,
          last: last ? { role: last.role, content: contentBrief(last.content) } : null,
          firstUserHit: firstUser ? true : false,
        });
        this.onRequest({ file: f, body, seenMs });
      } else if (f.endsWith('.response.json')) {
        let size = 0;
        try {
          size = statSync(path).size;
          JSON.parse(readFileSync(path, 'utf8'));
        } catch {
          continue;
        }
        this.seen.add(f);
        let brief: Json = {};
        try {
          const r = JSON.parse(readFileSync(path, 'utf8')) as Json;
          brief = { id: r.id, stop_reason: r.stop_reason, content: contentBrief(r.content) };
        } catch {
          brief = {};
        }
        this.events.write('bodies', 'response', { file: f, mtimeMs: statSync(path).mtimeMs, size, ...brief });
      }
    }
    const index = join(this.dir, 'index.jsonl');
    if (existsSync(index)) {
      const text = readFileSync(index, 'utf8');
      const tail = text.slice(this.indexOffset);
      const end = tail.lastIndexOf('\n');
      if (end >= 0) {
        this.indexOffset += end + 1;
        for (const l of tail.slice(0, end).split('\n')) {
          if (l.trim() === '') {
            continue;
          }
          try {
            const j = JSON.parse(l) as Json;
            this.events.write('bodies', 'index', { query_source: j.query_source, model: j.model, request_id: j.request_id, message_id: j.message_id, message_uuid: j.message_uuid, request_file: j.request_file, response_file: j.response_file, timestamp: j.timestamp });
          } catch {
            this.events.write('bodies', 'index-unparsed', {});
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Session store: records every append; load() returns what a chosen run
// appended (for the store resume).

class RecordingStore implements SessionStore {
  readonly events: Events;
  readonly rawPath: string;
  readonly loadFrom: string | undefined;
  constructor(events: Events, rawPath: string, loadFrom?: string) {
    this.events = events;
    this.rawPath = rawPath;
    this.loadFrom = loadFrom;
  }
  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    appendFileSync(this.rawPath, `${JSON.stringify({ ts: stamp(), ms: now(), key, entries })}\n`);
    this.events.write('store', 'append', { key, count: entries.length, entries: (entries as Json[]).map(entryBrief) });
  }
  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    if (!this.loadFrom || key.subpath) {
      this.events.write('store', 'load', { key, returned: null });
      return null;
    }
    const entries = readFileSync(this.loadFrom, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as { key: SessionKey; entries: Json[] })
      .filter((a) => !a.key.subpath && a.key.sessionId === key.sessionId)
      .flatMap((a) => a.entries);
    this.events.write('store', 'load', { key, returned: entries.length });
    return entries as SessionStoreEntry[];
  }
}

// ---------------------------------------------------------------------------
// Hooks

const HOOKS: HookEvent[] = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure', 'MessageDisplay', 'SessionEnd'];

function hooks(events: Events, onPreToolUse: (input: HookInput) => void): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const out: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
  for (const h of HOOKS) {
    out[h] = [
      {
        hooks: [
          async (input) => {
            const i = input as Json;
            const detail: Json = { event: h };
            for (const k of ['tool_name', 'tool_use_id', 'turn_id', 'message_id', 'index', 'final', 'stop_hook_active', 'error', 'error_details', 'reason']) {
              if (i[k] !== undefined) {
                detail[k] = i[k];
              }
            }
            if (typeof i.prompt === 'string') {
              detail.prompt = i.prompt.slice(0, 80);
            }
            if (typeof i.last_assistant_message === 'string') {
              detail.lastLen = i.last_assistant_message.length;
              detail.last = i.last_assistant_message.slice(0, 80);
            }
            if (typeof i.delta === 'string') {
              detail.deltaLen = i.delta.length;
            }
            events.write('hook', h, detail);
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

// ---------------------------------------------------------------------------
// Running one run: steps sent in order, each after the previous one's result
// and a quiet period.

function user(text: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
}

interface Trigger {
  ending: Ending;
  fire: (how: string) => void;
  fired: boolean;
}

// Stream state for the triggers, from the main thread's stream events.
interface StreamState {
  thinkingIndex: number | undefined;
  thinkingOpen: boolean;
  textChars: number;
  inputChars: number;
}

function sdkBrief(m: SDKMessage & Json): { kind: string; detail: Json } {
  if (m.type === 'stream_event') {
    const ev = m.event as unknown as Json;
    const d: Json = { parent: m.parent_tool_use_id ?? null, index: ev.index };
    if (ev.type === 'message_start') {
      const msg = ev.message as Json;
      d.id = msg.id;
    }
    if (ev.type === 'content_block_start') {
      d.block = (ev.content_block as Json).type;
      if ((ev.content_block as Json).type === 'tool_use') {
        d.id = (ev.content_block as Json).id;
      }
    }
    if (ev.type === 'content_block_delta') {
      const delta = ev.delta as Json;
      d.delta = delta.type;
      d.len = String(delta.text ?? delta.thinking ?? delta.partial_json ?? delta.signature ?? '').length;
    }
    if (ev.type === 'message_delta') {
      d.stop_reason = (ev.delta as Json).stop_reason;
    }
    return { kind: `stream:${String(ev.type)}`, detail: d };
  }
  if (m.type === 'assistant') {
    const msg = m.message as unknown as Json;
    return { kind: 'assistant', detail: { parent: m.parent_tool_use_id ?? null, uuid: m.uuid, id: msg.id, stop_reason: msg.stop_reason, content: contentBrief(msg.content), error: (m as Json).error } };
  }
  if (m.type === 'user') {
    const msg = m.message as unknown as Json;
    return { kind: 'user', detail: { parent: m.parent_tool_use_id ?? null, uuid: m.uuid, isReplay: (m as Json).isReplay, content: contentBrief(msg.content) } };
  }
  if (m.type === 'result') {
    return { kind: 'result', detail: { subtype: m.subtype, is_error: m.is_error, stop_reason: (m as Json).stop_reason, num_turns: m.num_turns, result: typeof (m as Json).result === 'string' ? String((m as Json).result).slice(0, 80) : undefined, errors: (m as Json).errors } };
  }
  if (m.type === 'system') {
    const d: Json = { subtype: m.subtype };
    for (const k of ['state', 'attempt', 'max_retries', 'retry_delay_ms', 'error_status', 'error', 'no_response', 'session_id', 'model']) {
      if ((m as Json)[k] !== undefined) {
        d[k] = (m as Json)[k];
      }
    }
    return { kind: `system:${String(m.subtype)}`, detail: d };
  }
  return { kind: String(m.type), detail: {} };
}

interface DriveResult {
  sessionId: string | undefined;
  error: string | undefined;
}

async function drive(run: Run, steps: string[], events: Events, trigger: Trigger | undefined, triggerStep: number, stream: StreamState): Promise<DriveResult> {
  let index = 0;
  let sessionId: string | undefined;
  let quiet: NodeJS.Timeout | undefined;
  let stepTimer: NodeJS.Timeout | undefined;
  let resultSeen = false;
  const send = (): void => {
    const text = steps[index];
    if (text === undefined) {
      events.write('proof', 'end', {});
      run.end();
      return;
    }
    events.write('proof', 'send', { step: index, text });
    resultSeen = false;
    stream.thinkingIndex = undefined;
    stream.thinkingOpen = false;
    stream.textChars = 0;
    stream.inputChars = 0;
    run.send(user(text));
    clearTimeout(stepTimer);
    stepTimer = setTimeout(() => {
      events.write('proof', 'step-timeout', { step: index });
      run.end();
    }, STEP_TIMEOUT_MS);
  };
  const advance = (): void => {
    quiet = undefined;
    index += 1;
    send();
  };
  const armed = (): boolean => trigger !== undefined && !trigger.fired && index === triggerStep;
  send();
  try {
    for await (const message of run.messages()) {
      const m = message as SDKMessage & Json;
      const { kind, detail } = sdkBrief(m);
      events.write('sdk', kind, detail);
      if (m.type === 'system' && m.subtype === 'init') {
        sessionId = String(m.session_id);
      }
      if (quiet) {
        clearTimeout(quiet);
        quiet = undefined;
      }
      if (m.type === 'stream_event' && (m.parent_tool_use_id ?? null) === null) {
        const ev = m.event as unknown as Json;
        const block = ev.content_block as Json | undefined;
        const delta = ev.delta as Json | undefined;
        if (ev.type === 'content_block_start' && block?.type === 'thinking') {
          stream.thinkingIndex = Number(ev.index);
          stream.thinkingOpen = true;
          if (armed() && trigger?.ending === 'thinking') {
            setTimeout(() => {
              if (stream.thinkingOpen && armed()) {
                trigger.fire('700 ms into an open thinking block');
              } else {
                events.write('proof', 'trigger-missed', { why: 'thinking block closed within 700 ms' });
              }
            }, 700);
          }
        }
        if (ev.type === 'content_block_stop' && Number(ev.index) === stream.thinkingIndex) {
          stream.thinkingOpen = false;
          if (armed() && trigger?.ending === 'after-thinking') {
            trigger.fire('thinking content_block_stop');
          }
        }
        if (ev.type === 'content_block_delta' && delta?.type === 'text_delta') {
          stream.textChars += String(delta.text ?? '').length;
          if (armed() && trigger?.ending === 'mid-text' && stream.textChars >= 60) {
            trigger.fire(`${stream.textChars} text characters streamed`);
          }
        }
        if (ev.type === 'content_block_delta' && delta?.type === 'input_json_delta') {
          stream.inputChars += String(delta.partial_json ?? '').length;
          if (armed() && trigger?.ending === 'tool-input' && stream.inputChars >= 100) {
            trigger.fire(`${stream.inputChars} tool input characters streamed`);
          }
        }
      }
      if (m.type === 'result') {
        resultSeen = true;
      }
      if (resultSeen) {
        quiet = setTimeout(advance, QUIET_MS);
      }
    }
  } catch (err) {
    events.write('proof', 'messages-error', { error: err instanceof Error ? err.message : String(err) });
  }
  clearTimeout(quiet);
  clearTimeout(stepTimer);
  let error: string | undefined;
  try {
    await run.done;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  events.write('proof', 'run-done', { error: error ?? null });
  return { sessionId, error };
}

// ---------------------------------------------------------------------------

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
  label: string;
  model: string;
  cell: Cell;
  steps: string[];
  trigger?: { ending: Ending; method: Method; step: number };
  resume?: { sessionId: string; source: 'store' | 'transcript'; loadFrom?: string };
}

interface RunOut {
  dir: string;
  sessionId: string | undefined;
  rawAppends: string;
  error: string | undefined;
}

async function runOne(plan: RunPlan): Promise<RunOut> {
  const name = agentName(plan.model);
  const rawDir = join(STATE, `${stamp().replace(/[:.]/g, '')}-${short(plan.model)}-${plan.label.replace(/[^A-Za-z0-9-]/g, '_')}`);
  const bodies = join(rawDir, 'api-bodies');
  mkdirSync(bodies, { recursive: true });
  const rawAppends = join(rawDir, 'store-appends.jsonl');
  const abort = new AbortController();
  let run: Run | undefined;
  // Events need the run dir; buffer until it exists.
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
  const stream: StreamState = { thinkingIndex: undefined, thinkingOpen: false, textChars: 0, inputChars: 0 };
  let trigger: Trigger | undefined;
  if (plan.trigger) {
    const t = plan.trigger;
    trigger = {
      ending: t.ending,
      fired: false,
      fire: (how: string) => {
        if (!trigger || trigger.fired || !run) {
          return;
        }
        trigger.fired = true;
        ev.write('proof', 'stop', { method: t.method, ending: t.ending, how });
        if (t.method === 'interrupt') {
          const r = run;
          void r.interrupt().then(
            (res) => ev.write('proof', 'interrupt-returned', { result: (res ?? null) as unknown as Json }),
            (err: unknown) => ev.write('proof', 'interrupt-error', { error: String(err) }),
          );
        } else {
          abort.abort();
          ev.write('proof', 'abort-called', {});
        }
      },
    };
  }
  let step = 0;
  const onPreToolUse = (input: HookInput): void => {
    const i = input as Json;
    if (trigger && !trigger.fired && trigger.ending === 'tool-exec' && i.tool_name === 'Bash') {
      setTimeout(() => trigger?.fire('2 s after PreToolUse for Bash'), 2000);
    }
  };
  const store = plan.resume?.source === 'transcript' ? undefined : new RecordingStore(ev, rawAppends, plan.resume?.loadFrom);
  const options: HarnessOptions = {
    model: plan.model,
    thinking: { type: 'adaptive', display: 'summarized' },
    includePartialMessages: true,
    tools: ['Bash', 'Write'],
    canUseTool: async (toolName, input) => {
      ev.write('proof', 'canUseTool', { toolName });
      return { behavior: 'allow', updatedInput: input };
    },
    hooks: hooks(ev, onPreToolUse),
    abortController: abort,
    ...(store ? { sessionStore: store, sessionStoreFlush: 'eager' as const } : {}),
    ...(plan.resume ? { resume: plan.resume.sessionId } : {}),
    env: { ...process.env, ...(plan.cell.env ?? {}), OTEL_LOG_RAW_API_BODIES: `file:${bodies}` },
  };
  const transcriptWatch = new TranscriptWatch(join(HARNESS_STATE, 'config-dirs', name), ev);
  if (plan.resume) {
    transcriptWatch.prime(plan.resume.sessionId);
  }
  const bodiesWatch = new BodiesWatch(bodies, ev);
  bodiesWatch.onRequest = (r) => {
    // first-byte: the main request that carries the step's prompt. Main: on
    // the model, with thinking and a thread (the title request has neither).
    if (!trigger || trigger.fired || trigger.ending !== 'first-byte' || step !== plan.trigger?.step) {
      return;
    }
    const b = r.body;
    if (!String(b.model).startsWith(plan.model) || b.thinking === undefined || b.thread === undefined) {
      return;
    }
    if (!JSON.stringify(b.messages).includes(plan.steps[plan.trigger.step]?.slice(0, 30) ?? '\u0000')) {
      return;
    }
    trigger.fire(`request file ${r.file}`);
  };
  run = startRun({ name, options });
  events = new Events(run.dir, rawDir);
  for (const [s, k, d] of pre) {
    events.write(s, k, d);
  }
  writeFileSync(join(run.dir, 'commit-plan.json'), `${JSON.stringify({ label: plan.label, model: plan.model, cell: plan.cell, steps: plan.steps, trigger: plan.trigger ?? null, resume: plan.resume ? { sessionId: plan.resume.sessionId, source: plan.resume.source } : null, rawDir }, null, 2)}\n`);
  process.stdout.write(`${stamp()} ${plan.label}: run ${run.dir}\n`);
  transcriptWatch.start();
  bodiesWatch.start();
  // The trigger's step: drive() tells us via send events; track it here.
  const origWrite = events.write.bind(events);
  events.write = (src, kind, detail = {}) => {
    if (src === 'proof' && kind === 'send') {
      step = Number(detail.step);
    }
    if (src === 'sdk' && kind === 'system:init' && !plan.resume) {
      transcriptWatch.sessionId = String(detail.session_id);
    }
    origWrite(src, kind, detail);
  };
  const result = await drive(run, plan.steps, ev, trigger, plan.trigger?.step ?? -1, stream);
  // Late writes (abort grace, final flushes).
  await new Promise((r) => setTimeout(r, 3000));
  transcriptWatch.stop();
  bodiesWatch.stop();
  copyBodies(bodies, run.dir);
  if (existsSync(rawAppends)) {
    writeFileSync(join(run.dir, 'store-appends.jsonl'), clean(readFileSync(rawAppends, 'utf8')));
  }
  ev.write('proof', 'finished', { sessionId: result.sessionId ?? transcriptWatch.sessionId ?? null });
  process.stdout.write(`${stamp()} ${plan.label}: done${result.error ? ` (error: ${result.error})` : ''}\n`);
  return { dir: run.dir, sessionId: result.sessionId ?? transcriptWatch.sessionId, rawAppends, error: result.error };
}

async function runCell(model: string, cell: Cell, index: Json[]): Promise<void> {
  const label = cell.id.replace(':', '-');
  const trig = cell.ending && cell.method ? { ending: cell.ending, method: cell.method, step: 1 } : undefined;
  const steps = cell.method === 'abort' ? [WARM, cell.prompt] : [WARM, cell.prompt, PROBE];
  const main = await runOne({ label, model, cell, steps, trigger: trig });
  const row: Json = { model, cell: cell.id, main: main.dir, sessionId: main.sessionId ?? null, mainError: main.error ?? null, resumes: {} };
  if (main.sessionId) {
    const resumes = row.resumes as Json;
    if (cell.method === 'abort') {
      const s = await runOne({ label: `${label}-resume-store`, model, cell: { ...cell, env: undefined }, steps: [PROBE], resume: { sessionId: main.sessionId, source: 'store', loadFrom: main.rawAppends } });
      resumes.store = s.dir;
      const t = await runOne({ label: `${label}-resume-transcript`, model, cell: { ...cell, env: undefined }, steps: [PROBE], resume: { sessionId: main.sessionId, source: 'transcript' } });
      resumes.transcript = t.dir;
    } else {
      // Every other cell: the running Claude Code's view (the probe) is in
      // the main run; this adds what its own transcript gives back.
      const t = await runOne({ label: `${label}-resume-transcript`, model, cell: { ...cell, env: undefined }, steps: [PROBE_AGAIN], resume: { sessionId: main.sessionId, source: 'transcript' } });
      resumes.transcript = t.dir;
    }
  }
  index.push(row);
}

async function main(): Promise<void> {
  const [model, ...wanted] = process.argv.slice(2);
  if (!model || wanted.length === 0) {
    process.stderr.write('usage: node proofs/commit/run.mts <model> <cell|all> [...]\n');
    process.exit(2);
  }
  const all = cells();
  const chosen = wanted.includes('all') ? all : wanted.map((w) => all.find((c) => c.id === w) ?? (() => { throw new Error(`no cell ${w}`); })());
  mkdirSync(STATE, { recursive: true });
  const name = agentName(model);
  if (process.env.P23_NO_RESET !== '1') {
    process.stdout.write(`${stamp()} reset ${resetConfigDir(name)}\n`);
  }
  const index: Json[] = [];
  const indexPath = join(PACKAGE, 'runs', `p23-index-${short(model)}-${stamp().replace(/[:.]/g, '')}.json`);
  for (const cell of chosen) {
    try {
      await runCell(model, cell, index);
    } catch (err) {
      index.push({ model, cell: cell.id, failed: err instanceof Error ? err.message : String(err) });
      process.stdout.write(`${stamp()} ${cell.id}: failed ${String(err)}\n`);
    }
    writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  }
  process.stdout.write(`${stamp()} INDEX ${indexPath}\n`);
}

await main();
