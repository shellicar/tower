// Cancel scenarios over the interactive CLI: the rig. One node process holds
// a local HTTP forwarder (between Claude Code and ANTHROPIC_BASE_URL, logging
// every SSE event with its time and injecting faults on request) and drives
// a private tmux server, itself started under strace so every signal each
// process receives, who sent it and how each process ended are on record.
//
// Isolation follows the harness (src/harness.mts): the agent's own
// CLAUDE_CONFIG_DIR, CLAUDE_SECURESTORAGE_CONFIG_DIR="" (the shared login),
// --setting-sources '' (no settings, no CLAUDE.md), a fixed working dir, and
// the parent session's variables stripped (plus TMUX/TMUX_PANE, since this
// shell runs inside Stephen's tmux).
//
// Nothing here is participant code or a proposal for it.

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type Events, type Json, now } from '../cancel/lib.mts';

export const STATE_ROOT = join(homedir(), '.local', 'state', 'tower-claude-code-harness');
export const VERSIONS_DIR = join(homedir(), '.local', 'share', 'claude', 'versions');

// src/harness.mts PARENT_SESSION_VARS, plus tmux's own.
const STRIP = [
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'AI_AGENT',
  'CLAUDE_PROJECT_DIR',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_INVOKED_SKILLS',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'TMUX',
  'TMUX_PANE',
];

export function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of STRIP) {
    delete env[k];
  }
  // The pane's bash would otherwise save its history into ~/.bash_history.
  env.HISTFILE = '';
  env.PS1 = 'pane$ ';
  return env;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function until<T>(label: string, fn: () => T | undefined | false, timeoutMs: number, pollMs = 5): Promise<T> {
  const start = now();
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== false) {
      return v as T;
    }
    if (now() - start > timeoutMs) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for: ${label}`);
    }
    await sleep(pollMs);
  }
}

// ---------------------------------------------------------------- forwarder

export interface SseEvent {
  type: string;
  ms: number;
  index?: number;
  blockType?: string;
}

export interface FwdReq {
  n: number;
  path: string;
  method: string;
  main: boolean;
  model?: string;
  messages?: number;
  lastUser?: string;
  // The body asks for a conversation summary (a compaction request).
  summary?: boolean;
  startMs: number;
  status?: number;
  sse: SseEvent[];
  blocks: { type: string; deltas: number; chars: number; startMs: number; stopMs?: number }[];
  stopReason?: string;
  endMs?: number;
  clientClosedMs?: number;
  fault?: string;
}

export type Fault =
  // Answer the matching request(s) with this status and body, without
  // forwarding. times: how many matching requests to answer this way.
  | { kind: 'status'; status: number; body: Json; headers?: Record<string, string>; times: number }
  // Forward, then destroy the connection to Claude Code once `after` says so.
  | { kind: 'cut'; after: (r: FwdReq) => boolean; times: number }
  // Hold the request (don't forward) until released or the client goes away.
  | { kind: 'hold'; times: number };

const textOf = (content: unknown): string => {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return (content as Json[]).map((b) => (b.type === 'text' ? String(b.text) : `[${String(b.type)}]`)).join(' ');
  }
  return '';
};

export class Forwarder {
  readonly upstream: URL;
  readonly events: Events;
  readonly reqs: FwdReq[] = [];
  server: http.Server | undefined;
  port = 0;
  fault: Fault | undefined;
  held: (() => void)[] = [];
  constructor(upstream: string, events: Events) {
    this.upstream = new URL(upstream);
    this.events = events;
  }
  mains(): FwdReq[] {
    return this.reqs.filter((r) => r.main);
  }
  releaseHeld(): void {
    for (const h of this.held.splice(0)) {
      h();
    }
  }
  async start(): Promise<void> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((r) => this.server?.listen(0, '127.0.0.1', r));
    const a = this.server.address();
    this.port = typeof a === 'object' && a ? a.port : 0;
    this.events.write('fwd', 'listening', { port: this.port, upstream: this.upstream.origin });
  }
  async stop(): Promise<void> {
    this.releaseHeld();
    this.server?.closeAllConnections();
    await new Promise<void>((r) => this.server?.close(() => r()));
  }
  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const r: FwdReq = { n: this.reqs.length + 1, path: req.url ?? '', method: req.method ?? '', main: false, startMs: now(), sse: [], blocks: [] };
      if (r.method === 'POST' && r.path.startsWith('/v1/messages') && !r.path.includes('count_tokens')) {
        try {
          const j = JSON.parse(body.toString('utf8')) as Json;
          const thinking = j.thinking as Json | undefined;
          const tools = j.tools as unknown[] | undefined;
          r.model = j.model as string;
          const msgs = (j.messages as Json[]) ?? [];
          r.messages = msgs.length;
          const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
          r.lastUser = textOf(lastUser?.content).slice(-160);
          r.summary = /summary of the conversation|detailed summary|summarize the conversation/i.test(body.toString('utf8'));
          r.main = thinking !== undefined && thinking.type !== 'disabled' && Array.isArray(tools) && tools.length > 0;
        } catch {
          r.lastUser = '(unparsed body)';
        }
      }
      this.reqs.push(r);
      this.events.write('fwd', 'request', { n: r.n, method: r.method, path: r.path, bytes: body.length, main: r.main, model: r.model, messages: r.messages, lastUser: r.lastUser, summary: r.summary });
      res.on('close', () => {
        if (!res.writableFinished) {
          r.clientClosedMs = now();
          this.events.write('fwd', 'client-closed', { n: r.n, sse: r.sse.length });
        }
      });
      const f = this.fault;
      if (r.main && f && f.times > 0) {
        f.times -= 1;
        if (f.times === 0) {
          this.fault = undefined;
        }
        r.fault = f.kind;
        if (f.kind === 'status') {
          r.status = f.status;
          this.events.write('fwd', 'fault-status', { n: r.n, status: f.status });
          res.writeHead(f.status, { 'content-type': 'application/json', ...(f.headers ?? {}) });
          res.end(JSON.stringify(f.body));
          r.endMs = now();
          return;
        }
        if (f.kind === 'hold') {
          this.events.write('fwd', 'hold', { n: r.n });
          let released = false;
          const go = (): void => {
            if (released) {
              return;
            }
            released = true;
            if (res.destroyed || r.clientClosedMs !== undefined) {
              this.events.write('fwd', 'held-dropped', { n: r.n });
              return;
            }
            this.events.write('fwd', 'released', { n: r.n });
            this.forward(req, res, body, r, undefined);
          };
          this.held.push(go);
          return;
        }
        this.forward(req, res, body, r, f.after);
        return;
      }
      this.forward(req, res, body, r, undefined);
    });
  }
  private forward(req: http.IncomingMessage, res: http.ServerResponse, body: Buffer, r: FwdReq, cutAfter: ((r: FwdReq) => boolean) | undefined): void {
    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    delete headers.host;
    delete headers['accept-encoding'];
    headers['content-length'] = String(body.length);
    const url = new URL(r.path, this.upstream);
    const mod = url.protocol === 'https:' ? https : http;
    const up = mod.request(url, { method: r.method, headers }, (ur) => {
      r.status = ur.statusCode;
      this.events.write('fwd', 'response-head', { n: r.n, status: ur.statusCode });
      const h = { ...ur.headers };
      res.writeHead(ur.statusCode ?? 502, h);
      let buf = '';
      let cut = false;
      ur.on('data', (c: Buffer) => {
        if (cut) {
          return;
        }
        res.write(c);
        buf += c.toString('utf8');
        let at = buf.indexOf('\n\n');
        while (at >= 0) {
          this.sse(r, buf.slice(0, at));
          buf = buf.slice(at + 2);
          at = buf.indexOf('\n\n');
        }
        if (cutAfter && cutAfter(r)) {
          cut = true;
          this.events.write('fwd', 'fault-cut', { n: r.n, sse: r.sse.length });
          res.socket?.destroy();
          up.destroy();
        }
      });
      ur.on('end', () => {
        r.endMs = now();
        this.events.write('fwd', 'response-end', { n: r.n, sse: r.sse.length, stopReason: r.stopReason });
        res.end();
      });
      ur.on('error', (e) => this.events.write('fwd', 'upstream-error', { n: r.n, error: String(e) }));
    });
    up.on('error', (e) => {
      this.events.write('fwd', 'upstream-error', { n: r.n, error: String(e) });
      if (!res.headersSent) {
        res.destroy();
      }
    });
    res.on('close', () => {
      if (!res.writableFinished) {
        up.destroy();
      }
    });
    up.end(body);
  }
  private sse(r: FwdReq, raw: string): void {
    const data = raw
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('');
    if (!data) {
      return;
    }
    let j: Json;
    try {
      j = JSON.parse(data) as Json;
    } catch {
      return;
    }
    const type = String(j.type);
    const ev: SseEvent = { type, ms: now() };
    if (type === 'content_block_start') {
      const b = j.content_block as Json;
      ev.index = j.index as number;
      ev.blockType = String(b.type);
      r.blocks[ev.index] = { type: ev.blockType, deltas: 0, chars: 0, startMs: ev.ms };
      this.events.write('fwd', 'sse', { n: r.n, type, index: ev.index, blockType: ev.blockType, name: b.name });
    } else if (type === 'content_block_delta') {
      const d = j.delta as Json;
      const b = r.blocks[j.index as number];
      if (b) {
        b.deltas += 1;
        b.chars += String(d.text ?? d.thinking ?? d.partial_json ?? '').length;
        if (b.deltas === 1) {
          this.events.write('fwd', 'sse', { n: r.n, type: 'first-delta', index: j.index, deltaType: d.type });
        }
      }
    } else if (type === 'content_block_stop') {
      const b = r.blocks[j.index as number];
      if (b) {
        b.stopMs = ev.ms;
      }
      this.events.write('fwd', 'sse', { n: r.n, type, index: j.index, deltas: b?.deltas, chars: b?.chars });
    } else if (type === 'message_delta') {
      r.stopReason = String((j.delta as Json)?.stop_reason);
      this.events.write('fwd', 'sse', { n: r.n, type, stopReason: r.stopReason });
    } else if (type === 'message_start') {
      this.events.write('fwd', 'sse', { n: r.n, type, id: (j.message as Json)?.id });
    } else if (type === 'error' || type === 'message_stop') {
      this.events.write('fwd', 'sse', { n: r.n, type, error: j.error });
    }
    r.sse.push(ev);
  }
}

// ---------------------------------------------------------------- tmux

export class Tmux {
  readonly sock: string;
  readonly events: Events;
  strace: ChildProcess | undefined;
  constructor(sock: string, events: Events) {
    this.sock = sock;
    this.events = events;
  }
  t(...args: string[]): string {
    return execFileSync('tmux', ['-L', this.sock, ...args], { encoding: 'utf8' });
  }
  // The server starts under strace (-f follows everything it forks: the
  // pane shells, Claude Code, its children). -o FILE PROG means strace
  // blocks fatal signals itself, so it outlives a hangup.
  async start(straceFile: string, cwd: string): Promise<void> {
    const env = cleanEnv();
    this.strace = spawn(
      'strace',
      ['-f', '--seccomp-bpf', '-ttt', '-s', '120', '-o', straceFile, '-e', 'trace=kill,tkill,tgkill,exit_group,execve,setsid,setpgid', 'tmux', '-L', this.sock, '-f', '/dev/null', 'new-session', '-d', '-s', 'run', '-n', 'keep', '-x', '200', '-y', '50', '-c', cwd, 'cat'],
      { env, stdio: 'ignore' },
    );
    this.events.write('tmux', 'strace-spawned', { pid: this.strace.pid });
    await until('tmux server', () => {
      try {
        this.t('has-session', '-t', 'run');
        return true;
      } catch {
        return false;
      }
    }, 10000, 50);
    const serverPid = Number(this.t('display', '-p', '-t', 'run', '#{pid}').trim());
    this.events.write('tmux', 'server', { serverPid });
  }
  window(name: string, cwd: string): { pane: string; panePid: number } {
    const pane = this.t('new-window', '-d', '-t', 'run', '-n', name, '-c', cwd, '-P', '-F', '#{pane_id}', 'bash --noprofile --norc -i').trim();
    const panePid = Number(this.t('display', '-p', '-t', pane, '#{pane_pid}').trim());
    this.events.write('tmux', 'window', { name, pane, panePid });
    return { pane, panePid };
  }
  type(pane: string, text: string): void {
    this.t('send-keys', '-t', pane, '-l', text);
  }
  key(pane: string, ...keys: string[]): void {
    this.t('send-keys', '-t', pane, ...keys);
  }
  capture(pane: string): string {
    try {
      return this.t('capture-pane', '-p', '-t', pane);
    } catch {
      return '(no pane)';
    }
  }
  async stop(): Promise<void> {
    try {
      this.t('kill-server');
    } catch {
      // already gone
    }
    const s = this.strace;
    if (s && s.exitCode === null) {
      await new Promise<void>((r) => {
        s.on('exit', () => r());
        setTimeout(r, 10000);
      });
    }
    this.events.write('tmux', 'stopped', { straceExit: s?.exitCode });
  }
}

// ---------------------------------------------------------------- processes

export function procStat(pid: number): { comm: string; state: string; ppid: number; pgrp: number; session: number; tpgid: number; starttime: string } | undefined {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = s.lastIndexOf(')');
    const comm = s.slice(s.indexOf('(') + 1, close);
    const f = s.slice(close + 2).split(' ');
    return { comm, state: f[0], ppid: Number(f[1]), pgrp: Number(f[2]), session: Number(f[3]), tpgid: Number(f[5]), starttime: f[19] };
  } catch {
    return undefined;
  }
}

export function children(pid: number): number[] {
  try {
    return readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

export function descendants(pid: number): number[] {
  const out: number[] = [];
  const walk = (p: number): void => {
    for (const c of children(p)) {
      out.push(c);
      walk(c);
    }
  };
  walk(pid);
  return out;
}

export interface ClaudeProc {
  pid: number;
  exe: string;
  starttime: string;
  pgrp: number;
  tpgid: number;
  session: number;
}

export function findClaude(panePid: number): ClaudeProc | undefined {
  for (const c of children(panePid)) {
    let exe = '';
    try {
      exe = readlinkSync(`/proc/${c}/exe`);
    } catch {
      continue;
    }
    if (exe.startsWith(VERSIONS_DIR)) {
      const st = procStat(c);
      if (st) {
        return { pid: c, exe, starttime: st.starttime, pgrp: st.pgrp, tpgid: st.tpgid, session: st.session };
      }
    }
  }
  return undefined;
}

export function alive(p: ClaudeProc): boolean {
  const st = procStat(p.pid);
  return st !== undefined && st.starttime === p.starttime && st.state !== 'Z';
}

export function listJsonl(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    if (!existsSync(d)) {
      return;
    }
    for (const n of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, n.name);
      if (n.isDirectory()) {
        walk(p);
      } else if (n.name.endsWith('.jsonl')) {
        out.push(p);
      }
    }
  };
  walk(root);
  return out;
}
