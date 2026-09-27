// Proof 26's trace reader. Reads an
// `strace -f -y -ttt -s 0 -e trace=%file,%process,bind,connect` output (paths
// print in full at -s 0; -y resolves fds to paths; no file contents are
// traced) and lists every access to a path outside the run's own
// directories: the real home, /run/user/<uid>, /tmp and /dev/shm, grouped
// by who made it.
//
// Who: each thread or child is walked up the clone tree to its nearest
// execve. Claude Code itself (the SDK's bundled `claude`) is "claude"; its
// children are named by their executable (bash, git, rg, node for an MCP
// server, ...). The proof's own node and the capture wrapper are named too.
// Read and Write run inside the claude process, so the proof keeps them on
// paths of their own (the probe dir) and the reader lists those apart.
//
//   node proofs/home-trace.mts <file.strace> <phases.json> [home=<dir>] [own-dir ...]
//
// <phases.json> is the proof's {name, at (epoch seconds)}[] list; each access
// is labelled with the last phase started before it. home=<dir>: the run's
// private HOME, listed as its own bucket (what landed there instead of the
// real home). own-dir: directories that belong to the run (config dir,
// working dir, fixtures); accesses under them are counted, not listed. Paths
// holding `/p26-probe/` are the Read and Write probes, listed apart.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const [file, phasesFile, ...rest] = process.argv.slice(2);
const privateHome = rest.find((a) => a.startsWith('home='))?.slice(5);
const ownDirs = rest.filter((a) => !a.startsWith('home='));
if (!file || !phasesFile) {
  process.stderr.write('usage: node proofs/home-trace.mts <file.strace> <phases.json> [own-dir ...]\n');
  process.exit(2);
}
const HOME = homedir();
const UID = process.getuid?.() ?? 1000;
const phases = (JSON.parse(readFileSync(phasesFile, 'utf8')) as { name: string; at: number }[]).sort((a, b) => a.at - b.at);
function phaseAt(t: number): string {
  let p = '(before)';
  for (const x of phases) if (x.at <= t) p = x.name;
  return p;
}

const lines = readFileSync(file, 'utf8').split('\n');
const parent = new Map<number, number>();
const exe = new Map<number, string>();
const cloneRe = /^(\d+) [\d.]+ (?:<\.\.\. )?(?:clone3?|fork|vfork)(?:\(| resumed>).*= (\d+)/;
const execRe = /^(\d+) [\d.]+ execve\("([^"]+)"/;
for (const l of lines) {
  const c = cloneRe.exec(l);
  if (c) parent.set(Number(c[2]), Number(c[1]));
  const e = execRe.exec(l);
  if (e && !/= -1 /.test(l)) exe.set(Number(e[1]), e[2] as string);
}
function owner(tid: number): number {
  let t: number | undefined = tid;
  for (let i = 0; t !== undefined && i < 1000; i += 1) {
    if (exe.has(t)) return t;
    t = parent.get(t);
  }
  return tid;
}
function ancestry(pid: number): string {
  const chain: string[] = [];
  let t: number | undefined = pid;
  for (let i = 0; t !== undefined && i < 1000; i += 1) {
    const x = exe.get(t);
    if (x) chain.push(who(x));
    t = parent.get(t);
  }
  return chain.join(' < ');
}
function who(path: string): string {
  if (path.endsWith('/claude-agent-sdk-linux-x64/claude')) return 'claude';
  if (path.endsWith('/bin/claude-capture')) return 'capture-wrapper(sh)';
  return path.split('/').pop() ?? path;
}
// Name a process by its own executable, and by the nearest claude above it
// ("claude > bash") so Claude Code's children are told apart from the proof's.
function label(pid: number): string {
  const o = owner(pid);
  const self = who(exe.get(o) ?? '?');
  if (self === 'claude') return 'claude';
  const chain = ancestry(o).split(' < ');
  const ci = chain.indexOf('claude');
  if (ci > 0) return `claude > ${chain.slice(0, ci).reverse().join(' > ')}`;
  if (self === 'node' && chain.includes('capture-wrapper(sh)')) return 'capture-wrapper(node)';
  return self;
}

// Paths of interest, each put in a bucket.
function bucket(p: string): string | undefined {
  if (p.includes('/p26-probe/') || p.endsWith('/p26-probe')) return 'probe (Read/Write tools)';
  if (privateHome && (p === privateHome || p.startsWith(`${privateHome}/`))) return 'private HOME';
  for (const d of ownDirs) if (p === d || p.startsWith(`${d}/`)) return undefined;
  if (p.startsWith('/tmp/claude-resume-')) return undefined;
  if (p === `${HOME}/.claude` || p.startsWith(`${HOME}/.claude/`)) return '~/.claude';
  if (p.startsWith(`${HOME}/.claude.json`)) return '~/.claude.json';
  if (p.startsWith(`${HOME}/.local/state/tower-claude-code-harness`)) return undefined;
  if (p.startsWith(`${HOME}/repos/`)) return undefined;
  if (p.startsWith(`${HOME}/.cache/`)) return '~/.cache';
  if (p.startsWith(`${HOME}/.local/`)) return '~/.local';
  if (p.startsWith(`${HOME}/.config/`)) return '~/.config';
  if (p === HOME || p.startsWith(`${HOME}/`)) return '~ (other)';
  if (p.startsWith(`/run/user/${UID}`)) return `/run/user/${UID}`;
  if (p.startsWith('/tmp/') || p === '/tmp') return '/tmp';
  if (p.startsWith('/dev/shm/')) return '/dev/shm';
  return undefined;
}

// Pull the path(s) one syscall line names: quoted absolute paths, fd-relative
// names joined onto the fd's path (-y prints `N</dir>`), and sun_path.
function pathsOf(l: string): string[] {
  const out: string[] = [];
  const at = /^\d+ [\d.]+ (?:<\.\.\. )?(\w+)\((-?\d+|AT_FDCWD)(?:<([^>]*)>)?, "([^"]*)"/.exec(l);
  if (at) {
    const [, , , dir, name] = at;
    if (name?.startsWith('/')) out.push(name);
    else if (dir && name !== undefined) out.push(name ? `${dir}/${name}` : dir);
  }
  for (const m of l.matchAll(/"(\/[^"]*)"/g)) if (!out.includes(m[1] as string)) out.push(m[1] as string);
  for (const m of l.matchAll(/sun_path="([^"]*)"/g)) if (!out.includes(m[1] as string)) out.push(m[1] as string);
  return out;
}

type Row = { bucket: string; who: string; phase: string; call: string; path: string; flags: string; result: string };
const rows = new Map<string, { row: Row; n: number }>();
const own = new Map<string, number>();
// Collapse numbers that change per run (pids, session ids, timestamps) so
// the same access in two runs reads as one line.
function norm(p: string): string {
  return p
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/\/\d{3,}(?=[./]|$)/g, '/<n>')
    .replace(/-\d{6,}/g, '-<n>');
}
for (const l of lines) {
  const m = /^(\d+) ([\d.]+) (?:<\.\.\. )?(\w+)/.exec(l);
  if (!m) continue;
  const call = m[3] as string;
  if (call === 'execve' || call === 'clone' || call === 'clone3' || call === 'exit_group' || call === 'wait4') continue;
  const tid = Number(m[1]);
  for (const p of pathsOf(l)) {
    const b = bucket(p);
    if (!b) {
      if (ownDirs.some((d) => p.startsWith(d)) || p.startsWith('/tmp/claude-resume-')) own.set(label(tid), (own.get(label(tid)) ?? 0) + 1);
      continue;
    }
    const flags = (/O_[A-Z_|]+/.exec(l)?.[0] ?? /AT_[A-Z_|]+/.exec(l)?.[0] ?? '').replace(/O_CLOEXEC\|?|\|?O_CLOEXEC/g, '');
    const result = /= (-?\d+(?:<[^>]*>)?(?: [A-Z]+)?)/.exec(l)?.[1]?.replace(/<[^>]*>/, '') ?? (l.includes('<unfinished') ? 'unfinished' : '?');
    const row: Row = { bucket: b, who: label(tid), phase: phaseAt(Number(m[2])), call, path: norm(p), flags, result: /^\d+$/.test(result) ? 'ok' : result };
    const key = JSON.stringify(row);
    const e = rows.get(key);
    if (e) e.n += 1;
    else rows.set(key, { row, n: 1 });
  }
}

const byBucket = new Map<string, { row: Row; n: number }[]>();
for (const e of rows.values()) {
  if (!byBucket.has(e.row.bucket)) byBucket.set(e.row.bucket, []);
  byBucket.get(e.row.bucket)?.push(e);
}
const out: string[] = [`trace ${file}`, `real home ${HOME}; private HOME ${privateHome ?? '(none)'}; own dirs (counted, not listed): ${JSON.stringify(ownDirs)}`, ''];
const MUTATING = /^(unlink|unlinkat|rename|renameat2?|rmdir|mkdir|mkdirat|symlink|symlinkat|link|linkat|chmod|fchmodat|truncate|utimensat|bind)$/;
for (const [b, es] of [...byBucket].sort()) {
  out.push(`== ${b}`);
  es.sort((x, y) => (x.row.who + x.row.path + x.row.call).localeCompare(y.row.who + y.row.path + y.row.call));
  for (const { row, n } of es) {
    const writes = MUTATING.test(row.call) || /O_CREAT|O_WRONLY|O_RDWR|O_TRUNC/.test(row.flags);
    out.push(`  ${writes ? 'W' : ' '} [${row.who}] {${row.phase}} ${row.call} ${row.path} ${row.flags} -> ${row.result} x${n}`);
  }
  out.push('');
}
out.push('== own dirs (accesses counted by process)');
for (const [w, n] of own) out.push(`  [${w}] ${n}`);
process.stdout.write(`${out.join('\n')}\n`);
