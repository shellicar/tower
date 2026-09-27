// Integration proof: the scenarios and their checks.
//
//   node proofs/integration/run.mts <scenario> [--model <m>] [--agent <name>]
//        [--cell <c>[,<c>...]] [--strace] [--no-reset] [--no-prime]
//
// Scenarios (design.md's purpose; scenarios.md's list):
//   smoke     one turn: isolation, login, a publish
//   matrix    the endings matrix: per cell, warm-up, the prompt ended at the
//             cell's ending, then the probe L in the same live Claude Code;
//             then checks (tower as received, live vs offline build, "No
//             response requested.", a restart from the local record as of
//             step 1's result, a resume from tower alone under another agent
//             name as of step 1's result). --cell picks cells.
//   killed    killed mid-turn (SIGKILL during a tool) and served straight
//             away, fresh-origin and tower-origin (--cell fresh|tower)
//   moved-on  tower moved on: another host carries the conversation on;
//             this machine must follow tower and never publish its stale tail
//   origins   a restart of a conversation first resumed from tower here, as
//             of step 1 (the fresh-origin restart is the matrix's), plus the
//             record-resume variant (--cell picks the endings; mid-text by
//             default)
//   skills    skills added, edited and removed mid-run, fresh and resumed,
//             against a plain Claude Code baseline (real folders)
//   two       two participants at once with different config dirs and skills
//   home      a participant under a file-access trace; who touched the real
//             home (--strace is implied)
// --strace runs every participant under `strace -f -y -ttt -s 0 -e
// trace=%file,%process` (no file contents). Each run is one model; several
// runs can go at once under different --agent names (every agent name used
// is derived from --agent).

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { toBodies } from '../reconcile/load.mts';
import { assistantCommits, kindOf, type TMsg } from '../reconcile/holding.mts';
import { lastSeq, openTower, type Tower, towerMessages } from '../semantic/tower.mts';
import { scanTag } from '../tag-scan.mts';
import { type PublishedLine } from './committer.mts';
import { type Cell, cells, type CheckRow, Evidence, printRow, PROBE, resetAgent, short, specFor, WARM } from './common.mts';
import { forks, liveVsOffline, lostFromTower, messagesVs, noResponseOnTower, probeRequest, resumeVerdict, towerVsRequest, unclosedAsOf } from './checks.mts';
import { Participant } from './driver.mts';
import { CONFIG_DIRS_ROOT, clean, HARNESS_STATE, INTEGRATION_STATE, iso, type Json, PACKAGE_ROOT, readJsonl, sleep } from './lib.mts';
import { Lineage } from './lineage.mts';
import { recordedResumeDirs, transcripts, union } from './recover.mts';

interface Args {
  scenario: string;
  model: string;
  agent: string | undefined;
  cells: string[] | undefined;
  strace: boolean;
  reset: boolean;
  prime: boolean;
}

function parse(argv: string[]): Args {
  const a: Args = { scenario: argv[0] ?? '', model: 'claude-haiku-4-5', agent: undefined, cells: undefined, strace: false, reset: true, prime: true };
  for (let i = 1; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === '--model') a.model = String(argv[++i]);
    else if (k === '--agent') a.agent = String(argv[++i]);
    else if (k === '--cell') a.cells = String(argv[++i]).split(',');
    else if (k === '--strace') a.strace = true;
    else if (k === '--no-reset') a.reset = false;
    else if (k === '--no-prime') a.prime = false;
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

const log = (s: string): void => {
  process.stdout.write(`${iso()} ${s}\n`);
};

class UsageLimit extends Error {}

// Every participant this run starts, so a usage-limit 429 stops everything.
const started: Participant[] = [];
function start(spec: ReturnType<typeof specFor>, a: Args): Participant {
  const p = new Participant(spec, { strace: a.strace, log });
  started.push(p);
  return p;
}
function checkUsageLimit(): void {
  for (const p of started) {
    const e = p.events.find((x) => x.ev === 'usage-limit');
    if (e) {
      throw new UsageLimit(`usage limit (429) seen by ${p.spec.agent}: ${JSON.stringify(e).slice(0, 300)}`);
    }
  }
}

let towerConn: Tower | undefined;
async function towerNow(id: string, upto?: number): Promise<Json[]> {
  towerConn ??= await openTower();
  return (await towerMessages(towerConn, id, upto ?? (await lastSeq(towerConn)))) as unknown as Json[];
}

const bodyOf = (m: TMsg): Json => toBodies([m])[0] as unknown as Json;

function published(lineage: string): PublishedLine[] {
  return readJsonl(join(lineage, 'published.jsonl')) as unknown as PublishedLine[];
}

// Tower's stream sequence as of an instant: the last message published for
// something committed at or before it (chosen by commit instant, not ack).
function seqAsOf(lineage: string, ms: number): number {
  const ps = published(lineage).filter((p) => p.kind === 'message' && p.commitMs <= ms && typeof p.seq === 'number');
  return Math.max(0, ...ps.map((p) => p.seq as number));
}

// Where step 1 ended (reconcile's analyse/ending: reached()).
function ending(lin: Lineage, cell: Cell, sayMs: number, resultMs: number, triggered: boolean): Json {
  const commits = assistantCommits(lin.rec);
  const win = lin.rec.entries.filter((r) => r.ms >= sayMs && r.ms <= resultMs);
  const e = {
    cell: cell.id,
    keptReply: win.some((r) => commits.has(String(r.entry.uuid))),
    droppedThinking: win.filter((r) => kindOf(r.entry) === 'assistant' && !commits.has(String(r.entry.uuid))).length,
    apiErrors: win.filter((r) => r.entry.isApiErrorMessage === true).length,
    partial: win.some((r) => r.entry.isAbortedMidStream === true),
    triggered,
  };
  let reached: boolean;
  switch (cell.id) {
    case 'normal':
      reached = e.keptReply;
      break;
    case 'thinking-only':
      reached = e.droppedThinking > 0 && !e.keptReply;
      break;
    case 'limit':
    case 'api-error':
      reached = e.apiErrors > 0;
      break;
    default:
      reached = triggered;
  }
  return { ...e, reached };
}

// Cleaned copies of a lineage's records into the evidence dir.
function keepLineage(ev: Evidence, name: string, lineage: string, requestFiles: string[] = []): string {
  const out = ev.path(name);
  mkdirSync(join(out, 'api-bodies'), { recursive: true });
  for (const f of ['lineage.json', 'store-appends.jsonl', 'next-events.jsonl', 'published.jsonl', 'committer.jsonl']) {
    if (existsSync(join(lineage, f))) {
      writeFileSync(join(out, f), clean(readFileSync(join(lineage, f), 'utf8')));
    }
  }
  for (const f of [...requestFiles, 'index.jsonl']) {
    if (existsSync(join(lineage, 'api-bodies', f))) {
      writeFileSync(join(out, 'api-bodies', f), clean(readFileSync(join(lineage, 'api-bodies', f), 'utf8')));
    }
  }
  return out;
}

async function prime(a: Args, agent: string, ev: Evidence): Promise<void> {
  if (!a.prime) {
    return;
  }
  // The warm-up alone, run to the end, so the agent's config dir has what
  // Claude Code caches on a first run (reconcile's priming run).
  const p = start(specFor(agent, a.model, ev.path(`prime-${agent}`)), a);
  await p.ready();
  await p.serve({ conv: 'prime' });
  await p.say('prime', WARM, { step: 0, quietMs: 500 });
  await p.shutdown();
}

// ---------------------------------------------------------------------------
// smoke

async function smoke(a: Args): Promise<CheckRow[]> {
  const agent = a.agent ?? `int-${short(a.model)}-smoke`;
  const ev = new Evidence(`${short(a.model)}-smoke`);
  if (a.reset) resetAgent(agent, log);
  const p = start(specFor(agent, a.model, ev.path('p1')), a);
  await p.ready();
  const served = await p.serve({ conv: 'c' });
  const r = await p.say('c', WARM, { step: 0 });
  await p.shutdown();
  const init = p.events.find((e) => e.ev === 'init');
  const spawn = p.events.find((e) => e.ev === 'spawn');
  return [
    { scenario: 'smoke', cell: '-', check: 'reply', pass: r.subtype === 'success' && /READY/.test(String(r.text)), reason: `${String(r.subtype)} ${JSON.stringify(r.text)}`, evidence: ev.dir },
    { scenario: 'smoke', cell: '-', check: 'login', pass: init !== undefined && r.subtype === 'success', reason: `apiKeySource ${JSON.stringify(init?.apiKeySource)}, permissionMode ${JSON.stringify(init?.permissionMode)}`, evidence: ev.dir },
    { scenario: 'smoke', cell: '-', check: 'agent config dir', pass: spawn?.agentDir === true, reason: String(spawn?.configDir), evidence: ev.dir },
    { scenario: 'smoke', cell: '-', check: 'published', pass: p.events.some((e) => e.ev === 'published'), reason: `${p.events.filter((e) => e.ev === 'published').length} publishes, lineage ${String(served.lineage)}`, evidence: ev.dir },
  ];
}

// ---------------------------------------------------------------------------
// matrix

async function matrixCell(a: Args, cell: Cell, agent: string, towerAgent: string, root: Evidence, attempt: number): Promise<{ rows: CheckRow[]; reached: boolean }> {
  const tag = `${cell.id}${attempt > 1 ? `-try${attempt}` : ''}`;
  const dir = root.path(tag);
  mkdirSync(dir, { recursive: true });
  const ev = { dir, path: (...p: string[]) => join(dir, ...p) } as Evidence;
  const rows: CheckRow[] = [];
  const row = (check: string, pass: boolean, reason: string, evidence: string, detail?: Json): void => {
    const r = { scenario: 'matrix', cell: tag, check, pass, reason, evidence, ...(detail ? { detail } : {}) };
    rows.push(r);
    printRow(r);
  };

  // The live run: warm-up, the prompt ended at the cell's ending, the probe.
  const p1 = start(specFor(agent, a.model, ev.path('p1-live'), { maxTokens: cell.maxTokens, extraEnv: cell.env }), a);
  await p1.ready();
  const served = await p1.serve({ conv: 'c' });
  const id = String(served.id);
  const lineage = String(served.lineage);
  await p1.say('c', WARM, { step: 0 });
  checkUsageLimit();
  const sent1 = p1.events.length;
  const r1 = await p1.say('c', cell.prompt, { step: 1, ...(cell.ending ? { ending: cell.ending } : {}) });
  checkUsageLimit();
  const say1 = p1.events.slice(sent1).find((e) => e.ev === 'sent');
  const triggered = p1.events.slice(sent1).some((e) => e.ev === 'trigger');
  const step1Ms = Number(r1.ms);
  const r2 = await p1.say('c', PROBE, { step: 2 });
  checkUsageLimit();
  await p1.shutdown();

  const lin = Lineage.open(lineage);
  lin.pollBodies();
  const end = ending(lin, cell, Number(say1?.ms ?? 0), step1Ms, triggered);
  row('ending reached', end.reached === true, JSON.stringify(end), ev.path('p1-live'));
  const denials = r1.permissionDenials as unknown[] | null;
  if (Array.isArray(denials) && denials.length > 0) {
    row('permission', false, `step 1 tool refused in ${String(p1.events.find((e) => e.ev === 'init')?.permissionMode)} mode: ${JSON.stringify(denials).slice(0, 200)}`, ev.path('p1-live'));
  }
  const L = probeRequest(lin.bodies, a.model, PROBE, step1Ms);
  const tower = await towerNow(id);
  const keptL = keepLineage(ev, 'live-lineage', lineage, L ? L.chain.map((c) => c.replace(/\(.*$/, '')) : []);
  writeFileSync(ev.path('tower.json'), clean(JSON.stringify(tower, null, 2)));
  if (!L) {
    row('L request', false, 'no probe request found in the live lineage', keptL);
    return { rows, reached: end.reached === true };
  }
  row('L probe', r2.subtype === 'success', `${String(r2.subtype)} ${JSON.stringify(String(r2.text).slice(0, 60))} (L ${L.file})`, keptL);

  // Tower holds what the model received, for every part a kept reply closed.
  const tv = towerVsRequest(lin.rec, tower, L);
  writeFileSync(ev.path('tower-vs-L.json'), clean(JSON.stringify(tv, null, 2)));
  row('tower as received', tv.kinds.every((k) => k === 'exact' || k === 'newline'), `${tv.kinds.join(',')} request ${tv.shape.request} tower ${tv.shape.tower}${tv.missing.length ? ` missing ${tv.missing.join('; ')}` : ''}${tv.extra.length ? ` extra ${tv.extra.join('; ')}` : ''}${tv.placement.length ? ` ${tv.placement.join('; ')}` : ''}`, ev.path('tower-vs-L.json'));
  // Join 8 and order.
  const lo = liveVsOffline(lineage, bodyOf);
  writeFileSync(ev.path('live-vs-offline.json'), clean(JSON.stringify(lo, null, 2)));
  const notes = (lo.committerNotes as Json[]).filter((n) => ['changed', 'late-insert', 'error'].includes(String(n.kind)));
  row('live = offline build', lo.equal === true && notes.length === 0, `${lo.equal ? 'equal' : `first difference ${JSON.stringify(lo.firstDifference)}`}; live ${String(lo.live)} offline ${String(lo.offline)}; notes ${JSON.stringify(notes)}`, ev.path('live-vs-offline.json'));
  row('order', (lo.orderWarnings as string[]).length === 0, `assistant pieces before their run's user side: ${(lo.orderWarnings as string[]).length} ${JSON.stringify(lo.orderWarnings)}`, ev.path('live-vs-offline.json'));
  const pubIds = published(lineage).filter((x) => x.kind === 'message').map((x) => x.id);
  const towerIds = tower.map((b) => String(b.id));
  row('tower = published', JSON.stringify(pubIds) === JSON.stringify(towerIds), `published ${pubIds.length}, tower ${towerIds.length}`, ev.path('tower.json'));
  const nrr = noResponseOnTower(tower);
  row('no "No response requested."', nrr.length === 0, nrr.length ? `on tower: ${nrr.join(',')}` : 'none on tower', ev.path('tower.json'));

  // A restart on the same machine, from the local record as of step 1.
  const p2 = start(specFor(agent, a.model, ev.path('p2-restart'), { maxTokens: cell.maxTokens }), a);
  await p2.ready();
  const s2 = await p2.serve({ conv: 'restart', id, dry: true, asOfMs: step1Ms, name: 'restart-local' });
  const r2t = await p2.say('restart', PROBE, { step: 2 });
  checkUsageLimit();
  await p2.shutdown();
  const T = probeRequest(join(String(s2.lineage), 'api-bodies'), a.model, PROBE);
  const vRestart = T ? resumeVerdict(L, T) : { verdict: 'no T request' };
  const keptR = keepLineage(ev, 'restart-lineage', String(s2.lineage), T ? [T.file] : []);
  writeFileSync(ev.path('restart-vs-L.json'), clean(JSON.stringify({ served: s2, result: r2t, verdict: vRestart }, null, 2)));
  const okRestart = s2.decision === 'local' && (vRestart.verdict === 'OK' || (vRestart.verdict === 'REQ' && !L.usage));
  row('restart = live', okRestart, `decision ${String(s2.decision)}, ${String(vRestart.verdict)}${vRestart.onlyBetas ? ` (betas only: live has ${JSON.stringify((vRestart.betas as Json).onlyL)}, restart has ${JSON.stringify((vRestart.betas as Json).onlyT)})` : ''}${(vRestart.diff as string[] | undefined)?.length ? ` ${(vRestart.diff as string[]).slice(0, 3).join(' | ')}` : ''} L ${JSON.stringify((vRestart.L as Json | undefined)?.usage ?? null)} T ${JSON.stringify((vRestart.T as Json | undefined)?.usage ?? null)}`, ev.path('restart-vs-L.json'), { keptR });

  // A resume from tower alone, another agent name, as of step 1.
  const asOfSeq = seqAsOf(lineage, step1Ms);
  const towerAsOf = await towerNow(id, asOfSeq);
  const p3 = start(specFor(towerAgent, a.model, ev.path('p3-tower-alone'), { maxTokens: cell.maxTokens }), a);
  await p3.ready();
  const s3 = await p3.serve({ conv: 'tower', id, dry: true, asOfSeq, name: 'tower-alone' });
  const r3t = await p3.say('tower', PROBE, { step: 2 });
  checkUsageLimit();
  await p3.shutdown();
  const T2 = probeRequest(join(String(s3.lineage), 'api-bodies'), a.model, PROBE);
  keepLineage(ev, 'tower-alone-lineage', String(s3.lineage), T2 ? [T2.file] : []);
  if (!T2) {
    row('tower alone', false, `no T request (decision ${String(s3.decision)}, result ${String(r3t.subtype)})`, ev.path('p3-tower-alone'));
  } else {
    const mv = messagesVs(lin.rec, L, T2, step1Ms);
    const expected = unclosedAsOf(lin.rec, towerAsOf, step1Ms);
    const same = JSON.stringify([...new Set(mv.missing)].sort()) === JSON.stringify([...new Set(expected)].sort());
    // The harness fixes cwd per agent name (work/<name>): masked for the
    // request comparison, which is then messages and system only; cache
    // numbers aren't comparable across the two cwds.
    const workOf = (n: string): string => join(HARNESS_STATE, 'work', n);
    const full = resumeVerdict(L, T2, [[workOf(towerAgent), workOf(agent)], [`-work-${towerAgent}`, `-work-${agent}`]]);
    writeFileSync(ev.path('tower-alone-vs-L.json'), clean(JSON.stringify({ served: s3, asOfSeq, towerMessagesAsOf: towerAsOf.length, messages: mv, expectedMissing: expected, fullRequest: full }, null, 2)));
    row('tower alone misses only the unclosed part', s3.decision === 'tower' && same && mv.extra.length === 0 && mv.placement.length === 0 && mv.content.length === 0, `decision ${String(s3.decision)}; L-not-T ${JSON.stringify(mv.missing)} expected ${JSON.stringify(expected)}; extra ${JSON.stringify(mv.extra)}; ${mv.placement.join('; ')}${mv.content.length ? `; carried with other text in T: ${mv.content.join(' | ')}` : ''}; full request (cwd masked) ${String(full.verdict)} ${((full.diff as string[]) ?? []).slice(0, 2).join(' | ')}`, ev.path('tower-alone-vs-L.json'));
  }
  return { rows, reached: end.reached === true };
}

async function matrix(a: Args): Promise<CheckRow[]> {
  const agent = a.agent ?? `int-${short(a.model)}-m`;
  const towerAgent = `${agent}-t`;
  const root = new Evidence(`${short(a.model)}-matrix`);
  if (a.reset) {
    resetAgent(agent, log);
    resetAgent(towerAgent, log);
  }
  await prime(a, agent, root);
  const all = cells(a.model);
  const chosen = a.cells ? a.cells.map((c) => all.find((x) => x.id === c) ?? (() => { throw new Error(`no cell ${c}`); })()) : all;
  const rows: CheckRow[] = [];
  for (const cell of chosen) {
    // thinking-only is rare: attempts capped, whether it was reached reported.
    const attempts = cell.id === 'thinking-only' ? Number(process.env.INT_THINKING_ONLY_TRIES ?? '3') : 1;
    for (let t = 1; t <= attempts; t += 1) {
      try {
        const r = await matrixCell(a, cell, agent, towerAgent, root, t);
        rows.push(...r.rows);
        if (r.reached) {
          break;
        }
      } catch (err) {
        if (err instanceof UsageLimit) {
          throw err;
        }
        const r = { scenario: 'matrix', cell: cell.id, check: 'run', pass: false, reason: err instanceof Error ? (err.stack ?? err.message).slice(0, 400) : String(err), evidence: root.dir };
        printRow(r);
        rows.push(r);
        break;
      }
    }
  }
  writeTable(root, `matrix ${a.model}`, rows);
  return rows;
}

function writeTable(ev: Evidence, title: string, rows: CheckRow[]): void {
  const checks = [...new Set(rows.map((r) => r.check))];
  const cellsSeen = [...new Set(rows.map((r) => r.cell))];
  const lines = [`# ${title}`, '', `| cell | ${checks.join(' | ')} |`, `|${'---|'.repeat(checks.length + 1)}`];
  for (const c of cellsSeen) {
    lines.push(`| ${c} | ${checks.map((k) => {
      const r = rows.find((x) => x.cell === c && x.check === k);
      return r ? (r.pass ? 'PASS' : 'FAIL') : '';
    }).join(' | ')} |`);
  }
  lines.push('', '## Reasons', '');
  for (const r of rows) {
    lines.push(`- ${r.pass ? 'PASS' : 'FAIL'} ${r.cell} / ${r.check}: ${r.reason.replace(/\n/g, ' ')} (${r.evidence})`);
  }
  const p = ev.write('table.md', lines.join('\n'));
  ev.write('rows.json', rows);
  log(`TABLE ${p}`);
}

// ---------------------------------------------------------------------------
// killed mid-turn, served straight away

const KILL_PROMPT = 'Run this exact Bash command in the foreground (not in the background), once: `sleep 20; echo DONE`. Then reply with its output only.';

function localUnion(agent: string, id: string): Json[] {
  const roots = [join(CONFIG_DIRS_ROOT, agent), ...recordedResumeDirs(join(INTEGRATION_STATE, agent)).filter((d) => existsSync(d))];
  return union(transcripts(roots, id));
}

async function killAtTool(p: Participant, conv: string): Promise<void> {
  const n = p.events.length;
  p.send({ cmd: 'say', conv, text: KILL_PROMPT, step: 1 });
  const t = await p.waitFor((e) => (e.ev === 'tool-started' && e.conv === conv) || (e.ev === 'result' && e.conv === conv), 180_000, 'the tool to start', n);
  if (t.ev === 'result') {
    throw new Error(`the kill turn ended before any tool started: ${JSON.stringify(t).slice(0, 300)}`);
  }
  await sleep(2000);
  log(`SIGKILL participant ${p.me?.pid} (${p.spec.agent}) during ${String(t.tool)}`);
  p.kill9();
  await p.exited;
}

async function killed(a: Args): Promise<CheckRow[]> {
  const agent = a.agent ?? `int-${short(a.model)}-k`;
  const creator = `${agent}-o`;
  const root = new Evidence(`${short(a.model)}-killed`);
  if (a.reset) {
    resetAgent(agent, log);
    resetAgent(creator, log);
  }
  await prime(a, agent, root);
  const rows: CheckRow[] = [];
  for (const origin of a.cells ?? ['fresh', 'tower']) {
    const row = (check: string, pass: boolean, reason: string, evidence: string): void => {
      const r = { scenario: 'killed', cell: origin, check, pass, reason, evidence };
      rows.push(r);
      printRow(r);
    };
    const dir = root.path(origin);
    let id: string | undefined;
    if (origin !== 'fresh') {
      const p0 = start(specFor(creator, a.model, join(dir, 'p0-creator')), a);
      await p0.ready();
      id = String((await p0.serve({ conv: 'c' })).id);
      await p0.say('c', WARM, { step: 0 });
      await p0.shutdown();
    }
    const p1 = start(specFor(agent, a.model, join(dir, 'p1-killed')), a);
    await p1.ready();
    const s1 = await p1.serve({ conv: 'c', ...(id ? { id } : {}) });
    id = String(s1.id);
    if (origin === 'fresh') {
      await p1.say('c', WARM, { step: 0 });
    }
    checkUsageLimit();
    // Served straight away: the next participant is started and loaded
    // before the kill (proof 25's -now cases), its safety list P1's Claude
    // Codes, and told to serve the moment P1 is gone.
    const p2 = start(specFor(agent, a.model, join(dir, 'p2-served'), { ours: p1.claudes }), a);
    await p2.ready();
    await killAtTool(p1, 'c');
    p2.send({ cmd: 'ours', add: p1.claudes });
    // tower-record: the variant way through for a tower-origin conversation
    // (TODO: undecided): load() returns this machine's own recording.
    const s2 = await p2.serve({ conv: 'c', id, ...(origin === 'tower-record' ? { from: 'record' } : {}) });
    const stop = p2.events.find((e) => e.ev === 'stopped');
    const stopReport = JSON.parse(readFileSync(join(dir, 'p2-served', 'stop-c.json'), 'utf8')) as Json;
    const foundAtStop = ((stopReport.rounds as Json[])[0]?.found as Json[] | undefined) ?? [];
    const r = await p2.say('c', PROBE, { step: 2 });
    checkUsageLimit();
    await p2.shutdown();
    const tower = await towerNow(id);
    writeFileSync(join(dir, 'tower.json'), clean(JSON.stringify(tower, null, 2)));
    const local = localUnion(agent, id);
    writeFileSync(join(dir, 'served.json'), clean(JSON.stringify({ s1, s2, stop }, null, 2)));
    const waited = ((stopReport.rounds as Json[]).flatMap((r) => (r.waited as Json[]) ?? []));
    const leftClaudes = foundAtStop.filter((f) => f.claudeCode === true);
    const allWaited = leftClaudes.every((f) => waited.some((w) => w.pid === f.pid && w.goneAt !== null));
    const unclassified = foundAtStop.filter((f) => f.claudeCode !== true && p1.claudes.some((k) => k.pid === f.pid));
    row('leftover stopped before serving', /all exited|none found/.test(String(stop?.outcome)) && allWaited && unclassified.length === 0, `${String(stop?.outcome)}; found at the first scan ${JSON.stringify(foundAtStop.map((f) => [f.pid, f.claudeCode ? 'claude' : f.cmd]))}; signals ${JSON.stringify(stop?.signals)}; waited ${JSON.stringify(waited)}${unclassified.length ? `; P1's Claude Code not recognised: ${JSON.stringify(unclassified)}` : ''}`, join(dir, 'p2-served'));
    row('decision', origin === 'fresh' ? s2.decision === 'local' : origin === 'tower' ? s2.decision === 'tower' : s2.decision === 'record', `decision ${String(s2.decision)}; recovery ${JSON.stringify(s2.recovery).slice(0, 300)}`, join(dir, 'served.json'));
    const f = forks(tower);
    row('nothing forks', f.length === 0, f.length ? JSON.stringify(f) : 'no two tower entries share a parent', join(dir, 'tower.json'));
    const lost = lostFromTower(local, tower);
    writeFileSync(join(dir, 'lost.json'), clean(JSON.stringify(lost, null, 2)));
    row('nothing written is lost', lost.lostVisible.length === 0, `model-visible entries not on tower: ${JSON.stringify(lost.lostVisible)}; unshown not carried: ${lost.unshownNotCarried.length}; dropped thinking-only: ${lost.droppedThinking.length}; synthetic: ${lost.synthetic.length}`, join(dir, 'lost.json'));
    const nrr = noResponseOnTower(tower);
    row('no "No response requested."', nrr.length === 0, nrr.length ? nrr.join(',') : 'none on tower', join(dir, 'tower.json'));
    const probeOn = tower.some((b) => b.role === 'user' && JSON.stringify(b.content).includes(PROBE));
    row('probe committed', r.subtype === 'success' && probeOn, `probe ${String(r.subtype)} ${JSON.stringify(String(r.text).slice(0, 40))}; its message on tower: ${probeOn}`, join(dir, 'tower.json'));
    for (const [name, lineage] of [...new Set([String(s1.lineage), String(s2.lineage)])].map((l, i) => [`lineage-${i + 1}`, l] as const)) {
      const lo = liveVsOffline(lineage, bodyOf);
      keepLineage({ path: (...p: string[]) => join(dir, ...p) } as Evidence, name, lineage);
      writeFileSync(join(dir, `${name}-live-vs-offline.json`), clean(JSON.stringify(lo, null, 2)));
      const notes = (lo.committerNotes as Json[]).filter((n) => ['changed', 'late-insert', 'error'].includes(String(n.kind)));
      row(`live = offline build (${name})`, lo.equal === true && notes.length === 0, `${lo.equal ? 'equal' : JSON.stringify(lo.firstDifference)}; order warnings ${(lo.orderWarnings as string[]).length}; notes ${JSON.stringify(notes)}`, join(dir, `${name}-live-vs-offline.json`));
    }
  }
  writeTable(root, `killed ${a.model}`, rows);
  return rows;
}

// ---------------------------------------------------------------------------
// tower moved on

async function movedOn(a: Args): Promise<CheckRow[]> {
  const agent = a.agent ?? `int-${short(a.model)}-mo`;
  const other = `${agent}-2`;
  const root = new Evidence(`${short(a.model)}-moved-on`);
  if (a.reset) {
    resetAgent(agent, log);
    resetAgent(other, log);
  }
  await prime(a, agent, root);
  const rows: CheckRow[] = [];
  const row = (check: string, pass: boolean, reason: string, evidence: string): void => {
    const r = { scenario: 'moved-on', cell: '-', check, pass, reason, evidence };
    rows.push(r);
    printRow(r);
  };
  // Machine 1: a turn, then killed mid-tool; its Claude Code writes a tail
  // tower never gets.
  const p1 = start(specFor(agent, a.model, root.path('p1-machine1')), a);
  await p1.ready();
  const id = String((await p1.serve({ conv: 'c' })).id);
  await p1.say('c', WARM, { step: 0 });
  await killAtTool(p1, 'c');
  await p1.claudesGone();
  const towerBefore = await towerNow(id);
  const held = new Set(towerBefore.flatMap((b) => ((b.ccEntries as Json[] | undefined) ?? []).map((c) => String(c.uuid))));
  const stale = localUnion(agent, id).filter((e) => typeof e.uuid === 'string' && !held.has(String(e.uuid)));
  writeFileSync(root.path('stale.json'), clean(JSON.stringify(stale.map((e) => ({ uuid: e.uuid, type: e.type })), null, 2)));
  // Machine 2 carries it on from tower.
  const pB = start(specFor(other, a.model, root.path('p2-machine2')), a);
  await pB.ready();
  const sB = await pB.serve({ conv: 'c', id });
  await pB.say('c', 'Reply with the word OTHER only.', { step: 1 });
  checkUsageLimit();
  await pB.shutdown();
  // Machine 1 again.
  const p2 = start(specFor(agent, a.model, root.path('p3-machine1-again'), { ours: p1.claudes }), a);
  await p2.ready();
  const s2 = await p2.serve({ conv: 'c', id });
  await p2.say('c', PROBE, { step: 2 });
  checkUsageLimit();
  await p2.shutdown();
  const tower = await towerNow(id);
  writeFileSync(root.path('tower.json'), clean(JSON.stringify(tower, null, 2)));
  const onTower = new Set(tower.flatMap((b) => ((b.ccEntries as Json[] | undefined) ?? []).map((c) => String(c.uuid))));
  const leaked = stale.filter((e) => onTower.has(String(e.uuid)));
  row('machine 2 resumed from tower', sB.decision === 'tower', `decision ${String(sB.decision)}`, root.path('p2-machine2'));
  row('machine 1 follows tower', s2.decision === 'tower' && s2.movedOn === true, `decision ${String(s2.decision)} movedOn ${String(s2.movedOn)} recovery ${JSON.stringify(s2.recovery)}`, root.path('p3-machine1-again'));
  row('stale tail never published', stale.length > 0 && leaked.length === 0, `stale local entries ${stale.length}, on tower ${leaked.length} ${JSON.stringify(leaked.map((e) => e.uuid))}`, root.path('stale.json'));
  const f = forks(tower);
  row('nothing forks', f.length === 0, f.length ? JSON.stringify(f) : 'no two tower entries share a parent', root.path('tower.json'));
  const T = probeRequest(join(String(s2.lineage), 'api-bodies'), a.model, PROBE);
  row('machine 1 builds on machine 2', T !== undefined && JSON.stringify(T.messages).includes('OTHER'), T ? `machine 1's probe request carries machine 2's turn: ${JSON.stringify(T.messages).includes('OTHER')}` : 'no probe request', String(s2.lineage));
  const nrr = noResponseOnTower(tower);
  row('no "No response requested."', nrr.length === 0, nrr.length ? nrr.join(',') : 'none on tower', root.path('tower.json'));
  writeTable(root, `moved-on ${a.model}`, rows);
  return rows;
}

// ---------------------------------------------------------------------------
// restart of a conversation first resumed from tower here

async function origins(a: Args): Promise<CheckRow[]> {
  const agent = a.agent ?? `int-${short(a.model)}-or`;
  const creator = `${agent}-o`;
  const root = new Evidence(`${short(a.model)}-origins`);
  if (a.reset) {
    resetAgent(agent, log);
    resetAgent(creator, log);
  }
  await prime(a, agent, root);
  const all = cells(a.model);
  const rows: CheckRow[] = [];
  for (const cid of a.cells ?? ['mid-text']) {
    const cell = all.find((c) => c.id === cid);
    if (!cell) throw new Error(`no cell ${cid}`);
    const dir = root.path(cid);
    const row = (check: string, pass: boolean, reason: string, evidence: string): void => {
      const r = { scenario: 'origins', cell: cid, check, pass, reason, evidence };
      rows.push(r);
      printRow(r);
    };
    const p0 = start(specFor(creator, a.model, join(dir, 'p0-creator')), a);
    await p0.ready();
    const id = String((await p0.serve({ conv: 'c' })).id);
    await p0.say('c', WARM, { step: 0 });
    await p0.shutdown();
    const p1 = start(specFor(agent, a.model, join(dir, 'p1-live'), { maxTokens: cell.maxTokens, extraEnv: cell.env }), a);
    await p1.ready();
    const s1 = await p1.serve({ conv: 'c', id });
    const r1 = await p1.say('c', cell.prompt, { step: 1, ...(cell.ending ? { ending: cell.ending } : {}) });
    await p1.say('c', PROBE, { step: 2 });
    checkUsageLimit();
    await p1.shutdown();
    const step1Ms = Number(r1.ms);
    const lineage = String(s1.lineage);
    const L = probeRequest(join(lineage, 'api-bodies'), a.model, PROBE, step1Ms);
    row('first serve from tower', s1.decision === 'tower', `decision ${String(s1.decision)}`, join(dir, 'p1-live'));
    if (!L) {
      row('L request', false, 'no probe request', lineage);
      continue;
    }
    for (const [label, from] of [
      ['restart (auto)', 'auto'],
      ['restart from own recording (variant)', 'record'],
    ] as const) {
      const p = start(specFor(agent, a.model, join(dir, `p-${from}`), { maxTokens: cell.maxTokens }), a);
      await p.ready();
      const s = await p.serve({ conv: `r-${from}`, id, dry: true, from, asOfMs: step1Ms, asOfSeq: seqAsOf(lineage, step1Ms), name: `restart-${from}` });
      await p.say(`r-${from}`, PROBE, { step: 2 });
      checkUsageLimit();
      await p.shutdown();
      const T = probeRequest(join(String(s.lineage), 'api-bodies'), a.model, PROBE);
      const v = T ? resumeVerdict(L, T) : { verdict: 'no T request' };
      writeFileSync(join(dir, `restart-${from}.json`), clean(JSON.stringify({ served: s, verdict: v }, null, 2)));
      row(label, v.verdict === 'OK', `decision ${String(s.decision)}; ${String(v.verdict)}${v.onlyBetas ? ` (betas only: ${JSON.stringify(v.betas)})` : ''} ${((v.diff as string[]) ?? []).slice(0, 2).join(' | ')}`, join(dir, `restart-${from}.json`));
    }
  }
  writeTable(root, `origins ${a.model}`, rows);
  return rows;
}

// ---------------------------------------------------------------------------
// skills

function skillMd(name: string, marker: string): string {
  return `---\nname: ${name}\ndescription: Dummy skill for tower's integration proof. MARKER=${marker}\n---\n\nINT-BODY-${name}. When invoked, reply with the single word DONE-${name}. Don't use any tools.\n`;
}
function writeSkill(dir: string, name: string, marker: string): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'SKILL.md'), skillMd(name, marker));
}

// What the model was told about skills and what invocations did, per
// lineage: skill_listing attachments (names, markers), DONE replies, unknown
// skill notices.
function skillView(lineage: string): Json {
  const lin = Lineage.open(lineage);
  const listings = lin.rec.entries
    .filter((r) => (r.entry.attachment as Json | undefined)?.type === 'skill_listing')
    .map((r) => {
      const att = r.entry.attachment as Json;
      return { isInitial: att.isInitial === true, names: ((att.names as string[]) ?? []).filter((n) => n.startsWith('int-')), markers: [...String(att.content ?? '').matchAll(/MARKER=(\w+)/g)].map((m) => m[1]) };
    });
  const text = lin.rec.entries.map((r) => JSON.stringify(r.entry)).join('\n');
  return { listings, done: [...new Set([...text.matchAll(/DONE-int-[\w-]+/g)].map((m) => m[0]))], unknown: [...new Set([...text.matchAll(/(Unknown (?:skill|command)[^"\\]{0,60})/g)].map((m) => m[0]))] };
}

async function skills(a: Args): Promise<CheckRow[]> {
  const agent = a.agent ?? `int-${short(a.model)}-sk`;
  const plain = `${agent}-plain`;
  const second = `${agent}-2`;
  const root = new Evidence(`${short(a.model)}-skills`);
  for (const n of [agent, plain, second]) if (a.reset) resetAgent(n, log);
  const fix = join(INTEGRATION_STATE, 'fixtures', `${iso().replace(/[:.]/g, '')}-${agent}`);
  const declared = join(fix, 'declared');
  const parked = join(fix, 'parked');
  mkdirSync(parked, { recursive: true });
  writeSkill(declared, 'int-seed', 'V1');
  // The baseline: real folders in its own config dir, user source open.
  const plainSkills = join(CONFIG_DIRS_ROOT, plain, 'skills');
  writeSkill(plainSkills, 'int-seed', 'V1');
  const OK = "Reply with the single word OK. Don't use any tools.";
  const SETTLE = 8000;
  const views: Json = {};
  for (const side of ['participant', 'plain'] as const) {
    const who = side === 'participant' ? agent : plain;
    const dirOf = side === 'participant' ? declared : plainSkills;
    const p = start(specFor(who, a.model, root.path(`${side}-fresh`), { skills: side === 'participant' ? [declared] : [] }), a);
    await p.ready();
    const s = await p.serve({ conv: 'c' });
    const id = String(s.id);
    await p.say('c', OK, { step: 0 });
    writeSkill(dirOf, 'int-late', 'LATE');
    if (side === 'participant') p.send({ cmd: 'skills', declared: [declared] });
    await sleep(SETTLE);
    await p.say('c', OK, { step: 1 });
    writeFileSync(join(dirOf, 'int-seed', 'SKILL.md'), skillMd('int-seed', 'V2'));
    await sleep(SETTLE);
    await p.say('c', OK, { step: 2 });
    await p.say('c', '/int-late', { step: 3 });
    renameSync(join(dirOf, 'int-late'), join(parked, `${side}-int-late`));
    if (side === 'participant') p.send({ cmd: 'skills', declared: [declared] });
    await sleep(SETTLE);
    await p.say('c', OK, { step: 4 });
    await p.say('c', '/int-late', { step: 5 });
    checkUsageLimit();
    await p.shutdown();
    // Resumed from the local record.
    const q = start(specFor(who, a.model, root.path(`${side}-resumed`), { skills: side === 'participant' ? [declared] : [] }), a);
    await q.ready();
    const s2 = await q.serve({ conv: 'c', id });
    await q.say('c', OK, { step: 6 });
    await q.say('c', '/int-seed', { step: 7 });
    await q.shutdown();
    views[side] = { fresh: skillView(String(s.lineage)), resumed: skillView(String(s2.lineage)), decision: s2.decision, init: [p, q].map((x) => ((x.events.find((e) => e.ev === 'init')?.skills as string[]) ?? []).filter((n) => n.startsWith('int-'))) };
    if (side === 'participant') {
      // Resumed from tower under another agent name: a store resume, the
      // skills linked by the spawn hook into /tmp/claude-resume-*.
      writeSkill(declared, 'int-late', 'LATE2');
      const t = start(specFor(second, a.model, root.path('participant-tower-resumed'), { skills: [declared] }), a);
      await t.ready();
      const s3 = await t.serve({ conv: 'c', id });
      await t.say('c', OK, { step: 8 });
      await t.say('c', '/int-late', { step: 9 });
      await t.shutdown();
      (views[side] as Json).towerResumed = { decision: s3.decision, view: skillView(String(s3.lineage)), init: ((t.events.find((e) => e.ev === 'init')?.skills as string[]) ?? []).filter((n) => n.startsWith('int-')), spawns: t.events.filter((e) => e.ev === 'spawn').map((e) => e.configDir) };
    }
  }
  const out = root.write('skills.json', views);
  const pv = views.participant as Json;
  const bv = views.plain as Json;
  const strip = (v: Json): string => JSON.stringify(v);
  const rows: CheckRow[] = [
    { scenario: 'skills', cell: 'fresh', check: 'as plain Claude Code', pass: strip(pv.fresh as Json) === strip(bv.fresh as Json), reason: `participant ${strip(pv.fresh as Json)} plain ${strip(bv.fresh as Json)}`, evidence: out },
    { scenario: 'skills', cell: 'resumed', check: 'as plain Claude Code', pass: strip(pv.resumed as Json) === strip(bv.resumed as Json), reason: `participant ${strip(pv.resumed as Json)} plain ${strip(bv.resumed as Json)}`, evidence: out },
    { scenario: 'skills', cell: 'tower-resumed', check: 'linked into the resume dir', pass: JSON.stringify(((pv.towerResumed as Json).view as Json).done).includes('DONE-int-late'), reason: JSON.stringify(pv.towerResumed), evidence: out },
  ];
  for (const r of rows) printRow(r);
  writeTable(root, `skills ${a.model}`, rows);
  return rows;
}

// ---------------------------------------------------------------------------
// two participants at once

async function two(a: Args): Promise<CheckRow[]> {
  const base = a.agent ?? `int-${short(a.model)}-two`;
  const names = [`${base}-a`, `${base}-b`];
  const root = new Evidence(`${short(a.model)}-two`);
  for (const n of names) if (a.reset) resetAgent(n, log);
  const fix = join(INTEGRATION_STATE, 'fixtures', `${iso().replace(/[:.]/g, '')}-${base}`);
  const decl = names.map((n, i) => {
    const d = join(fix, `declared-${i}`);
    writeSkill(d, `int-only-${n.slice(-1)}`, n.slice(-1).toUpperCase());
    return d;
  });
  const ps = names.map((n, i) => start(specFor(n, a.model, root.path(n), { skills: [decl[i] as string] }), a));
  await Promise.all(ps.map((p) => p.ready()));
  const served = await Promise.all(ps.map((p) => p.serve({ conv: 'c' })));
  const TOOL = 'Run this exact Bash command in the foreground, once: `sleep 8; echo TWO`. Then reply with its output only.';
  // Both mid-tool at once; meanwhile each agent's tag scan.
  const turns = ps.map((p) => p.say('c', TOOL, { step: 1 }));
  await Promise.all(ps.map((p) => p.waitFor((e) => e.ev === 'tool-started' || e.ev === 'result', 180_000, 'tool')));
  const scans = names.map((n) => scanTag(n).found.map((f) => f.pid));
  // A's leftover stop while B runs: a serve on A (a second conversation).
  await ps[0]?.serve({ conv: 'c2' });
  await Promise.all(turns);
  checkUsageLimit();
  await Promise.all(ps.map((p) => p.shutdown()));
  const rows: CheckRow[] = [];
  const row = (check: string, pass: boolean, reason: string): void => {
    const r = { scenario: 'two', cell: '-', check, pass, reason, evidence: root.dir };
    rows.push(r);
    printRow(r);
  };
  const claudes = ps.map((p) => new Set(p.claudes.map((k) => k.pid)));
  row('each tag finds only its own Claude Codes', scans.every((s, i) => s.filter((pid) => claudes.some((c, j) => j !== i && c.has(pid))).length === 0), JSON.stringify({ scans, claudes: claudes.map((c) => [...c]) }));
  const stopA = ps[0]?.events.filter((e) => e.ev === 'stopped').at(-1);
  row("A's leftover stop didn't touch B", ((stopA?.signals as Json[]) ?? []).every((s) => !claudes[1]?.has(Number(s.pid))), JSON.stringify(stopA));
  for (const [i, n] of names.entries()) {
    const sk = join(CONFIG_DIRS_ROOT, n, 'skills');
    const links = existsSync(sk) ? readdirSync(sk) : [];
    const init = ((ps[i]?.events.find((e) => e.ev === 'init')?.skills as string[]) ?? []).filter((s) => s.startsWith('int-'));
    row(`${n} sees only its skills`, JSON.stringify(links) === JSON.stringify([`int-only-${n.slice(-1)}`]) && JSON.stringify(init) === JSON.stringify([`int-only-${n.slice(-1)}`]), `links ${JSON.stringify(links)} init ${JSON.stringify(init)}`);
  }
  void served;
  writeTable(root, `two ${a.model}`, rows);
  return rows;
}

// ---------------------------------------------------------------------------
// the home trace

async function home(a: Args): Promise<CheckRow[]> {
  const agent = a.agent ?? `int-${short(a.model)}-home`;
  const root = new Evidence(`${short(a.model)}-home`);
  if (a.reset) resetAgent(agent, log);
  const traced = { ...a, strace: true };
  const phases: { name: string; at: number }[] = [];
  const phase = (name: string): void => {
    phases.push({ name, at: Date.now() / 1000 });
  };
  phase('start');
  const p = start(specFor(agent, a.model, root.path('p1')), traced);
  await p.ready();
  phase('serve');
  const s = await p.serve({ conv: 'c' });
  phase('turn');
  await p.say('c', 'Run this exact Bash command, once: `echo HOME=$HOME`. Then reply with its output only.', { step: 0 });
  phase('idle');
  await sleep(30_000);
  phase('shutdown');
  await p.shutdown();
  phase('resume');
  const q = start(specFor(agent, a.model, root.path('p2')), traced);
  await q.ready();
  await q.serve({ conv: 'c', id: String(s.id), from: 'tower' });
  await q.say('c', WARM, { step: 1 });
  await q.shutdown();
  phase('end');
  writeFileSync(root.path('phases.json'), JSON.stringify(phases));
  const rows: CheckRow[] = [];
  for (const [n, x] of [
    ['p1', p],
    ['p2', q],
  ] as const) {
    const privateHome = String(x.events.find((e) => e.ev === 'ready')?.privateHome);
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(PACKAGE_ROOT, 'proofs', 'home-trace.mts'), String(x.tracePath), root.path('phases.json'), `home=${privateHome}`, join(CONFIG_DIRS_ROOT, agent), join(HARNESS_STATE, 'work', agent), HARNESS_STATE, join(PACKAGE_ROOT, 'runs')], { encoding: 'utf8', maxBuffer: 1 << 28 });
    const text = r.stdout;
    const p = root.write(`home-trace-${n}.txt`, text);
    // Claude Code's own machinery writing in the real home (a W line by
    // [claude] in a real-home bucket). Commands through the shell prefix
    // ([claude > bash ...]) are expected to use the real home.
    let bucket = '';
    const writes: string[] = [];
    for (const l of text.split('\n')) {
      if (l.startsWith('== ')) bucket = l.slice(3);
      if (/^~|^\/run\/user/.test(bucket) && /^\s+W \[claude\]/.test(l)) writes.push(`${bucket}: ${l.trim()}`);
    }
    const bodyLog = text.split('\n').filter((l) => l.includes('api-bodies') || /\.request\.json/.test(l));
    const row = { scenario: 'home', cell: n, check: 'Claude Code writes nothing in the real home', pass: r.status === 0 && writes.length === 0, reason: writes.length ? writes.slice(0, 5).join(' || ') : `no writes by claude in the real home; body-log lines outside own dirs: ${bodyLog.length}`, evidence: p };
    rows.push(row);
    printRow(row);
  }
  writeTable(root, `home ${a.model}`, rows);
  return rows;
}

// ---------------------------------------------------------------------------

const SCENARIOS: Record<string, (a: Args) => Promise<CheckRow[]>> = { smoke, matrix, killed, 'moved-on': movedOn, origins, skills, two, home };

async function main(): Promise<void> {
  const a = parse(process.argv.slice(2));
  const fn = SCENARIOS[a.scenario];
  if (!fn) {
    process.stderr.write(`usage: node proofs/integration/run.mts <${Object.keys(SCENARIOS).join('|')}> [--model m] [--agent name] [--cell c,..] [--strace] [--no-reset] [--no-prime]\n`);
    process.exit(2);
  }
  let rows: CheckRow[] = [];
  let code = 0;
  try {
    rows = await fn(a);
    code = rows.every((r) => r.pass) ? 0 : 1;
  } catch (err) {
    log(`${err instanceof UsageLimit ? 'STOPPED (usage limit)' : 'FAILED'}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    code = err instanceof UsageLimit ? 3 : 2;
  } finally {
    // Nothing left running: any participant still alive gets the first press.
    for (const p of started) {
      if (!p.exitInfo) {
        p.send({ cmd: 'shutdown' });
        await Promise.race([p.exited, sleep(90_000)]);
      }
    }
    await towerConn?.nc.close();
  }
  log(`SUMMARY ${rows.filter((r) => r.pass).length}/${rows.length} PASS`);
  process.exit(code);
}

await main();


