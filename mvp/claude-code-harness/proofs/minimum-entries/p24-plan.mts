// Minimum entries: proof 24's recordings (four models, nine endings, round
// 0758 on 27 Sep, branch proof-24-next-query) as a commit-resume plan, so
// ablate.mts can take them like plan.mts's. One pickup per recording: just
// before the probe ("Reply with the word NEXT only."), holding R0@ = every
// main-session store append before the probe's send, resumed at the last
// main entry with a uuid.
//
// The live probe request is the reference only where it carries the whole
// history (thread create, or none). Where the live Claude Code continued a
// server-side thread (thread continue: a delta, no tools), a resume can't
// send it (it always creates); the ref is kept as `live-continue` and not
// compared.
//
// TODO: undecided, a harness normalisation. The recordings are from 27 Sep;
// run today, Claude Code's clock gives another date. The `date` attachment
// (its value and its rendered reminder) is rewritten to --date (the run's
// local date) in the holding, and the live
// reference's "Today's date is 2026-09-27." to the same date when compared
// (liveRewrite). The alternative is recording again on the run's date.
//
//   node proofs/minimum-entries/p24-plan.mts <out-dir> --date YYYY-MM-DD

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

type Json = Record<string, unknown>;
const RUNS = '/home/stephen/repos/@shellicar/tower/.claude/worktrees/proof-24-next-query/mvp/claude-code-harness/runs';
const INDEXES = ['p24-index-sonnet5-2026-09-27T075824168167Z.json', 'p24-index-opus55-2026-09-27T075824193257Z.json', 'p24-index-fable51-2026-09-27T075824276949Z.json', 'p24-index-haiku45-2026-09-27T075823738771Z.json'];
const PROBE = 'Reply with the word NEXT only.';
const RECORDED_DATE = '2026-09-27';

const lines = (p: string): Json[] =>
  existsSync(p)
    ? readFileSync(p, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as Json)
    : [];

function lastUserText(body: Json): string {
  const msgs = (body.messages ?? []) as Json[];
  const last = [...msgs].reverse().find((m) => m.role === 'user');
  const c = last?.content;
  if (typeof c === 'string') {
    return c;
  }
  return Array.isArray(c) ? (c as Json[]).map((b) => (typeof b.text === 'string' ? b.text : '')).join('\n') : '';
}

function main(): void {
  const out = process.argv[2];
  const args = process.argv.slice(3);
  const date = args.includes('--date') ? String(args[args.indexOf('--date') + 1]) : undefined;
  if (!out || !date) {
    process.stderr.write('usage: p24-plan.mts <out-dir> --date YYYY-MM-DD\n');
    process.exit(2);
  }
  mkdirSync(join(out, 'holdings'), { recursive: true });
  const pickups: Json[] = [];
  const jobs: Json[] = [];
  for (const idxFile of INDEXES) {
    const rows = JSON.parse(readFileSync(join(RUNS, idxFile), 'utf8')) as Json[];
    for (const r of rows) {
      const rawDir = String(r.rawDir);
      const sessionId = String(r.sessionId);
      const run = JSON.parse(readFileSync(join(isAbsolute(String(r.main)) ? String(r.main) : join(RUNS, String(r.main)), 'run.json'), 'utf8')) as Json;
      const o = run.options as Json;
      const ev = lines(join(rawDir, 'next-events.jsonl'));
      const send = ev.find((e) => e.src === 'proof' && e.kind === 'send' && Number(e.step) === 2);
      if (!send) {
        process.stderr.write(`skip ${String(r.model)} ${String(r.cell)}: no probe send\n`);
        continue;
      }
      const sendMs = Number(send.ms);
      // The probe's first request: the first main-model request after the
      // send whose last user message is the probe (the index's probeFile
      // names the title request on Haiku api-error).
      let live: string | undefined;
      let thread: string | null = null;
      for (const e of ev) {
        if (e.src !== 'bodies' || e.kind !== 'request' || Number(e.ms) < sendMs) {
          continue;
        }
        const f = join(rawDir, 'api-bodies', String(e.file));
        if (!existsSync(f)) {
          continue;
        }
        const body = JSON.parse(readFileSync(f, 'utf8')) as Json;
        if (body.model === o.model && lastUserText(body).includes(PROBE)) {
          live = f;
          thread = ((body.thread as Json | undefined)?.type as string | undefined) ?? null;
          break;
        }
      }
      const entries: Json[] = [];
      for (const a of lines(join(rawDir, 'store-appends.jsonl'))) {
        const key = a.key as Json;
        if (key.sessionId !== sessionId || key.subpath || Number(a.ms) >= sendMs) {
          continue;
        }
        for (const e of a.entries as Json[]) {
          // The date attachment's value and its rendered reminder (an
          // attachment entry carries the text Claude Code sends for it).
          const att = e.attachment as Json | undefined;
          entries.push(att?.type === 'date' ? (JSON.parse(JSON.stringify(e).split(`"date":"${RECORDED_DATE}"`).join(`"date":"${date}"`).split(`Today's date is ${RECORDED_DATE}.`).join(`Today's date is ${date}.`)) as Json) : e);
        }
      }
      let at: string | null = null;
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        if (typeof (entries[i] as Json).uuid === 'string') {
          at = String((entries[i] as Json).uuid);
          break;
        }
      }
      const holding = { appends: [{ key: { projectKey: 'tower', sessionId }, entries }], resumeSessionAt: at };
      const hid = createHash('sha256').update(JSON.stringify(holding)).digest('hex').slice(0, 16);
      writeFileSync(join(out, 'holdings', `${hid}.json`), JSON.stringify(holding));
      const cell = String(r.cell);
      const env: Record<string, string> = cell === 'limit' ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64' } : {};
      const options = { model: o.model, thinking: o.thinking, tools: o.tools, env, mcpWait: false, extra: { settings: o.settings } };
      const refs = live ? [{ kind: thread === 'continue' ? 'live-continue' : 'live', file: live }] : [];
      pickups.push({ scenario: cell, rep: 1, sessionId, point: 'P2', probe: PROBE, options, refs, holdings: { 'R0@': hid }, liveRewrite: [[`Today's date is ${RECORDED_DATE}.`, `Today's date is ${date}.`]], rawDir });
      jobs.push({ id: hid, holding: hid, probe: PROBE, options, sessionId, first: `${String(o.model)}/${cell}` });
    }
  }
  writeFileSync(join(out, 'pickups.json'), `${JSON.stringify(pickups, null, 1)}\n`);
  writeFileSync(join(out, 'jobs.json'), `${JSON.stringify(jobs, null, 1)}\n`);
  process.stdout.write(`${pickups.length} pickups -> ${out}\n`);
}

main();
