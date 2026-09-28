// Renders one cancel-cli run directory into report.txt: a merged timeline
// (driver actions, forwarder events, transcript lines as they landed, and
// the signal lines from strace), then every main-thread request body's
// messages, then each transcript's final chain.
//
//   node proofs/cancel-cli/render.mts <run dir>

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { contentBrief, entryBrief, type Json } from '../cancel/lib.mts';

const NOISY = new Set(['SIGCHLD', 'SIGWINCH', 'SIGURG', 'SIGALRM', 'SIGPROF', 'SIGVTALRM', 'SIGIO', 'SIGPWR', 'SIGXCPU', 'SIGUSR1', 'SIGUSR2', 'SIGRT_1', 'SIGRTMIN', 'SIGPIPE', 'SIGCONT', '0']);

const s8 = (v: unknown): string => (typeof v === 'string' ? v.slice(0, 8) : '--------');

function briefBlocks(content: unknown): string {
  const c = contentBrief(content) as Json[] | unknown;
  if (!Array.isArray(c)) {
    return JSON.stringify(c)?.slice(0, 120) ?? '';
  }
  return (c as Json[])
    .map((b) => {
      if (b.type === 'text' || b.type === 'string') {
        return `${b.type}(${JSON.stringify(String(b.text ?? '').slice(0, 70))}${Number(b.textLen ?? 0) > 70 ? `…${b.textLen}` : ''})`;
      }
      if (b.type === 'thinking') {
        return `thinking(len=${b.thinkingLen ?? '?'},sig=${b.sigLen ?? 0})`;
      }
      if (b.type === 'redacted_thinking') {
        return 'redacted_thinking';
      }
      if (b.type === 'tool_use') {
        return `tool_use(${b.name},${String(b.id).slice(-8)},${b.input})`;
      }
      if (b.type === 'tool_result') {
        return `tool_result(${String(b.tool_use_id).slice(-8)},err=${b.is_error ?? false},${String(b.content).slice(0, 80)})`;
      }
      return String(b.type);
    })
    .join(' + ');
}

function entryLine(e: Json): string {
  const flags: string[] = [];
  for (const k of ['isMeta', 'isSidechain', 'isApiErrorMessage', 'isAbortedMidStream', 'isCompactSummary', 'apiError', 'error']) {
    if (e[k] !== undefined && e[k] !== false) {
      flags.push(`${k}=${JSON.stringify(e[k])}`);
    }
  }
  if (e.model) {
    flags.push(`model=${e.model}`);
  }
  if (e.msgId) {
    flags.push(`id=${String(e.msgId).slice(0, 16)}`);
  }
  if (e.stop_reason) {
    flags.push(`stop=${e.stop_reason}`);
  }
  if (e.version) {
    flags.push(`v=${e.version}`);
  }
  const kind = [e.type, e.subtype, e.attachment].filter(Boolean).join('/');
  const content = e.content ? briefBlocks(e.content) : '';
  const hasUuid = e.uuid !== undefined;
  return `${kind}${hasUuid ? ` uuid=${s8(e.uuid)} parent=${s8(e.parentUuid)}` : ''} ${flags.join(' ')} ${content}`.trim();
}

export function render(dir: string): void {
  const out: string[] = [];
  const events = readFileSync(join(dir, 'cancel-events.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Json & { wall: number; src: string; kind: string });
  const run = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as Json;
  const t0 = events[0]?.wall ?? 0;
  const rel = (w: number): string => `${((w - t0) / 1000).toFixed(3).padStart(8)}s`;
  const clock = (w: number): string => new Date(w).toISOString().slice(11, 23);

  // Roles, for the strace lines.
  const roles = new Map<number, string>();
  for (const e of events) {
    if (e.kind === 'server') {
      roles.set(Number(e.serverPid), 'tmux-server');
    }
    if (e.kind === 'window') {
      roles.set(Number(e.panePid), `bash(${e.name})`);
    }
    if (e.kind === 'claude-started') {
      roles.set(Number(e.pid), `claude#${e.n}`);
    }
  }
  const versions = new Set<string>();
  for (const e of events) {
    const v = (e.entry as Json | undefined)?.version;
    if (typeof v === 'string') {
      versions.add(v);
    }
    if (e.kind === 'claude-started') {
      versions.add(`binary ${e.version}`);
    }
  }
  out.push(`run: ${dir}`);
  out.push(`scenario: ${run.scenario}  agent: ${run.name}  model: ${run.model}  started: ${run.started}`);
  out.push(`versions (transcript entries, binaries): ${[...versions].join(', ')}`);
  out.push(`times: +seconds from the first event, then wall clock UTC. transcript lines: when the 5 ms poll saw them; lag = poll time - the entry's own timestamp.`);
  out.push('');

  type Row = { w: number; text: string };
  const rows: Row[] = [];
  for (const e of events) {
    let text = '';
    if (e.src === 'drv') {
      const { ts, ms, wall, src, kind, ...rest } = e;
      text = `DRV   ${kind} ${JSON.stringify(rest)}`;
    } else if (e.src === 'fwd') {
      const { ts, ms, wall, src, kind, ...rest } = e;
      if (kind === 'request' && !rest.main) {
        text = `FWD   request#${rest.n} ${rest.method} ${rest.path} (side) model=${rest.model ?? ''} last=${JSON.stringify(String(rest.lastUser ?? '').slice(-60))}`;
      } else if (kind === 'request') {
        text = `FWD   request#${rest.n} MAIN msgs=${rest.messages} last=${JSON.stringify(String(rest.lastUser ?? '').slice(-80))}`;
      } else {
        text = `FWD   ${kind} ${JSON.stringify(rest)}`;
      }
    } else if (e.src === 'transcript') {
      if (e.kind === 'line' || e.kind === 'preexisting') {
        const en = e.entry as Json;
        const lag = typeof en.timestamp === 'string' ? ` lag=${e.wall - Date.parse(en.timestamp)}ms` : '';
        text = `TRN   #${e.n} ${String(e.file).split('/').slice(-1)[0].slice(0, 8)}${String(e.file).includes('subagents') ? '(sub)' : ''} ${entryLine(en)}${lag}`;
      } else {
        text = `TRN   ${e.kind} ${e.file ?? e.root ?? ''}`;
      }
    } else if (e.src === 'screen') {
      const lines = (e.lines as string[]).slice(-14).map((l) => `        | ${l.slice(0, 150)}`);
      text = `SCR   ${e.kind}\n${lines.join('\n')}`;
    } else {
      const { ts, ms, wall, src, kind, ...rest } = e;
      text = `${String(e.src).toUpperCase().padEnd(5)} ${kind} ${JSON.stringify(rest)}`;
    }
    rows.push({ w: e.wall, text });
  }

  const strace = join(dir, 'strace.txt');
  if (existsSync(strace)) {
    for (const line of readFileSync(strace, 'utf8').split('\n')) {
      const m = /^(\d+)\s+(\d+\.\d+)\s+(.*)$/.exec(line);
      if (!m) {
        continue;
      }
      const pid = Number(m[1]);
      const w = Number(m[2]) * 1000;
      const rest = m[3];
      const role = roles.get(pid);
      let keep = false;
      const sig = /--- (SIG\w+)/.exec(rest)?.[1];
      if (sig && !NOISY.has(sig)) {
        keep = true;
      }
      const call = /^(kill|tkill|tgkill)\(([^)]*)\)/.exec(rest);
      if (call) {
        const s = call[2].split(',').map((x) => x.trim()).at(-1) ?? '';
        keep = !NOISY.has(s);
      }
      if (/^(exit_group|setsid|setpgid)\(/.test(rest) && role) {
        keep = true;
      }
      if (rest.startsWith('+++') && (role || !/exited with 0/.test(rest))) {
        keep = true;
      }
      if (rest.startsWith('execve(') && /claude|bash|sleep/.test(rest) && !rest.includes('ENOENT')) {
        keep = true;
      }
      if (keep) {
        rows.push({ w, text: `SYS   pid ${pid}${role ? ` [${role}]` : ''} ${rest.slice(0, 200)}` });
      }
    }
  }
  rows.sort((a, b) => a.w - b.w);
  out.push('== timeline');
  for (const r of rows) {
    out.push(`${rel(r.w)} ${clock(r.w)} ${r.text}`);
  }
  out.push('');

  // Main-thread requests, from Claude Code's own body log.
  const bodies = join(dir, 'api-bodies');
  const index = join(bodies, 'index.jsonl');
  out.push('== requests (OTEL_LOG_RAW_API_BODIES index, in order)');
  if (existsSync(index)) {
    for (const l of readFileSync(index, 'utf8').split('\n').filter((x) => x.trim())) {
      const j = JSON.parse(l) as Json;
      out.push(`-- ${j.timestamp} ${j.query_source} model=${j.model} request=${j.request_file} response=${j.response_file ?? '-'} msg=${j.message_id ?? '-'}`);
      if (j.query_source !== 'repl_main_thread' && !String(j.query_source).includes('agent')) {
        continue;
      }
      const rf = join(bodies, String(j.request_file));
      if (!existsSync(rf)) {
        continue;
      }
      const body = JSON.parse(readFileSync(rf, 'utf8')) as Json;
      const msgs = (body.messages as Json[]) ?? [];
      msgs.forEach((m, i) => {
        out.push(`   [${i}] ${m.role}: ${briefBlocks(m.content)}`);
      });
      const resp = j.response_file ? join(bodies, String(j.response_file)) : '';
      if (resp && existsSync(resp)) {
        const r = JSON.parse(readFileSync(resp, 'utf8')) as Json;
        out.push(`   => response ${r.id ?? ''} stop=${r.stop_reason ?? ''} ${briefBlocks(r.content)}${r.error ? ` error=${JSON.stringify(r.error).slice(0, 160)}` : ''}`);
      }
    }
  } else {
    out.push('(none)');
  }
  // Request files that the index never named (a request cut short).
  if (existsSync(bodies)) {
    const named = existsSync(index) ? readFileSync(index, 'utf8') : '';
    for (const f of readdirSync(bodies).filter((x) => x.endsWith('.request.json') && !named.includes(x))) {
      const body = JSON.parse(readFileSync(join(bodies, f), 'utf8')) as Json;
      const tools = Array.isArray(body.tools) ? (body.tools as unknown[]).length : 0;
      out.push(`-- (not in index) ${f} model=${body.model} tools=${tools} thinking=${JSON.stringify(body.thinking)}`);
      if (tools > 0) {
        ((body.messages as Json[]) ?? []).forEach((m, i) => out.push(`   [${i}] ${m.role}: ${briefBlocks(m.content)}`));
      }
    }
  }
  out.push('');

  // Final transcripts.
  const tdir = join(dir, 'transcripts');
  if (existsSync(tdir)) {
    for (const f of readdirSync(tdir)) {
      out.push(`== transcript at the end: ${f}`);
      readFileSync(join(tdir, f), 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .forEach((l, i) => {
          try {
            const e = JSON.parse(l) as Json;
            const b = entryBrief(e);
            out.push(`${String(i + 1).padStart(4)} ${String(e.timestamp ?? '').slice(11, 23).padEnd(12)} ${entryLine(b)}`);
          } catch {
            out.push(`${String(i + 1).padStart(4)} (unparsed)`);
          }
        });
      out.push('');
    }
  }
  writeFileSync(join(dir, 'report.txt'), `${out.join('\n')}\n`);
}

if (process.argv[1]?.endsWith('render.mts')) {
  const d = process.argv[2];
  if (!d) {
    throw new Error('usage: render.mts <run dir>');
  }
  render(d);
}
