// Proof 25: one table over every case run, from each case's own records.
// Usage (from mvp/claude-code-harness/):
//   node proofs/orphan-tag-summary.mts <out-prefix> runs/25-<case>-<variant>-<tag>.log ...
// Reads, per run: the runner's log (for the case dir), its signal trace
// (<log minus .log>.strace), and in the case dir result.json, keeper.jsonl,
// guard-samples.jsonl, and serve 2's participant-state.json, stop*.json and
// check-*.json. Writes <out-prefix>.json, prints one block per run, then the
// table.
//
// The leftovers (ground truth, not the participant's view): every process of
// the old participant's tree the driver tracked (each held Claude Code and
// every descendant it saw), plus every tagged pid the driver's own 20 ms guard
// samples saw that isn't a Claude Code of serve 2 or 3. A leftover was alive
// at the serve 2 scan if the trace has its exit after the scan (or, with no
// traced exit, the driver saw it gone after the scan).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

type Json = Record<string, unknown>;

function readJsonl(path: string): Json[] {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Json);
}

function readJson(path: string): Json | undefined {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Json) : undefined;
}

interface Sig {
  pid: number;
  t: number;
  kind: 'signal' | 'exit';
  signal?: string;
  from?: number;
  text: string;
}

// strace -tt prints local wall-clock time of day; the date is the case's.
function parseStrace(path: string, localDate: string): Sig[] {
  if (!existsSync(path)) {
    return [];
  }
  const out: Sig[] = [];
  for (const l of readFileSync(path, 'utf8').split('\n')) {
    const m = /^(\d+) (\d\d:\d\d:\d\d\.\d+) (.*)$/.exec(l);
    if (!m) {
      continue;
    }
    const t = new Date(`${localDate}T${(m[2] as string).slice(0, 12)}`).getTime();
    const rest = m[3] as string;
    const s = /^--- (SIG\w+) \{.*?si_pid=(\d+)/.exec(rest);
    if (s) {
      out.push({ pid: Number(m[1]), t, kind: 'signal', signal: s[1], from: Number(s[2]), text: rest });
    } else if (rest.startsWith('+++')) {
      out.push({ pid: Number(m[1]), t, kind: 'exit', text: rest.replace(/\+\+\+/g, '').trim() });
    }
  }
  return out;
}

function localDateOf(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const ms = (iso: unknown): number => new Date(String(iso)).getTime();

const [prefix, ...logs] = process.argv.slice(2);
if (!prefix) {
  process.stderr.write('usage: node proofs/orphan-tag-summary.mts <out-prefix> <log>...\n');
  process.exit(2);
}
const summaries: Json[] = [];
const table: string[] = [];
for (const logPath of logs) {
  const log = readFileSync(logPath, 'utf8');
  const dirMatch = /driver: case .*; dir (.*)$/m.exec(log);
  if (!dirMatch) {
    process.stdout.write(`${logPath}: no case dir\n`);
    continue;
  }
  const caseDir = dirMatch[1] as string;
  const result = readJson(join(caseDir, 'result.json'));
  if (!result) {
    process.stdout.write(`${logPath}: no result.json in ${caseDir}\n`);
    continue;
  }
  const ending = result.ending as Json;
  const pex = ending.participantExit as Json;
  const trace = parseStrace(logPath.replace(/\.log$/, '.strace'), localDateOf(Number(pex.t)));
  const held = readJson(join(caseDir, '1-serve', 'participant-state.json')) as Json;
  const heldPid = Number(held.participantPid);
  // The death: the trace's exit of the old participant, else the driver's.
  const deathTrace = trace.find((s) => s.pid === heldPid && s.kind === 'exit');
  const death = deathTrace ? deathTrace.t : Number(pex.t);
  const s2dir = join(caseDir, '2-serve');
  const s2state = readJson(join(s2dir, 'participant-state.json')) as Json;
  const s2Pid = Number(s2state.participantPid);
  const s3state = readJson(join(caseDir, '3-serve', 'participant-state.json')) as Json;
  const laterClaudes = new Set<number>([...((s2state.convs as Json[]) ?? []), ...((s3state?.convs as Json[]) ?? [])].map((c) => Number(c.claudePid)));
  const who = (pid: number | undefined): string => (pid === heldPid ? 'old participant' : pid === s2Pid ? 'serve-2 participant' : `pid ${pid}`);
  const timings = result.timings as Json[];
  const keeper = readJsonl(join(caseDir, 'keeper.jsonl'));
  const samples = readJsonl(join(caseDir, 'guard-samples.jsonl'));
  const exitOf = (pid: number): number | null => trace.find((s) => s.pid === pid && s.kind === 'exit')?.t ?? null;

  // Ground truth: the old tree's processes.
  const ground = new Map<number, { pid: number; role: string; cmd: string; exitT: number | null; how: string }>();
  for (const t of timings) {
    if (t.role === 'participant') {
      continue;
    }
    const pid = Number(t.pid);
    ground.set(pid, { pid, role: String(t.role), cmd: String(t.cmd).slice(0, 40), exitT: exitOf(pid) ?? (t.goneAt ? ms(t.goneAt) : null), how: exitOf(pid) !== null ? 'trace' : 'driver' });
  }
  for (const sm of samples) {
    for (const [pid] of sm.tagFound as [number, string][]) {
      if (!ground.has(pid) && !laterClaudes.has(pid)) {
        ground.set(pid, { pid, role: 'tagged (seen by the guard samples only)', cmd: '', exitT: exitOf(pid), how: exitOf(pid) !== null ? 'trace' : 'none' });
      }
    }
  }
  const lastExit = Math.max(...[...ground.values()].map((g) => g.exitT ?? 0));

  // Serve 2's stop.
  const tagStop = readJson(join(s2dir, 'stop.json'));
  const finder = tagStop ? 'tag' : 'pidfile';
  let scanT: number | null = null;
  let foundPids: number[] = [];
  let signalled: Json[] = [];
  const stopRounds: Json[] = [];
  if (tagStop) {
    const r1 = (tagStop.rounds as Json[])[0] as Json;
    const scan = r1.scan as Json;
    scanT = ms(scan.at);
    foundPids = (scan.found as Json[]).map((p) => Number(p.pid));
    signalled = (tagStop.rounds as Json[]).flatMap((r) => (r.signalled as Json[]).map((x) => ({ ...x, round: stopRounds.length })));
    for (const r of tagStop.rounds as Json[]) {
      stopRounds.push({ at: (r.scan as Json).at, found: ((r.scan as Json).found as Json[]).map((p) => [p.pid, p.pidFileLive ? 'pid file' : 'no pid file']), waited: (r.waited as Json[]).map((w) => [w.pid, w.msToGone]) });
    }
  } else {
    for (const tag of ['R', 'T']) {
      const st = readJson(join(s2dir, `stop-${tag}.json`));
      if (!st) {
        continue;
      }
      scanT = Math.min(scanT ?? Number.POSITIVE_INFINITY, ms(st.startedAt));
      foundPids.push(...(st.pidFiles as Json[]).filter((p) => p.live).map((p) => Number(p.pid)));
      signalled.push(...(st.signalled as Json[]));
      stopRounds.push({ tag, at: st.startedAt, pidFiles: (st.pidFiles as Json[]).map((p) => [p.pid, p.live]), outcome: st.outcome });
    }
  }
  const aliveAtScan = scanT === null ? [] : [...ground.values()].filter((g) => g.exitT === null || g.exitT > (scanT as number));
  const missedAtScan = aliveAtScan.filter((g) => !foundPids.includes(g.pid));
  // A second SIGINT: the trace shows two or more SIGINTs delivered to one
  // held Claude Code after the death.
  const heldClaudes = (held.convs as Json[]).map((c) => ({ tag: String(c.tag), pid: Number(c.claudePid) }));
  const sigintsTo = (pid: number): string[] => {
    const tm = timings.find((x) => Number(x.pid) === pid);
    const ids = new Set<number>([pid, ...((tm?.tids as number[] | undefined) ?? [])]);
    return trace.filter((s) => ids.has(s.pid) && s.kind === 'signal' && s.signal !== 'SIGPIPE' && s.t >= death - 50).map((s) => `${s.signal} from ${who(s.from)} +${s.t - death}`);
  };

  const out: Json = {
    log: logPath,
    caseDir,
    case: ending.case,
    variant: ending.variant,
    layer1: ending.layer1,
    how: ending.how,
    finder,
    now: ending.now,
    deathFrom: deathTrace ? 'trace' : 'driver',
    goMsAfterDeath: ending.goSentAt ? ms(ending.goSentAt) - death : null,
    scanMsAfterDeath: scanT === null ? null : scanT - death,
    lastLeftoverExitMsAfterDeath: lastExit - death,
    leftovers: [...ground.values()].map((g) => ({ ...g, exitMsAfterDeath: g.exitT === null ? null : g.exitT - death, aliveAtScan: aliveAtScan.includes(g), found: foundPids.includes(g.pid) })),
    aliveAtScan: aliveAtScan.map((g) => g.pid),
    missedAtScan: missedAtScan.map((g) => [g.pid, g.role]),
    stopRounds,
    signalled,
    secondSigint: ending.secondSigint ?? null,
    guard: ending.guard,
    convs: {} as Json,
  };
  for (const hc of heldClaudes) {
    const tag = hc.tag;
    const sid = String(((held.convs as Json[]).find((c) => c.tag === tag) as Json).sessionId);
    const s2 = (result.serve2 as Json[]).find((r) => r.tag === tag) as Json;
    const s3 = (result.serve3 as Json[]).find((r) => r.tag === tag) as Json;
    const check2 = readJson(join(s2dir, `check-${tag}.json`)) as Json;
    const first = check2.first as Json;
    const checkT = ms(first.startedAt);
    const argv = readJson(join(String(((held.convs as Json[]).find((c) => c.tag === tag) as Json).runDir), 'claude', '1', 'argv.json'));
    const root = argv ? String(argv.configDir) : null;
    const sizes = keeper.filter((k) => k.event === 'size' && String(k.file).endsWith(`/${sid}.jsonl`) && root !== null && String(k.file).startsWith(`${root}/projects/`));
    const writesAfterDeath = sizes.filter((k) => ms(k.ts) > death);
    const lastWrite = writesAfterDeath.at(-1);
    const pfGone = keeper.find((k) => k.event === 'pidfile-gone' && Number(k.pid) === hc.pid);
    const branchCount = (r: Json): number => Object.values(r.branches as Record<string, unknown[]>).reduce((n, v) => n + v.length, 0);
    const invCount = (r: Json): number => Object.values(r.invented as Record<string, unknown[]>).reduce((n, v) => n + v.length, 0);
    const heldRows = (((s2.windows as Json[]).find((w) => w.name === 'held turn') as Json).rows as Json[]).map((r) => `${String(r.what).slice(0, 60)}${r.textChars ? ` chars=${String(r.textChars)}` : ''} carried=${String(r.carried)}`);
    const s3held = (((s3.windows as Json[]).find((w) => w.name === 'held turn') as Json).rows as Json[]).filter((r) => r.carried === false).length;
    const s3s2 = (((s3.windows as Json[]).find((w) => w.name === 'serve 2 turn') as Json).rows as Json[]).filter((r) => r.carried === false).length;
    const c: Json = {
      claudePid: hc.pid,
      signals: sigintsTo(hc.pid),
      pidFileGoneMsAfterDeath: pfGone ? ms(pfGone.ts) - death : null,
      exitMsAfterDeath: ground.get(hc.pid)?.exitT ? (ground.get(hc.pid)?.exitT as number) - death : null,
      lastOrphanWriteMsAfterDeath: lastWrite ? ms(lastWrite.ts) - death : null,
      checkMsAfterDeath: checkT - death,
      checkAfterLastLeftoverExitMs: checkT - lastExit,
      orphanWroteAfterCheck: lastWrite ? ms(lastWrite.ts) > checkT : false,
      tagAtCheckStart: first.tagAtStart,
      tagAtCheckEnd: first.tagAtEnd,
      checkAdded: (s2.check as Json).added,
      heldTurn: heldRows,
      serve2: { prior: s2.priorEntries, notCarried: (s2.priorNotCarried as unknown[]).length, branches: branchCount(s2), invented: invCount(s2), answer: String(s2.answer).slice(0, 120) },
      serve3: { prior: s3.priorEntries, notCarried: (s3.priorNotCarried as unknown[]).length, heldNotCarried: s3held, serve2TurnNotCarried: s3s2, branches: branchCount(s3), invented: invCount(s3), answer: String(s3.answer).slice(0, 120) },
    };
    (out.convs as Json)[tag] = c;
    const found = missedAtScan.length === 0 ? 'yes' : `NO (missed ${missedAtScan.map((g) => g.pid).join(',')})`;
    const waited = (c.checkAfterLastLeftoverExitMs as number) > 0 && !c.orphanWroteAfterCheck ? 'yes' : 'NO';
    const noFork = branchCount(s2) === 0 && branchCount(s3) === 0 && invCount(s2) === 0 && invCount(s3) === 0 ? 'yes' : 'NO';
    const complete = (s2.priorNotCarried as unknown[]).length === 0 && (s3.priorNotCarried as unknown[]).length === 0 ? 'yes' : 'NO';
    table.push(
      [
        basename(logPath).replace(/^25-/, '').replace(/\.log$/, ''),
        tag,
        finder,
        `alive@scan ${aliveAtScan.length}`,
        `found ${found}`,
        `waited ${waited}`,
        `no fork ${noFork}`,
        `complete ${complete}`,
        `scan +${String(out.scanMsAfterDeath)}`,
        `pidfile gone +${String(c.pidFileGoneMsAfterDeath)}`,
        `last write +${String(c.lastOrphanWriteMsAfterDeath)}`,
        `last exit +${String(out.lastLeftoverExitMsAfterDeath)}`,
        `check +${String(c.checkMsAfterDeath)}`,
        `signals [${(c.signals as string[]).join('; ')}]`,
      ].join(' | '),
    );
  }
  summaries.push(out);
  process.stdout.write(`\n=== ${basename(logPath)}  (${String(ending.case)} ${String(ending.variant)}; layer 1 ${String(ending.layer1)}; ${String(ending.how)}; stop by ${finder}; now ${String(ending.now)})\n    ${caseDir}\n`);
  process.stdout.write(`    GO +${String(out.goMsAfterDeath)} ms; scan +${String(out.scanMsAfterDeath)} ms; last leftover exit +${String(out.lastLeftoverExitMsAfterDeath)} ms (death from ${String(out.deathFrom)})\n`);
  process.stdout.write(`    leftovers: ${JSON.stringify((out.leftovers as Json[]).map((g) => [g.pid, String(g.role).replace('-descendant', '-desc'), String(g.cmd).slice(0, 18), g.exitMsAfterDeath, g.aliveAtScan ? 'alive@scan' : '-', g.found ? 'found' : '-']))}\n`);
  process.stdout.write(`    stop rounds: ${JSON.stringify(stopRounds)}\n    signalled: ${JSON.stringify(signalled)}\n`);
  if (out.secondSigint) {
    process.stdout.write(`    driver's second SIGINT: ${JSON.stringify(out.secondSigint)}\n`);
  }
  process.stdout.write(`    guard: ${JSON.stringify(out.guard)}\n`);
  for (const [tag, v] of Object.entries(out.convs as Json)) {
    const x = v as Json;
    process.stdout.write(`  ${tag} claude ${String(x.claudePid)}: signals ${JSON.stringify(x.signals)}; pid file gone +${String(x.pidFileGoneMsAfterDeath)}; last write +${String(x.lastOrphanWriteMsAfterDeath)}; exit +${String(x.exitMsAfterDeath)}; check +${String(x.checkMsAfterDeath)} (after last leftover exit by ${String(x.checkAfterLastLeftoverExitMs)} ms; tagged at check start ${JSON.stringify(x.tagAtCheckStart)} end ${JSON.stringify(x.tagAtCheckEnd)}); check added ${JSON.stringify(x.checkAdded)}; wrote after check ${String(x.orphanWroteAfterCheck)}\n`);
    process.stdout.write(`     held turn as serve 2 saw it: ${JSON.stringify(x.heldTurn)}\n     serve 2: ${JSON.stringify(x.serve2)}\n     serve 3: ${JSON.stringify(x.serve3)}\n`);
  }
}
process.stdout.write(`\n=== table\n${table.join('\n')}\n`);
writeFileSync(`${prefix}.json`, `${JSON.stringify(summaries, null, 2)}\n`);
writeFileSync(`${prefix}-table.txt`, `${table.join('\n')}\n`);
