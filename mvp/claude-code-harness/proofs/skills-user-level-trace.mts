// Proof 22's trace reader. Reads an `strace -f -s 0 -e trace=%file,%process`
// output (paths print in full at -s 0; no file contents are traced) and lists
// every access to a path in the real home's ~/.claude or ~/.claude.json,
// attributed to the process that made it: each thread or child is walked up
// the clone tree to the nearest execve, and a claude execve is labelled with
// its --resume argument when it has one (the argv is not printed at -s 0,
// so the resume is told apart by CLAUDE_CONFIG_DIR paths the process
// touched: an agent dir or a /tmp/claude-resume-* dir).
//
//   node proofs/skills-user-level-trace.mts <file.strace>

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const file = process.argv[2];
if (!file) {
  process.stderr.write('usage: node proofs/skills-user-level-trace.mts <file.strace>\n');
  process.exit(2);
}
const HOME = homedir();
const lines = readFileSync(file, 'utf8').split('\n');
const parent = new Map<number, number>();
const exe = new Map<number, string>();
// Pending clone calls per tid, for "<... clone3 resumed>) = N" lines.
const cloneRe = /^(\d+) (?:<\.\.\. )?(?:clone3?|fork|vfork)(?:\(| resumed>).*= (\d+)$/;
const execRe = /^(\d+) execve\("([^"]+)"/;
for (const l of lines) {
  const c = cloneRe.exec(l);
  if (c) parent.set(Number(c[2]), Number(c[1]));
  const e = execRe.exec(l);
  if (e && !/ENOENT/.test(l)) exe.set(Number(e[1]), e[2] as string);
}
function owner(tid: number): number {
  let t: number | undefined = tid;
  for (let i = 0; t !== undefined && i < 1000; i += 1) {
    if (exe.has(t)) return t;
    t = parent.get(t);
  }
  return tid;
}
// Which config dir each claude process used, from the paths it touched.
const cfg = new Map<number, Set<string>>();
const cfgRe = /"(\/tmp\/claude-resume-[0-9a-f-]+|[^"]*\/tower-claude-code-harness\/config-dirs\/[^/"]+)/;
for (const l of lines) {
  const m = cfgRe.exec(l);
  if (!m) continue;
  const o = owner(Number(l.split(' ')[0]));
  if (!(exe.get(o) ?? '').endsWith('/claude')) continue;
  if (!cfg.has(o)) cfg.set(o, new Set());
  cfg.get(o)?.add(m[1] as string);
}
const home = new RegExp(`"(${HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.claude(?:\\.json|/[^"]*)?)"`);
const counts = new Map<string, number>();
for (const l of lines) {
  const m = home.exec(l);
  if (!m) continue;
  const tid = Number(l.split(' ')[0]);
  const o = owner(tid);
  const call = /^\d+ (?:<\.\.\. )?(\w+)/.exec(l)?.[1] ?? '?';
  const flags = /O_[A-Z_|]+/.exec(l)?.[0] ?? '';
  const result = /= (-?\d+(?: [A-Z]+)?)/.exec(l)?.[1] ?? (l.includes('<unfinished') ? 'unfinished' : '?');
  const who = `${exe.get(o) ?? '?'}${cfg.has(o) ? ` [${[...(cfg.get(o) ?? [])].map((d) => d.split('/').pop()).join(', ')}]` : ''} pid ${o}`;
  const key = `${who}\n    ${call} ${m[1]} ${flags} -> ${result}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
const byWho = new Map<string, string[]>();
for (const [k, n] of counts) {
  const [who, what] = k.split('\n');
  if (!byWho.has(who as string)) byWho.set(who as string, []);
  byWho.get(who as string)?.push(`${what} x${n}`);
}
process.stdout.write(`trace ${file}\naccesses under ${HOME}/.claude and ${HOME}/.claude.json, by process:\n`);
for (const [who, whats] of byWho) {
  process.stdout.write(`  ${who}\n${whats.sort().join('\n')}\n`);
}
