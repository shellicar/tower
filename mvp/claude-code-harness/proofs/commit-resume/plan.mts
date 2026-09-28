// Store commit against resume from tower: the plan. For each recorded SDK
// cancel scenario (one rep each), take the main run's store appends in order,
// apply each commit rule, and write what tower would hold at each pickup
// point, with the prompt the live run sent next and the request to compare
// against. run.mts resumes a fresh Claude Code from each distinct holding.
//
// Pickup points:
//   P<s>  just before the main run sent step s (s >= 1): every query before
//         it has ended. Probe = step s's text; reference = the live request
//         for it (the main run's own next request).
//   end   after the main run (its last query ended, or Claude Code or the
//         SDK's host died). Probe = the recorded resumes' first prompt, or
//         AGAIN when none was recorded. References: Claude Code's own record
//         (the transcript as it stood, cut at the pickup; loaded through the
//         same store path, run here) and, for a killed run, the recorded
//         transcript resume's request (Claude Code resuming its own file).
//   end2  D9 store scenarios only: after the first store resume (itself
//         killed). Holding = main appends + that resume's appends.
//
// Rules (none is a proposal; the choice is Stephen's):
//   R0     every append entry, in append order, as appended (opaque).
//   R0@    R0, resumed with resumeSessionAt = the uuid of the last main
//          entry that has one.
//   H      Stephen's alternative: a prompt entry is held until an assistant
//          entry with a block that is not thinking arrives; everything
//          appended after a held prompt is held with it and released with
//          it. Held entries are not in tower at a pickup.
//   Hp     H, and the query's parent: when the next query starts (its send)
//          while a prompt is still held, the held entries stay off the live
//          chain (a branch) and the next query attaches after the last
//          committed entry, beside the cancelled prompt.
//   Hl     Hp, and the next query's first entry that names a branched entry
//          as its parentUuid is given the uuid of its tower parent (added
//          after Hp lost the history before the branch: A-thinking end).
//   H@ Hp@ Hl@ with resumeSessionAt as R0@.
//   OWN    not a rule: Claude Code's own transcript, cut at the pickup.
//   OWN@   OWN with resumeSessionAt as R0@.
//
// Choices made for these runs, not decisions (TODO: undecided):
//   - Rep: the latest recorded rep 1 of each scenario (rep 2 if no rep 1).
//   - H's "prompt": a main user entry whose text is one the run sent;
//     "non-thinking": any content block type other than thinking and
//     redacted_thinking. Subagent (subpath) appends pass through every rule.
//   - Query boundary for Hp: the next send; a pushed prompt (E3) joins the
//     running query and is not a boundary.
//   - Model options (thinking, tools) from the main run's run.json; env
//     values (not recorded) from the cancel scenarios' definitions.
//
//   node proofs/commit-resume/plan.mts <out-dir>

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Json = Record<string, unknown>;
interface Key {
  projectKey: string;
  sessionId: string;
  subpath?: string;
}
interface Append {
  ms: number;
  key: Key;
  entries: Json[];
}
interface Send {
  step: number;
  text: string;
  ms: number;
}

const WT = '/home/stephen/repos/@shellicar/tower/.claude/worktrees';
const INDEX_DIRS = [`${WT}/cancel-scenarios/mvp/claude-code-harness/runs`, `${WT}/cancel-sdk-d/mvp/claude-code-harness/runs`];
const AGAIN = 'Reply with the word AGAIN only.';

// Per-scenario options the main runs used (cancel run.mts, scenarios()).
function scenarioOptions(id: string, runDir: string): { thinking: Json; tools: string[]; env: Record<string, string> } {
  // Model options as the main run passed them (its run.json); env values
  // are not recorded there, only names, so they come from scenarios().
  const o = (JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) as Json).options as Json;
  const thinking = o.thinking as Json;
  const tools = o.tools as string[];
  let env: Record<string, string> = {};
  if (id.startsWith('D10-')) {
    env = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '15' };
  }
  if (id === 'F1') {
    env = { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64' };
  }
  if (id.startsWith('F2-') || id.startsWith('F3-')) {
    env = { CLAUDE_CODE_MAX_RETRIES: '2' };
  }
  return { thinking, tools, env };
}

const lines = (p: string): Json[] =>
  existsSync(p)
    ? readFileSync(p, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as Json)
    : [];

function textOfContent(c: unknown): string {
  if (typeof c === 'string') {
    return c;
  }
  if (Array.isArray(c)) {
    return (c as Json[]).map((b) => (typeof b.text === 'string' ? b.text : '')).join('\n');
  }
  return '';
}

function lastUserText(body: Json): string {
  const msgs = (body.messages ?? []) as Json[];
  const last = [...msgs].reverse().find((m) => m.role === 'user');
  return last ? textOfContent(last.content) : '';
}

// The first main-query request after `after` (and before the next send)
// whose last user message carries `probe` (tools present: not the title
// request). A step whose own request never went out (D10-interrupt's NEXT,
// stopped during compaction) has none: the next step's request carries the
// same text merged.
function findRequest(rawDir: string, after: number, probe: string, before = Number.POSITIVE_INFINITY): string | undefined {
  for (const e of lines(join(rawDir, 'cancel-events.jsonl'))) {
    if (e.src !== 'bodies' || e.kind !== 'request' || Number(e.ms) < after || Number(e.ms) >= before || Number(e.tools ?? 0) === 0) {
      continue;
    }
    const file = join(rawDir, 'api-bodies', String(e.file));
    if (!existsSync(file)) {
      continue;
    }
    const body = JSON.parse(readFileSync(file, 'utf8')) as Json;
    if (lastUserText(body).includes(probe)) {
      return file;
    }
  }
  return undefined;
}

function sendsOf(rawDir: string): Send[] {
  return lines(join(rawDir, 'cancel-events.jsonl'))
    .filter((e) => e.src === 'proof' && (e.kind === 'send' || e.kind === 'push'))
    .map((e) => ({ step: Number(e.step), text: String(e.text), ms: Number(e.ms), kind: e.kind }) as Send);
}

function appendsOf(rawDir: string): Append[] {
  return lines(join(rawDir, 'store-appends.jsonl')).map((a) => ({ ms: Number(a.ms), key: a.key as Key, entries: a.entries as Json[] }));
}

// ---------------------------------------------------------------------------
// Rules

interface Holding {
  appends: { key: Key; entries: Json[] }[];
  resumeSessionAt?: string;
  // Entries held or branched at this pickup (uuid/type), for the report.
  notCommitted?: string[];
}

const isMain = (k: Key): boolean => !k.subpath;
const blocks = (e: Json): Json[] => {
  const c = (e.message as Json | undefined)?.content;
  return typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? (c as Json[]) : [];
};
const isPrompt = (e: Json, texts: Set<string>): boolean => e.type === 'user' && texts.has(textOfContent((e.message as Json | undefined)?.content));
const isNonThinkingReply = (e: Json): boolean => e.type === 'assistant' && blocks(e).some((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking');
const brief = (e: Json): string => `${String(e.uuid ?? '-').slice(0, 8)}:${String(e.type)}${e.subtype ? `:${String(e.subtype)}` : ''}`;

function lastUuid(h: Holding): string | undefined {
  for (let i = h.appends.length - 1; i >= 0; i -= 1) {
    const a = h.appends[i] as Holding['appends'][number];
    if (!isMain(a.key)) {
      continue;
    }
    for (let j = a.entries.length - 1; j >= 0; j -= 1) {
      const u = (a.entries[j] as Json).uuid;
      if (typeof u === 'string') {
        return u;
      }
    }
  }
  return undefined;
}

function r0(appends: Append[], cutoff: number): Holding {
  return { appends: appends.filter((a) => a.ms < cutoff).map((a) => ({ key: a.key, entries: a.entries })) };
}

function hold(appends: Append[], sends: Send[], cutoff: number, parent: boolean, link = false): Holding {
  const texts = new Set(sends.map((s) => s.text));
  const out: Holding['appends'] = [];
  const branched: string[] = [];
  const branchedIds = new Set<string>();
  let lastMainUuid: string | undefined;
  let held: { key: Key; entry: Json }[] | null = null;
  const commit = (key: Key, e: Json): void => {
    let entry = e;
    if (isMain(key)) {
      // Hl: an entry whose parentUuid names a branched entry is given the
      // uuid of the entry it now attaches after in tower (its tower parent).
      if (link && typeof entry.parentUuid === 'string' && branchedIds.has(entry.parentUuid)) {
        entry = { ...entry, parentUuid: lastMainUuid ?? null };
      }
      if (typeof entry.uuid === 'string') {
        lastMainUuid = entry.uuid;
      }
    }
    const last = out[out.length - 1];
    if (last && last.key.sessionId === key.sessionId && last.key.subpath === key.subpath) {
      last.entries.push(entry);
    } else {
      out.push({ key, entries: [entry] });
    }
  };
  // A pushed prompt joins the running query: only a send starts one.
  const boundaries = sends.filter((s) => s.ms < cutoff && (s as Send & { kind?: string }).kind !== 'push').map((s) => s.ms);
  let bi = 0;
  for (const a of appends.filter((x) => x.ms < cutoff)) {
    // A query started since the last append: with the parent, what is still
    // held belongs to an ended query and goes on a branch.
    while (bi < boundaries.length && (boundaries[bi] as number) <= a.ms) {
      if (parent && held) {
        branched.push(...held.map((h) => brief(h.entry)));
        for (const h of held) {
          if (typeof h.entry.uuid === 'string') {
            branchedIds.add(h.entry.uuid);
          }
        }
        held = null;
      }
      bi += 1;
    }
    for (const e of a.entries) {
      if (!isMain(a.key)) {
        commit(a.key, e);
        continue;
      }
      if (held) {
        held.push({ key: a.key, entry: e });
        if (isNonThinkingReply(e)) {
          for (const h of held) {
            commit(h.key, h.entry);
          }
          held = null;
        }
        continue;
      }
      if (isPrompt(e, texts)) {
        held = [{ key: a.key, entry: e }];
        continue;
      }
      commit(a.key, e);
    }
  }
  // The pickup itself ends the last query.
  const notCommitted = [...branched, ...(held ?? []).map((h) => brief(h.entry))];
  return { appends: out, notCommitted };
}

// Claude Code's own transcript for the main session, cut at the pickup: the
// first n lines, n = how many of its lines the run's transcript watch saw
// before it.
function own(rawDir: string, sessionId: string, cutoff: number): Holding | undefined {
  const ev = lines(join(rawDir, 'cancel-events.jsonl'));
  const fileEv = ev.find((e) => e.src === 'transcript' && e.kind === 'file' && String(e.file).endsWith(`${sessionId}.jsonl`));
  if (!fileEv) {
    return undefined;
  }
  const rel = `${sessionId}.jsonl`;
  // The watch numbers lines across all files it watches; a file's own line
  // count is how many of its lines it saw.
  const n = ev.filter((e) => e.src === 'transcript' && e.kind === 'line' && String(e.file).endsWith(rel) && Number(e.ms) < cutoff).length;
  const path = String(fileEv.file);
  if (!existsSync(path) || n === 0) {
    return undefined;
  }
  const cut = (p: string, k: number): Json[] =>
    readFileSync(p, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .slice(0, k)
      .map((l) => JSON.parse(l) as Json);
  const appends: Holding['appends'] = [{ key: { projectKey: 'own', sessionId }, entries: cut(path, n) }];
  // Subagent transcripts: <session>/subagents/agent-*.jsonl, the store's
  // subpath "subagents/agent-*".
  const subDir = join(path.replace(/\.jsonl$/, ''), 'subagents');
  const subs = new Map<string, number>();
  for (const e of ev) {
    const m = /\/subagents\/(agent-[^/]+)\.jsonl$/.exec(String(e.file));
    if (e.src === 'transcript' && e.kind === 'line' && String(e.file).includes(`${sessionId}/subagents/`) && m && Number(e.ms) < cutoff) {
      subs.set(m[1] as string, (subs.get(m[1] as string) ?? 0) + 1);
    }
  }
  for (const [name, k] of subs) {
    const p = join(subDir, `${name}.jsonl`);
    if (existsSync(p) && k > 0) {
      appends.push({ key: { projectKey: 'own', sessionId, subpath: `subagents/${name}` }, entries: cut(p, k) });
    }
  }
  return { appends };
}

// ---------------------------------------------------------------------------

interface Row {
  scenario: string;
  rep: number;
  main: string;
  mainRaw: string;
  sessionId: string;
  mainError: string | null;
  resumes: { label: string; chain: string | null; source: string; at: string | null; dir: string; raw: string; error: string | null }[];
}

function pickRows(): Row[] {
  const idx: { file: string; rows: Row[] }[] = [];
  for (const d of INDEX_DIRS) {
    for (const f of readdirSync(d).filter((x) => x.startsWith('cancel-index-') && x.endsWith('.json'))) {
      idx.push({ file: f.replace(/^cancel-index-cancel-sdk(-d)?-/, ''), rows: JSON.parse(readFileSync(join(d, f), 'utf8')) as Row[] });
    }
  }
  idx.sort((a, b) => a.file.localeCompare(b.file));
  const best = new Map<string, Row>();
  for (const { rows } of idx) {
    for (const r of rows) {
      // Later indexes win among rep 1; another rep only while no rep 1.
      const cur = best.get(r.scenario);
      if (!cur || r.rep === 1 || (cur.rep !== 1 && r.rep <= cur.rep)) {
        best.set(r.scenario, r);
      }
    }
  }
  return [...best.values()];
}

function stepsOf(runDir: string | undefined): { text: string }[] {
  if (!runDir) {
    return [];
  }
  const p = join(runDir, 'cancel-plan.json');
  return existsSync(p) ? ((JSON.parse(readFileSync(p, 'utf8')) as Json).steps as { text: string }[]) : [];
}

interface Pickup {
  scenario: string;
  rep: number;
  sessionId: string;
  point: string;
  probe: string;
  options: ReturnType<typeof scenarioOptions>;
  refs: { kind: string; file: string }[];
  holdings: Record<string, string>; // rule -> holding id
  notCommitted: Record<string, string[]>;
}

function main(): void {
  const out = process.argv[2];
  if (!out) {
    process.stderr.write('usage: plan.mts <out-dir>\n');
    process.exit(2);
  }
  const hdir = join(out, 'holdings');
  mkdirSync(hdir, { recursive: true });
  const seen = new Map<string, string>();
  // What load() returns is per key (main, each subpath), in order: two
  // holdings with the same entries per key are one holding.
  const save = (h: Holding): string => {
    const byKey = new Map<string, { key: Key; entries: Json[] }>();
    for (const a of h.appends) {
      const k = a.key.subpath ?? '';
      const cur = byKey.get(k) ?? { key: { projectKey: 'tower', sessionId: a.key.sessionId, ...(a.key.subpath ? { subpath: a.key.subpath } : {}) }, entries: [] };
      cur.entries.push(...a.entries);
      byKey.set(k, cur);
    }
    const norm = [...byKey.values()];
    const s = JSON.stringify(norm) + (h.resumeSessionAt ?? '');
    const id = createHash('sha256').update(s).digest('hex').slice(0, 16);
    if (!seen.has(id)) {
      writeFileSync(join(hdir, `${id}.json`), JSON.stringify({ appends: norm, resumeSessionAt: h.resumeSessionAt ?? null }));
      seen.set(id, id);
    }
    return id;
  };
  const pickups: Pickup[] = [];
  const addPickup = (row: Row, point: string, probe: string, appends: Append[], sends: Send[], cutoff: number, refs: { kind: string; file: string }[], ownH: Holding | undefined): void => {
    const holdings: Record<string, string> = {};
    const notCommitted: Record<string, string[]> = {};
    const base: Record<string, Holding> = { R0: r0(appends, cutoff), H: hold(appends, sends, cutoff, false), Hp: hold(appends, sends, cutoff, true), Hl: hold(appends, sends, cutoff, true, true) };
    for (const [name, h] of Object.entries(base)) {
      holdings[name] = save(h);
      holdings[`${name}@`] = save({ ...h, resumeSessionAt: lastUuid(h) });
      if (h.notCommitted && h.notCommitted.length > 0) {
        notCommitted[name] = h.notCommitted;
      }
    }
    if (ownH) {
      holdings.OWN = save(ownH);
      holdings['OWN@'] = save({ ...ownH, resumeSessionAt: lastUuid(ownH) });
    }
    pickups.push({ scenario: row.scenario, rep: row.rep, sessionId: row.sessionId, point, probe, options: scenarioOptions(row.scenario, row.main), refs, holdings, notCommitted });
  };

  for (const row of pickRows()) {
    if (!existsSync(join(row.mainRaw, 'store-appends.jsonl'))) {
      process.stderr.write(`skip ${row.scenario}: no raw appends\n`);
      continue;
    }
    const appends = appendsOf(row.mainRaw).filter((a) => a.key.sessionId === row.sessionId);
    const sends = sendsOf(row.mainRaw);
    // P<s>
    const realSends = sends.filter((x) => (x as Send & { kind?: string }).kind === 'send');
    for (const s of realSends.filter((x) => x.step >= 1)) {
      const next = realSends.find((x) => x.ms > s.ms);
      const live = findRequest(row.mainRaw, s.ms, s.text, next?.ms);
      addPickup(row, `P${s.step}`, s.text, appends, sends, s.ms, live ? [{ kind: 'live', file: live }] : [], own(row.mainRaw, row.sessionId, s.ms));
    }
    // end
    const first = row.resumes.find((r) => !r.chain && stepsOf(r.dir).length > 0);
    const probe = first ? (stepsOf(first.dir)[0] as { text: string }).text : AGAIN;
    const refs: { kind: string; file: string }[] = [];
    for (const r of row.resumes.filter((x) => !x.chain)) {
      const steps = stepsOf(r.dir);
      if (steps.length === 0 || (steps[0] as { text: string }).text !== probe) {
        continue;
      }
      const f = findRequest(r.raw, 0, probe);
      if (f && r.source === 'transcript') {
        refs.push({ kind: `recorded-${r.label}`, file: f });
      }
      if (f && r.source === 'store' && row.scenario.startsWith('D9-store')) {
        refs.push({ kind: `recorded-${r.label}`, file: f });
      }
    }
    addPickup(row, 'end', probe, appends, sends, Number.POSITIVE_INFINITY, refs, own(row.mainRaw, row.sessionId, Number.POSITIVE_INFINITY));
    // end2 (D9 store: main + the killed store resume's appends)
    if (row.scenario.startsWith('D9-store')) {
      const r1 = row.resumes.find((r) => r.label === 'store-killed');
      const r2 = row.resumes.find((r) => r.label === 'store-killed-then-store');
      if (r1 && r2) {
        const a2 = [...appends, ...appendsOf(r1.raw).filter((a) => a.key.sessionId === row.sessionId)];
        const s2 = [...sends, ...sendsOf(r1.raw)];
        const p2 = (stepsOf(r2.dir)[0] as { text: string }).text;
        const f = findRequest(r2.raw, 0, p2);
        addPickup(row, 'end2', p2, a2, s2, Number.POSITIVE_INFINITY, f ? [{ kind: 'recorded-store-killed-then-store', file: f }] : [], undefined);
      }
    }
  }
  writeFileSync(join(out, 'pickups.json'), `${JSON.stringify(pickups, null, 1)}\n`);
  // Distinct jobs: (holding, probe, options).
  const jobs = new Map<string, Json>();
  for (const p of pickups) {
    for (const [rule, h] of Object.entries(p.holdings)) {
      const id = createHash('sha256')
        .update(JSON.stringify([h, p.probe, p.options, p.sessionId]))
        .digest('hex')
        .slice(0, 16);
      if (!jobs.has(id)) {
        jobs.set(id, { id, holding: h, probe: p.probe, options: p.options, sessionId: p.sessionId, first: `${p.scenario}/${p.point}/${rule}` });
      }
    }
  }
  writeFileSync(join(out, 'jobs.json'), `${JSON.stringify([...jobs.values()], null, 1)}\n`);
  process.stdout.write(`${pickups.length} pickups, ${seen.size} holdings, ${jobs.size} jobs -> ${out}\n`);
}

main();
