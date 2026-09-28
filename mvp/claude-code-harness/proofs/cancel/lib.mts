// Cancel scenarios: the recording pieces. Copied from proof 23
// (proofs/commit/run.mts, which runs on import) and widened:
//   - TranscriptWatch tails every .jsonl under any number of projects/
//     roots (subagent transcripts, and the temp config dir a store resume
//     runs in), not one file by session id.
//   - ClaudeFinder finds the real Claude Code binary this run started (the
//     capture wrapper's child), its start time and its CLAUDE_CONFIG_DIR,
//     so a kill goes only to a pid this run started, checked by start time.
//
// Nothing here is participant code or a proposal for it.

import { appendFileSync, existsSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { HookCallbackMatcher, HookEvent, HookInput, SDKMessage, SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import { redact, stamp } from '../../src/record.mts';

export type Json = Record<string, unknown>;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
export const clean = (text: string): string => redact(text).text.replace(EMAIL, '[email redacted]');
export const now = (): number => performance.timeOrigin + performance.now();
export const POLL_MS = 5;

// ms is monotonic (timeOrigin + now()); wall is Date.now(), the clock file
// mtimes are on.
export class Events {
  readonly path: string;
  readonly raw: string;
  constructor(dir: string, rawDir: string) {
    this.path = join(dir, 'cancel-events.jsonl');
    this.raw = join(rawDir, 'cancel-events.jsonl');
  }
  write(src: string, kind: string, detail: Json = {}): void {
    const line = JSON.stringify({ ts: stamp(), ms: now(), wall: Date.now(), src, kind, ...detail });
    appendFileSync(this.raw, `${line}\n`);
    appendFileSync(this.path, `${clean(line)}\n`);
  }
}

type Block = Json & { type?: string };

export function blockBrief(b: Block): Json {
  const out: Json = { type: b.type };
  if (typeof b.text === 'string') {
    out.textLen = b.text.length;
    out.text = b.text.slice(0, 100);
  }
  if (typeof b.thinking === 'string') {
    out.thinkingLen = b.thinking.length;
  }
  if (typeof b.signature === 'string') {
    out.sigLen = b.signature.length;
  }
  if (b.type === 'tool_use') {
    out.id = b.id;
    out.name = b.name;
    out.input = JSON.stringify(b.input ?? null).slice(0, 100);
  }
  if (b.type === 'tool_result') {
    out.tool_use_id = b.tool_use_id;
    out.is_error = b.is_error;
    out.content = JSON.stringify(b.content ?? null).slice(0, 160);
  }
  return out;
}

export function contentBrief(content: unknown): unknown {
  if (typeof content === 'string') {
    return [{ type: 'string', textLen: content.length, text: content.slice(0, 160) }];
  }
  if (Array.isArray(content)) {
    return (content as Block[]).map(blockBrief);
  }
  return content;
}

export function entryBrief(e: Json): Json {
  const m = e.message as Json | undefined;
  const out: Json = { uuid: e.uuid, parentUuid: e.parentUuid, type: e.type };
  for (const k of ['subtype', 'isMeta', 'isSidechain', 'isApiErrorMessage', 'isAbortedMidStream', 'isCompactSummary', 'promptId', 'requestId', 'timestamp', 'version', 'apiError', 'error', 'toolUseResult', 'logicalParentUuid', 'agentId', 'sourceToolAssistantUUID', 'interruptedMessageId']) {
    if (e[k] !== undefined) {
      out[k] = k === 'toolUseResult' ? JSON.stringify(e[k]).slice(0, 160) : e[k];
    }
  }
  const att = e.attachment as Json | undefined;
  if (att) {
    out.attachment = att.type;
  }
  if (m) {
    out.role = m.role;
    out.msgId = m.id;
    out.model = m.model;
    out.stop_reason = m.stop_reason;
    out.content = contentBrief(m.content);
  }
  if (typeof e.content === 'string') {
    out.content = [{ type: 'string', text: e.content.slice(0, 160) }];
  }
  return out;
}

// Tails every .jsonl under each root (recursively). A root added before the
// run starts is primed: only lines added after priming are logged. A root
// found during the run (a store resume's temp config dir) logs the lines
// already there as `preexisting`, then tails.
export class TranscriptWatch {
  readonly roots = new Set<string>();
  readonly offsets = new Map<string, number>();
  readonly pending = new Map<string, string>();
  readonly events: Events;
  timer: NodeJS.Timeout | undefined;
  lines = 0;
  constructor(events: Events) {
    this.events = events;
  }
  private files(root: string): string[] {
    const out: string[] = [];
    const walk = (d: string): void => {
      let names: string[];
      try {
        names = readdirSync(d);
      } catch {
        return;
      }
      for (const n of names) {
        const p = join(d, n);
        let st;
        try {
          st = statSync(p);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          walk(p);
        } else if (n.endsWith('.jsonl')) {
          out.push(p);
        }
      }
    };
    walk(root);
    return out;
  }
  prime(root: string): void {
    this.roots.add(root);
    for (const f of this.files(root)) {
      this.offsets.set(f, statSync(f).size);
    }
  }
  addLive(root: string): void {
    if (this.roots.has(root)) {
      return;
    }
    this.roots.add(root);
    this.events.write('transcript', 'root', { root });
    // Existing files: read from 0, logged as preexisting.
    for (const f of this.files(root)) {
      this.readNew(f, 'preexisting');
    }
  }
  start(): void {
    this.timer = setInterval(() => this.poll(), POLL_MS);
  }
  stop(): void {
    clearInterval(this.timer);
    this.poll();
  }
  poll(): void {
    for (const root of this.roots) {
      for (const f of this.files(root)) {
        this.readNew(f, 'line');
      }
    }
  }
  private readNew(f: string, kind: string): void {
    let size: number;
    try {
      size = statSync(f).size;
    } catch {
      return;
    }
    const off = this.offsets.get(f);
    if (off === undefined) {
      this.events.write('transcript', 'file', { file: f });
    }
    const from = off ?? 0;
    if (size <= from) {
      this.offsets.set(f, from);
      return;
    }
    const chunk = readFileSync(f).subarray(from, size).toString('utf8');
    this.offsets.set(f, size);
    let pending = (this.pending.get(f) ?? '') + chunk;
    let at = pending.indexOf('\n');
    while (at >= 0) {
      const line = pending.slice(0, at);
      pending = pending.slice(at + 1);
      at = pending.indexOf('\n');
      if (line.trim() === '') {
        continue;
      }
      this.lines += 1;
      const rel = [...this.roots].map((r) => relative(r, f)).find((r) => !r.startsWith('..')) ?? f;
      try {
        this.events.write('transcript', kind, { n: this.lines, file: rel, entry: entryBrief(JSON.parse(line) as Json) });
      } catch {
        this.events.write('transcript', 'unparsed', { n: this.lines, file: rel, len: line.length });
      }
    }
    this.pending.set(f, pending);
  }
}

export interface SeenRequest {
  file: string;
  body: Json;
  seenMs: number;
}

export class BodiesWatch {
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
          continue;
        }
        this.seen.add(f);
        const msgs = (body.messages as Json[] | undefined) ?? [];
        const last = msgs[msgs.length - 1];
        this.events.write('bodies', 'request', {
          file: f,
          mtimeMs: statSync(path).mtimeMs,
          model: body.model,
          hasThread: body.thread !== undefined,
          hasThinking: body.thinking !== undefined,
          tools: Array.isArray(body.tools) ? (body.tools as Json[]).length : null,
          messages: msgs.length,
          last: last ? { role: last.role, content: contentBrief(last.content) } : null,
        });
        this.onRequest({ file: f, body, seenMs: now() });
      } else if (f.endsWith('.response.json')) {
        let r: Json;
        try {
          r = JSON.parse(readFileSync(path, 'utf8')) as Json;
        } catch {
          continue;
        }
        this.seen.add(f);
        this.events.write('bodies', 'response', { file: f, mtimeMs: statSync(path).mtimeMs, id: r.id, stop_reason: r.stop_reason, content: contentBrief(r.content), error: r.error ?? r.type === 'error' ? r : undefined });
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
            this.events.write('bodies', 'index', { query_source: j.query_source, model: j.model, request_id: j.request_id, message_id: j.message_id, request_file: j.request_file, response_file: j.response_file, timestamp: j.timestamp });
          } catch {
            this.events.write('bodies', 'index-unparsed', {});
          }
        }
      }
    }
  }
}

// Records every append (raw, outside the repo); load() returns what the
// chosen earlier runs appended (in order), for a store resume: the main
// transcript and, by subpath, subagent transcripts (listSubkeys names them).
export class RecordingStore implements SessionStore {
  readonly events: Events;
  readonly rawPath: string;
  readonly loadFrom: string[];
  readonly all: Json[] = [];
  constructor(events: Events, rawPath: string, loadFrom?: string | string[]) {
    this.events = events;
    this.rawPath = rawPath;
    this.loadFrom = loadFrom === undefined ? [] : Array.isArray(loadFrom) ? loadFrom : [loadFrom];
  }
  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    appendFileSync(this.rawPath, `${JSON.stringify({ ts: stamp(), ms: now(), key, entries })}\n`);
    if (!key.subpath) {
      this.all.push(...(entries as Json[]));
    }
    this.events.write('store', 'append', { key, count: entries.length, entries: (entries as Json[]).map(entryBrief) });
  }
  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    if (this.loadFrom.length === 0) {
      this.events.write('store', 'load', { key, returned: null });
      return null;
    }
    const entries = loadAppends(this.loadFrom, key.sessionId, key.subpath);
    this.events.write('store', 'load', { key, returned: entries.length, entries: entries.map(entryBrief) });
    return entries.length === 0 && key.subpath ? null : (entries as SessionStoreEntry[]);
  }
  async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
    const subs = new Set<string>();
    for (const a of readAppends(this.loadFrom)) {
      if (a.key.sessionId === key.sessionId && a.key.subpath) {
        subs.add(a.key.subpath);
      }
    }
    this.events.write('store', 'listSubkeys', { key, returned: [...subs] });
    return [...subs];
  }
}

function readAppends(paths: string[]): { key: SessionKey; entries: Json[] }[] {
  return paths
    .filter((p) => existsSync(p))
    .flatMap((p) =>
      readFileSync(p, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as { key: SessionKey; entries: Json[] }),
    );
}

export function loadAppends(paths: string | string[], sessionId: string, subpath?: string): Json[] {
  return readAppends(Array.isArray(paths) ? paths : [paths])
    .filter((a) => (a.key.subpath ?? undefined) === (subpath ?? undefined) && a.key.sessionId === sessionId)
    .flatMap((a) => a.entries);
}

// The real Claude Code this run started: the capture wrapper's child
// (<run>/claude/<n>/argv.json names the wrapper pid). Checked against the
// real binary's path and recorded with its start time; a kill goes only to a
// pid found here whose start time still matches.
export interface ClaudeProc {
  spawn: string;
  wrapperPid: number;
  pid: number;
  starttime: string;
  configDir: string | undefined;
  foundMs: number;
}

export function procStat(pid: number): { state: string; starttime: string } | undefined {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
    return { state: f[0] ?? '?', starttime: f[19] ?? '?' };
  } catch {
    return undefined;
  }
}

export class ClaudeFinder {
  readonly captureDir: string;
  readonly realBinary: string;
  readonly events: Events;
  readonly found = new Map<string, ClaudeProc>();
  readonly exited = new Set<string>();
  onFound: (p: ClaudeProc) => void = () => {};
  timer: NodeJS.Timeout | undefined;
  constructor(captureDir: string, realBinary: string, events: Events) {
    this.captureDir = captureDir;
    this.realBinary = realBinary;
    this.events = events;
  }
  start(): void {
    this.timer = setInterval(() => this.poll(), POLL_MS);
  }
  stop(): void {
    clearInterval(this.timer);
    this.poll();
  }
  current(): ClaudeProc | undefined {
    const live = [...this.found.values()].filter((p) => !this.exited.has(p.spawn));
    return live[live.length - 1];
  }
  poll(): void {
    let spawns: string[] = [];
    try {
      spawns = readdirSync(this.captureDir);
    } catch {
      return;
    }
    for (const s of spawns) {
      const dir = join(this.captureDir, s);
      if (!this.found.has(s)) {
        let wrapperPid: number;
        try {
          wrapperPid = Number((JSON.parse(readFileSync(join(dir, 'argv.json'), 'utf8')) as Json).wrapperPid);
        } catch {
          continue;
        }
        let children: number[] = [];
        try {
          children = readFileSync(`/proc/${wrapperPid}/task/${wrapperPid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
        } catch {
          continue;
        }
        for (const pid of children) {
          let exe = '';
          try {
            exe = readlinkSync(`/proc/${pid}/exe`);
          } catch {
            continue;
          }
          if (exe !== this.realBinary) {
            continue;
          }
          const st = procStat(pid);
          if (!st) {
            continue;
          }
          let configDir: string | undefined;
          try {
            const env = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
            configDir = env.find((e) => e.startsWith('CLAUDE_CONFIG_DIR='))?.slice('CLAUDE_CONFIG_DIR='.length);
          } catch {
            configDir = undefined;
          }
          const p: ClaudeProc = { spawn: s, wrapperPid, pid, starttime: st.starttime, configDir, foundMs: now() };
          this.found.set(s, p);
          this.events.write('proc', 'found', { ...p });
          this.onFound(p);
        }
      }
      if (this.found.has(s) && !this.exited.has(s) && existsSync(join(dir, 'exit.json'))) {
        this.exited.add(s);
        try {
          this.events.write('proc', 'exit', { spawn: s, exit: JSON.parse(readFileSync(join(dir, 'exit.json'), 'utf8')) });
        } catch {
          this.events.write('proc', 'exit', { spawn: s });
        }
      }
    }
  }
  // Signal the current Claude Code, only if its start time still matches.
  kill(signal: NodeJS.Signals): Json {
    const p = this.current();
    if (!p) {
      return { sent: false, why: 'no live Claude Code found for this run' };
    }
    const st = procStat(p.pid);
    if (!st || st.starttime !== p.starttime || st.state === 'Z') {
      return { sent: false, why: 'pid gone or start time changed', pid: p.pid };
    }
    const at = now();
    process.kill(p.pid, signal);
    return { sent: true, pid: p.pid, starttime: p.starttime, signal, ms: at, wall: Date.now() };
  }
  // Poll until the pid has gone (or is a zombie).
  async waitGone(pid: number, starttime: string, timeoutMs: number): Promise<number | undefined> {
    const deadline = now() + timeoutMs;
    for (;;) {
      const st = procStat(pid);
      if (!st || st.starttime !== starttime || st.state === 'Z' || st.state === 'X') {
        return now();
      }
      if (now() > deadline) {
        return undefined;
      }
      await new Promise((r) => setTimeout(r, 2));
    }
  }
}

const HOOKS: HookEvent[] = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure', 'SessionStart', 'SessionEnd', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'PostToolBatch'];

export function hooks(events: Events, on: (event: HookEvent, input: HookInput) => Promise<void> | void): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const out: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
  for (const h of HOOKS) {
    out[h] = [
      {
        hooks: [
          async (input) => {
            const i = input as Json;
            const detail: Json = { event: h };
            for (const k of ['tool_name', 'tool_use_id', 'agent_id', 'agent_type', 'source', 'trigger', 'stop_hook_active', 'error', 'reason']) {
              if (i[k] !== undefined) {
                detail[k] = i[k];
              }
            }
            if (typeof i.prompt === 'string') {
              detail.prompt = i.prompt.slice(0, 80);
            }
            events.write('hook', h, detail);
            await on(h, input);
            events.write('hook', `${h}:returned`, {});
            return { continue: true };
          },
        ],
      },
    ];
  }
  return out;
}

export function sdkBrief(m: SDKMessage & Json): { kind: string; detail: Json } {
  if (m.type === 'stream_event') {
    const ev = m.event as unknown as Json;
    const d: Json = { parent: m.parent_tool_use_id ?? null, index: ev.index };
    if (ev.type === 'message_start') {
      d.id = (ev.message as Json).id;
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
    return { kind: 'assistant', detail: { parent: m.parent_tool_use_id ?? null, uuid: m.uuid, id: msg.id, model: msg.model, stop_reason: msg.stop_reason, content: contentBrief(msg.content), error: (m as Json).error } };
  }
  if (m.type === 'user') {
    const msg = m.message as unknown as Json;
    return { kind: 'user', detail: { parent: m.parent_tool_use_id ?? null, uuid: m.uuid, isReplay: (m as Json).isReplay, isSynthetic: (m as Json).isSynthetic, content: contentBrief(msg.content) } };
  }
  if (m.type === 'result') {
    return { kind: 'result', detail: { subtype: m.subtype, is_error: m.is_error, stop_reason: (m as Json).stop_reason, num_turns: m.num_turns, result: typeof (m as Json).result === 'string' ? String((m as Json).result).slice(0, 120) : undefined, errors: (m as Json).errors } };
  }
  if (m.type === 'system') {
    const d: Json = { subtype: m.subtype };
    for (const k of ['state', 'attempt', 'max_retries', 'retry_delay_ms', 'error_status', 'error', 'session_id', 'model', 'claude_code_version', 'status', 'compact_metadata']) {
      if ((m as Json)[k] !== undefined) {
        d[k] = (m as Json)[k];
      }
    }
    return { kind: `system:${String(m.subtype)}`, detail: d };
  }
  return { kind: String(m.type), detail: {} };
}
