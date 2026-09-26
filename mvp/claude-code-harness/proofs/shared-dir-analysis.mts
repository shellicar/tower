// Proof 17b: what two Claude Codes did to one session's files.
//
//   node proofs/shared-dir-analysis.mts <case dir> <strace file>
//
// Reads the strace of a whole case (strace -f -tt -y, any -s) and the case's
// records, and writes <case dir>/shared-dir-analysis.json plus a text summary
// on stdout:
//   - every Claude Code in the case: which serve and conversation, its pid,
//     the CLAUDE_CONFIG_DIR it was actually given (claude/<n>/argv.json)
//   - per session file (projects/.../<session>.jsonl and sessions/<pid>.json)
//     touched by any Claude Code: who opened it with which flags, who wrote
//     how many bytes, and any pwrite/ftruncate/rename/unlink/flock/fcntl lock
//   - per transcript: writes aligned to the file's lines by length (so each
//     line gets its writer), whether every write was whole lines, branches
//     (a parentUuid with two children) and tool_use ids with two results.
// Reads only transcripts, pid files and the proof's own records.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

type Json = Record<string, unknown>;

const [caseDir, straceFile] = process.argv.slice(2);
if (!caseDir || !straceFile) {
  process.stderr.write('usage: shared-dir-analysis.mts <case dir> <strace file>\n');
  process.exit(2);
}

function readJsonl(path: string): Json[] {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Json];
      } catch {
        return [];
      }
    });
}

// Who is who: every serve's Claude Codes, from the participant state and
// each run's argv.json (the configDir the binary was actually given).
interface Claude {
  label: string;
  serve: string;
  tag: string;
  pid: number;
  configDirGiven: string;
  harnessConfigDir: string;
  resume: string | null;
}
const claudes: Claude[] = [];
const participants = new Map<number, string>();
for (const serve of readdirSync(caseDir, { withFileTypes: true }).filter((d) => d.isDirectory() && /^\d-/.test(d.name))) {
  const statePath = join(caseDir, serve.name, 'participant-state.json');
  if (!existsSync(statePath)) {
    continue;
  }
  const st = JSON.parse(readFileSync(statePath, 'utf8')) as { participantPid: number; convs: Json[] };
  participants.set(st.participantPid, `participant ${serve.name}`);
  for (const c of st.convs) {
    const capture = join(String(c.runDir), 'claude');
    for (const n of existsSync(capture) ? readdirSync(capture) : []) {
      const argv = JSON.parse(readFileSync(join(capture, n, 'argv.json'), 'utf8')) as Json;
      const resumeArg = (argv.argv as string[]).find((a) => a.startsWith('--resume'));
      claudes.push({
        label: `${serve.name}/${String(c.tag)}`,
        serve: serve.name,
        tag: String(c.tag),
        pid: Number(argv.pid),
        configDirGiven: String(argv.configDir),
        harnessConfigDir: String(c.configDir),
        resume: resumeArg ?? null,
      });
    }
  }
}
const byPid = new Map(claudes.map((c) => [c.pid, c]));

// strace: tid -> process (tgid) from clone/fork, and the calls on session files.
const tgid = new Map<number, number>();
const pending = new Map<number, { call: string; args: string; ts: string }>();
interface Call {
  ts: string;
  tid: number;
  pid: number;
  call: string;
  args: string;
  ret: string;
}
const calls: Call[] = [];
const lineRe = /^(\d+) (\d\d:\d\d:\d\d\.\d+) (.*)$/;
const sessionFile = /(\/projects\/[^<>"]*\.jsonl|\/sessions\/\d+\.json)(?=[>"])/;
const text = readFileSync(straceFile, 'utf8');
let first: number | undefined;
for (const raw of text.split('\n')) {
  const m = lineRe.exec(raw);
  if (!m) {
    continue;
  }
  const tid = Number(m[1]);
  first ??= tid;
  if (!tgid.has(tid)) {
    tgid.set(tid, tid);
  }
  const ts = m[2] as string;
  let rest = m[3] as string;
  let call: string;
  let args: string;
  let ret: string;
  const unfinished = /^(\w+)\((.*) <unfinished \.\.\.>$/.exec(rest);
  if (unfinished) {
    pending.set(tid, { call: unfinished[1] as string, args: unfinished[2] as string, ts });
    continue;
  }
  const resumed = /^<\.\.\. (\w+) resumed>(.*)$/.exec(rest);
  if (resumed) {
    const p = pending.get(tid);
    pending.delete(tid);
    rest = `${resumed[1]}(${p?.args ?? ''}${resumed[2]}`;
  }
  const full = /^(\w+)\((.*)\) += (.*)$/.exec(rest);
  if (!full) {
    continue;
  }
  call = full[1] as string;
  args = full[2] as string;
  ret = full[3] as string;
  if (/^(clone3?|fork|vfork)$/.test(call)) {
    const child = Number.parseInt(ret, 10);
    if (child > 0) {
      tgid.set(child, /CLONE_THREAD/.test(args) ? (tgid.get(tid) as number) : child);
    }
    continue;
  }
  if (!sessionFile.test(args) && !sessionFile.test(ret)) {
    continue;
  }
  calls.push({ ts, tid, pid: tgid.get(tid) as number, call, args, ret });
}

function who(pid: number): string {
  const c = byPid.get(pid);
  if (c) {
    return `claude ${c.label} (${pid})`;
  }
  if (pid === first) {
    return `driver (${pid})`;
  }
  return participants.has(pid) ? `${participants.get(pid)} (${pid})` : `other (${pid})`;
}

function pathOf(c: Call): string | undefined {
  const fd = /^\d+<([^>]*)>/.exec(c.args);
  if (fd && sessionFile.test(`${fd[1]}>`)) {
    return fd[1];
  }
  const s = /"([^"]*)"/.exec(c.args);
  if (s && sessionFile.test(`${s[1]}"`)) {
    return s[1];
  }
  const r = /^\d+<([^>]*)>/.exec(c.ret);
  return r?.[1];
}

interface FileReport {
  path: string;
  opensForWrite: Record<string, string[]>;
  readers: string[];
  writes: Record<string, { writes: number; bytes: number }>;
  other: string[];
  lines?: number;
  alignment?: { ok: boolean; wholeLinesEveryWrite: boolean; note: string; writerOfLine: string[] };
  branches?: { parent: string; children: string[] }[];
  toolResults?: { toolUseId: string; results: string[] }[];
}
const files = new Map<string, FileReport>();
const writeSeq = new Map<string, { who: string; len: number; ts: string }[]>();
for (const c of calls) {
  const path = pathOf(c);
  // The harness's copies of the config dir into run directories are not
  // Claude Code's files.
  if (!path || path.includes('/claude-code-harness/runs/')) {
    continue;
  }
  const f = files.get(path) ?? { path, opensForWrite: {}, readers: [], writes: {}, other: [] };
  files.set(path, f);
  const w = who(c.pid);
  if (c.call === 'openat') {
    const flags = /", ([A-Z_|]+)/.exec(c.args)?.[1] ?? '?';
    if (/O_WRONLY|O_RDWR/.test(flags)) {
      f.opensForWrite[w] = [...new Set([...(f.opensForWrite[w] ?? []), flags])];
    } else if (!f.readers.includes(w)) {
      f.readers.push(w);
    }
  } else if (/^(write|writev|pwrite64|pwritev2?)$/.test(c.call)) {
    const n = Number.parseInt(c.ret, 10);
    const slot = f.writes[w] ?? { writes: 0, bytes: 0 };
    slot.writes += 1;
    slot.bytes += Number.isFinite(n) ? n : 0;
    f.writes[w] = slot;
    if (c.call !== 'write') {
      f.other.push(`${c.ts} ${w} ${c.call}(${c.args.replace(/"[^"]*"(\.\.\.)?/, '"..."').slice(0, 200)}) = ${c.ret}`);
    }
    writeSeq.set(path, [...(writeSeq.get(path) ?? []), { who: w, len: n, ts: c.ts }]);
  } else {
    f.other.push(`${c.ts} ${w} ${c.call}(${c.args.replace(/"[^"]*"(\.\.\.)?/g, (s) => (s.length > 200 ? '"..."' : s)).slice(0, 300)}) = ${c.ret}`);
  }
}

// Transcripts: align writes to lines by byte length; graph.
for (const f of files.values()) {
  if (!f.path.endsWith('.jsonl') || !existsSync(f.path)) {
    continue;
  }
  const raw = readFileSync(f.path, 'utf8');
  const lines = raw.split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  f.lines = lines.length;
  const seq = writeSeq.get(f.path) ?? [];
  const writerOfLine: string[] = [];
  let li = 0;
  let ok = true;
  let whole = true;
  let note = 'every write ends on a line boundary, in file order';
  for (const w of seq) {
    let sum = 0;
    const start = li;
    while (li < lines.length && sum < w.len) {
      sum += Buffer.byteLength(lines[li] as string) + 1;
      li += 1;
    }
    if (sum !== w.len) {
      ok = false;
      whole = false;
      note = `write of ${w.len} bytes by ${w.who} at ${w.ts} does not end on a line boundary (lines ${start + 1}..${li}, ${sum} bytes)`;
      break;
    }
    for (let i = start; i < li; i += 1) {
      writerOfLine[i] = `${w.who}${li - start > 1 ? ` (one write of ${li - start} lines)` : ''}`;
    }
  }
  if (ok && li !== lines.length) {
    ok = false;
    note = `${lines.length - li} line(s) at the end not accounted for by traced writes`;
  }
  f.alignment = { ok, wholeLinesEveryWrite: whole, note, writerOfLine };
  const entries = lines.map((l) => {
    try {
      return JSON.parse(l) as Json;
    } catch {
      return { unparseable: l.slice(0, 80) } as Json;
    }
  });
  const children = new Map<string, string[]>();
  const results = new Map<string, string[]>();
  entries.forEach((e, i) => {
    const writer = writerOfLine[i] ?? '?';
    if (typeof e.parentUuid === 'string' && typeof e.uuid === 'string' && (e.type === 'user' || e.type === 'assistant')) {
      children.set(e.parentUuid, [...(children.get(e.parentUuid) ?? []), `line ${i + 1} ${String(e.type)} ${e.uuid} by ${writer}`]);
    }
    const content = (e.message as Json | undefined)?.content;
    if (Array.isArray(content)) {
      for (const b of content as Json[]) {
        if (b.type === 'tool_result') {
          const flat = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
          results.set(String(b.tool_use_id), [...(results.get(String(b.tool_use_id)) ?? []), `line ${i + 1} by ${writer}: ${flat.slice(0, 70)}`]);
        }
      }
    }
  });
  f.branches = [...children.entries()].filter(([, v]) => v.length > 1).map(([parent, c]) => ({ parent, children: c }));
  f.toolResults = [...results.entries()].map(([toolUseId, r]) => ({ toolUseId, results: r }));
}

const out = { caseDir, straceFile, claudes, files: [...files.values()] };
writeFileSync(join(caseDir, 'shared-dir-analysis.json'), `${JSON.stringify(out, null, 2)}\n`);

const say = (s: string): void => {
  process.stdout.write(`${s}\n`);
};
say(`case ${basename(caseDir)}`);
for (const c of claudes) {
  say(`  ${c.label}: pid ${c.pid}, ${c.resume ?? 'fresh'}, CLAUDE_CONFIG_DIR given ${c.configDirGiven}`);
}
for (const f of files.values()) {
  say(`\n${f.path}`);
  for (const [w, fl] of Object.entries(f.opensForWrite)) {
    say(`  open for write: ${w}: ${fl.join(' ; ')}`);
  }
  for (const [w, s] of Object.entries(f.writes)) {
    say(`  wrote: ${w}: ${s.writes} writes, ${s.bytes} bytes`);
  }
  if (f.readers.length) {
    say(`  read by: ${f.readers.join(', ')}`);
  }
  for (const o of f.other) {
    say(`  ${o}`);
  }
  if (f.alignment) {
    say(`  ${f.lines} lines; alignment ${f.alignment.ok ? 'ok' : 'FAILED'}: ${f.alignment.note}`);
    const runs: string[] = [];
    let prev = '';
    let from = 0;
    f.alignment.writerOfLine.forEach((w, i) => {
      if (w !== prev) {
        if (prev) {
          runs.push(`${from + 1}-${i} ${prev}`);
        }
        prev = w;
        from = i;
      }
    });
    if (prev) {
      runs.push(`${from + 1}-${f.alignment.writerOfLine.length} ${prev}`);
    }
    say(`  lines by writer: ${runs.join(' | ')}`);
    for (const b of f.branches ?? []) {
      say(`  BRANCH at ${b.parent}: ${b.children.join(' ; ')}`);
    }
    for (const t of (f.toolResults ?? []).filter((x) => x.results.length > 1)) {
      say(`  TWO RESULTS for ${t.toolUseId}: ${t.results.join(' ; ')}`);
    }
  }
}
