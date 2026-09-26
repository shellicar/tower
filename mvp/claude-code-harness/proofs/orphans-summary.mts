// Proof 21: one table over every case run, from each case's own records.
// Usage (from mvp/claude-code-harness/):
//   node proofs/orphans-summary.mts runs/21-<case>-<variant>-<tag>.log ...
// Reads, per run: the runner's log (for the case dir), its signal trace
// (<log minus .log>.strace), and in the case dir result.json, keeper.jsonl,
// each serve's participant-state.json, stop-*.json and check-*.json.
// Writes runs/21-summary.json and prints one block per run.

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

const rel = (t: number | null | undefined, zero: number): number | null => (t === null || t === undefined || Number.isNaN(t) ? null : t - zero);

const summaries: Json[] = [];
for (const logPath of process.argv.slice(2)) {
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
  const death = (ending.participantExit as Json).t as number;
  const trace = parseStrace(logPath.replace(/\.log$/, '.strace'), localDateOf(death));
  const keeper = readJsonl(join(caseDir, 'keeper.jsonl'));
  const held = readJson(join(caseDir, '1-serve', 'participant-state.json')) as Json;
  const heldPid = Number(held.participantPid);
  const serve2State = readJson(join(caseDir, '2-serve', 'participant-state.json')) as Json;
  const serve2Pid = Number(serve2State.participantPid);
  const who = (pid: number | undefined, self: number): string => (pid === heldPid ? 'participant' : pid === serve2Pid ? 'serve-2 participant' : pid === self ? 'self' : `pid ${pid}`);
  const timings = result.timings as Json[];
  const tool = result.tool as Json;
  const serve2 = result.serve2 as Json[];
  const serve3 = result.serve3 as Json[];
  const out: Json = {
    log: logPath,
    caseDir,
    case: ending.case,
    variant: ending.variant,
    layer1: ending.layer1,
    how: ending.how,
    participantExit: ending.participantExit,
    tool: { started: tool.started, finished: tool.finished },
    convs: {} as Json,
  };
  for (const c of held.convs as Json[]) {
    const tag = String(c.tag);
    const pid = Number(c.claudePid);
    const sid = String(c.sessionId);
    const tm = timings.find((x) => x.pid === pid);
    const sigs = trace.filter((s) => s.pid === pid && s.t >= death - 50 && s.kind === 'signal' && s.signal !== 'SIGPIPE').map((s) => `${s.signal} from ${who(s.from, pid)} at +${s.t - death} ms`);
    const pipes = trace.filter((s) => s.pid === pid && s.signal === 'SIGPIPE').length;
    const exit = trace.find((s) => s.pid === pid && s.kind === 'exit');
    // The orphan's transcript: the file of this session that grew between the
    // held serve's message and the death (the keeper can miss a pid file
    // removed within its 20 ms scan).
    const heldAt = new Date(String(c.sentAt)).getTime();
    const sizeOf = keeper.filter((k) => k.event === 'size' && String(k.file).endsWith(`/${sid}.jsonl`));
    const heldFile = sizeOf.filter((k) => new Date(String(k.ts)).getTime() >= heldAt && new Date(String(k.ts)).getTime() <= death).at(-1)?.file;
    const root = heldFile ? String(heldFile).slice(0, String(heldFile).indexOf('/projects/')) : null;
    const pfGone = keeper.find((k) => k.event === 'pidfile-gone' && Number(k.pid) === pid);
    const writes = sizeOf.filter((k) => k.file === heldFile);
    const writesAfterDeath = writes.filter((k) => new Date(String(k.ts)).getTime() > death);
    const lastWrite = writesAfterDeath.at(-1);
    const s2 = serve2.find((r) => r.tag === tag) as Json;
    const s3 = serve3.find((r) => r.tag === tag) as Json;
    const check2 = readJson(join(caseDir, '2-serve', `check-${tag}.json`)) as Json;
    const check2At = new Date(String((check2.first as Json).startedAt)).getTime();
    const stop2 = s2.stop as Json | null;
    const tree = timings.filter((x) => String(x.role) === `claude-${tag}-descendant`).map((x) => `${String(x.cmd).slice(0, 24)} +${String(x.msAfterParticipantExit)} ms`);
    const heldTurn = (((s2.windows as Json[]).find((w) => w.name === 'held turn') as Json).rows as Json[]).map((r) => `${String(r.what).slice(0, 70)}${r.stopReason !== undefined ? ` stop=${String(r.stopReason)}` : ''}${r.textChars ? ` chars=${String(r.textChars)}` : ''} carried=${String(r.carried)}`);
    const snap = ending.snapshot ? ((ending.snapshot as Json)[tag] as Json) : undefined;
    const branchCounts = (r: Json): Json => Object.fromEntries(Object.entries(r.branches as Record<string, unknown[]>).map(([k, v]) => [k, v.length]));
    const inv = (r: Json): Json => Object.fromEntries(Object.entries(r.invented as Record<string, unknown[]>).map(([k, v]) => [k, v.length]));
    (out.convs as Json)[tag] = {
      claudePid: pid,
      signalsAfterDeath: sigs,
      sigpipes: pipes,
      exit: exit ? `${exit.text} at +${exit.t - death} ms` : null,
      goneMsAfterDeath: tm?.msAfterParticipantExit ?? null,
      pidFileGoneMsAfterDeath: pfGone ? rel(new Date(String(pfGone.ts)).getTime(), death) : null,
      transcriptRoot: root,
      lastOrphanWriteMsAfterDeath: lastWrite ? rel(new Date(String(lastWrite.ts)).getTime(), death) : null,
      orphanWroteAfterServe2Check: lastWrite ? new Date(String(lastWrite.ts)).getTime() > check2At : false,
      serve2CheckMsAfterDeath: check2At - death,
      toolTree: tree,
      serve2Stop: stop2 ? { outcome: stop2.outcome, signalled: stop2.signalled, pidFiles: (stop2.pidFiles as Json[]).map((p) => ({ pid: p.pid, live: p.live, status: p.status })) } : null,
      serve2CheckAdded: (s2.check as Json).added,
      snapshotAfterOrphans: snap ? { storeEntries: snap.storeEntries, transcriptEntries: snap.transcriptEntries, inTranscriptsNotStore: (snap.inTranscriptsNotStore as unknown[]).length, heldTurn: (snap.heldTurn as Json[]).map((r) => `${String(r.what).slice(0, 70)} inStore=${String(r.inStore)}`) } : null,
      heldTurnAsServe2Saw: heldTurn,
      serve2: { priorEntries: s2.priorEntries, notCarried: (s2.priorNotCarried as unknown[]).length, branches: branchCounts(s2), invented: inv(s2), answer: String(s2.answer).slice(0, 160) },
      serve3: { priorEntries: s3.priorEntries, notCarried: (s3.priorNotCarried as unknown[]).length, branches: branchCounts(s3), invented: inv(s3), answer: String(s3.answer).slice(0, 160) },
    };
  }
  summaries.push(out);
  process.stdout.write(`\n=== ${basename(logPath)}  (${String(ending.case)} ${String(ending.variant)}; layer 1 ${String(ending.layer1)}; ${String(ending.how)}; participant exit ${JSON.stringify(ending.participantExit)})\n`);
  process.stdout.write(`    ${caseDir}\n    tool: started ${String(tool.started)}, finished ${String(tool.finished)}\n`);
  for (const [tag, v] of Object.entries(out.convs as Json)) {
    const x = v as Json;
    process.stdout.write(`  ${tag} claude ${String(x.claudePid)}: signals ${JSON.stringify(x.signalsAfterDeath)}; SIGPIPE x${String(x.sigpipes)}; pid file gone +${String(x.pidFileGoneMsAfterDeath)} ms; last orphan write +${String(x.lastOrphanWriteMsAfterDeath)} ms; gone +${String(x.goneMsAfterDeath)} ms; ${String(x.exit)}\n`);
    process.stdout.write(`     tool tree: ${JSON.stringify(x.toolTree)}\n`);
    process.stdout.write(`     serve 2 stop: ${JSON.stringify(x.serve2Stop)}; check at +${String(x.serve2CheckMsAfterDeath)} ms added ${JSON.stringify(x.serve2CheckAdded)}; orphan wrote after it: ${String(x.orphanWroteAfterServe2Check)}\n`);
    if (x.snapshotAfterOrphans) {
      process.stdout.write(`     after orphans, before any check: ${JSON.stringify(x.snapshotAfterOrphans)}\n`);
    }
    process.stdout.write(`     held turn as serve 2 saw it: ${JSON.stringify(x.heldTurnAsServe2Saw)}\n`);
    process.stdout.write(`     serve 2: ${JSON.stringify(x.serve2)}\n     serve 3: ${JSON.stringify(x.serve3)}\n`);
  }
}
writeFileSync(join('runs', '21-summary.json'), `${JSON.stringify(summaries, null, 2)}\n`);
