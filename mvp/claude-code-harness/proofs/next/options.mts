// Proof 24: option by ending. Reads analyse.mts output (JSON lines) and
// writes, for each option and ending, per model: the history test and the
// resume test against Claude Code's live next query (L), counting only runs
// that reached their ending.
//
//   node proofs/next/options.mts <analysis.jsonl> [...] > runs/p24-options.md

import { readFileSync } from 'node:fs';
import type { Json } from './history.mts';

// Option: [label, the holding way whose resume it is, commit timing, what the
// history test reads].
const OPTIONS: [string, string, string][] = [
  ['A write, all entries, plain resume', 'store', 'write'],
  ['B write, all entries, resumeSessionAt', 'store,resumeSessionAt-last', 'write'],
  ['C write, all entries, load() adds an unsent attachment', 'store+prompt_snapshot', 'write'],
  ['D result, fold, plain resume', 'store+fold', 'result'],
  ['E result or next query or hybrid-strict, fold, resumeSessionAt', 'fold,resumeSessionAt-last', 'result / next / hybrid'],
  ['F result, fold, load() adds an unsent attachment', 'fold+prompt_snapshot', 'result'],
  ['G hybrid, fold + API error entries carried unshown, plain resume', 'fold+errors', 'hybrid'],
  ['H hybrid, fold + API error entries carried unshown, resumeSessionAt', 'fold+errors,resumeSessionAt-last', 'hybrid'],
  ['I hybrid, fold + API error entries carried unshown, load() adds prompt_snapshot', 'fold+errors+prompt_snapshot', 'hybrid'],
  ['I2 as I, credential_org', 'fold+errors+credential_org', 'hybrid'],
  ['J as G without the marker', 'fold+errors-marker', 'hybrid'],
  ['K as G without the partial reply', 'fold+errors-partial', 'hybrid'],
  ['L as G without partial and marker', 'fold+errors-partial-marker', 'hybrid'],
  ['M as K, load() adds prompt_snapshot', 'fold+errors-partial+prompt_snapshot', 'hybrid'],
  ['N as G with --reply-on-resume', 'fold+errors,reply-on-resume', 'hybrid'],
  ['O SDK reader', 'sdk-reader', 'result'],
  ['P SDK events', 'sdk-events', 'result'],
];

const ENDINGS = ['normal', 'thinking-only', 'limit', 'api-error', 'first-byte', 'thinking', 'mid-text', 'tool-input', 'tool-exec'];

function reached(r: Json): boolean {
  const truth = (r.truthBefore as string[] | null) ?? [];
  const store = (r.ways as Json[]).find((w) => w.way === 'store');
  const extra = ((store?.extra as string[] | undefined) ?? []).join(' ');
  const stopped = String(r.stopped);
  switch (r.cell) {
    case 'thinking-only':
      return truth.some((b) => b.includes('no visible o'));
    case 'limit':
      return extra.includes('API Error');
    case 'api-error':
      return extra.includes('Request timed out') && (truth[truth.length - 1] ?? '').startsWith('user');
    case 'normal':
      return true;
    default:
      return stopped !== 'no stop' && !stopped.startsWith('finished');
  }
}

function resumeVerdict(r: Json, w: Json): string {
  const L = r.L as Json | null;
  const lu = (L?.usage as Json | null) ?? null;
  const tu = ((w.T as Json | null)?.usage as Json | null) ?? null;
  const diff = (w.requestDiff as string[] | undefined) ?? null;
  if (!w.T || !tu || diff === null) {
    return '?';
  }
  if (diff.length > 0) {
    const adds = (w.resumeAdds as string[] | undefined) ?? [];
    const tot = lu ? Number(tu.cache_read_input_tokens) + Number(tu.cache_creation_input_tokens) + Number(tu.input_tokens) - (Number(lu.cache_read_input_tokens) + Number(lu.cache_creation_input_tokens) + Number(lu.input_tokens)) : null;
    return `DIFF${adds.some((a) => a.includes('No response')) ? '(NRR)' : ''}${tot !== null ? `${tot >= 0 ? '+' : ''}${tot}` : ''}`;
  }
  if (!lu) {
    return 'REQ'; // same request; L's request failed, so no usage to compare
  }
  const read = Number(tu.cache_read_input_tokens);
  const want = Number(lu.cache_read_input_tokens) + Number(lu.cache_creation_input_tokens);
  if (read === want && Number(tu.cache_creation_input_tokens) === 0) {
    return 'OK';
  }
  return `REQ,cache${read - want >= 0 ? '+' : ''}${read - want}r/${String(tu.cache_creation_input_tokens)}w`;
}

function historyVerdict(w: Json): string {
  return w.history === 'exact' ? '=' : w.history === 'equal but trailing newline' ? '=nl' : w.history === 'differs' ? 'x' : '?';
}

function main(): void {
  const rows = process.argv
    .slice(2)
    .flatMap((f) => readFileSync(f, 'utf8').split('\n').filter((l) => l.trim() !== ''))
    .map((l) => JSON.parse(l) as Json)
    .filter((r) => !r.error && !r.failed && Array.isArray(r.ways));
  const models = [...new Set(rows.map((r) => String(r.model)))].sort();
  const out: string[] = [];
  out.push('Cell: per model, one entry per run that reached the ending, `history/resume`.');
  out.push('history: `=` exact, `=nl` same blocks but the marker lacks the trailing newline Claude Code adds when it merges it with the next prompt, `x` differs.');
  out.push('resume: `OK` same request as L and T read everything L read and wrote, writing 0; `REQ` same request, L failed (API error ending) so no usage; `REQ,cache±Nr/Mw` same request, cache differs by N read tokens; `DIFF(NRR)±N` different request, "No response requested." inserted, N more tokens in total; `DIFF±N` different request.');
  out.push('');
  for (const [label, way, timing] of OPTIONS) {
    out.push(`### ${label}`);
    out.push(`commit: ${timing}; holding: \`${way}\``);
    out.push('');
    out.push(`| ending | ${models.map((m) => m.replace('claude-', '')).join(' | ')} |`);
    out.push(`|---|${models.map(() => '---').join('|')}|`);
    for (const e of ENDINGS) {
      const cells = models.map((m) => {
        const rs = rows.filter((r) => r.model === m && r.cell === e && reached(r));
        if (rs.length === 0) {
          return 'not reached';
        }
        return rs
          .map((r) => {
            const w = (r.ways as Json[]).find((x) => x.way === way);
            if (!w) {
              return 'n/a';
            }
            // The API error entries carried unshown: the history test reads the fold.
            const hw = way === 'fold+errors,resumeSessionAt-last' || way === 'fold+errors,reply-on-resume' ? ((r.ways as Json[]).find((x) => x.way === 'fold+errors') ?? w) : w;
            return `${historyVerdict(hw)}/${resumeVerdict(r, w)}`;
          })
          .join(' ');
      });
      out.push(`| ${e} | ${cells.join(' | ')} |`);
    }
    out.push('');
  }
  process.stdout.write(`${out.join('\n')}\n`);
}

main();
