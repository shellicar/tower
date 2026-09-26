// Reading live runs: resumed first requests side by side, and what each
// approach published in a seed against what Claude Code actually sent.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newMessages } from './by-body.mts';
import { describe } from './check.mts';
import { mainRequests, readJsonl, type Request } from './corpus.mts';
import { type ApiMessage, type Block, blocksOf, type Json, stripCacheControl } from './form.mts';

// Raw JSON with only cache_control stripped; thinking text is redacted in
// the logged bodies, so it compares by signature.
function rawKey(m: ApiMessage): string {
  const content =
    typeof m.content === 'string'
      ? m.content
      : m.content.map((b) => {
          const kept = stripCacheControl(b);
          if (kept.type === 'thinking') {
            const { thinking: _t, ...rest } = kept;
            return rest;
          }
          return kept;
        });
  return JSON.stringify({ role: m.role, content });
}

function looseKey(m: ApiMessage): string {
  return rawKey({ role: m.role, content: blocksOf(m.content) });
}

function usageLine(r: Request): string {
  const u = (r.response?.usage as Json | undefined) ?? {};
  return `thread=${JSON.stringify(r.body.thread ?? null)} messages=${r.body.messages.length} tools=${Array.isArray(r.body.tools) ? (r.body.tools as unknown[]).length : 'absent'} | input ${String(u.input_tokens)} cache_read ${String(u.cache_read_input_tokens)} cache_write ${String(u.cache_creation_input_tokens)}`;
}

function firstDiff(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) {
    i += 1;
  }
  return `at char ${i}: …${JSON.stringify(a.slice(Math.max(0, i - 40), i + 80))} | …${JSON.stringify(b.slice(Math.max(0, i - 40), i + 80))}`;
}

export function compare(dirs: string[]): string {
  const out: string[] = [];
  const runs = dirs.map((d) => ({ d, reqs: mainRequests(d), meta: existsSync(join(d, 'resume.json')) ? (JSON.parse(readFileSync(join(d, 'resume.json'), 'utf8')) as Json) : {} }));
  for (const r of runs) {
    out.push(`-- ${String(r.meta.source ?? '?')} ${r.d}`);
    for (const q of r.reqs) {
      out.push(`   index.jsonl line ${q.line} ${q.file}: ${usageLine(q)}`);
    }
  }
  const base = runs[0];
  const a = base?.reqs[0];
  if (!base || !a) {
    return `${out.join('\n')}\n`;
  }
  for (const r of runs.slice(1)) {
    const b = r.reqs[0];
    out.push(`\n== first request: ${String(base.meta.source ?? '?')} ${a.file} vs ${String(r.meta.source ?? '?')} ${b?.file ?? '(none)'}`);
    if (!b) {
      continue;
    }
    const sysKey = (q: Request): string => JSON.stringify(((q.body.system as Block[] | undefined) ?? []).slice(1).map(stripCacheControl));
    out.push(`   system (after the billing header): ${sysKey(a) === sysKey(b) ? 'same' : `DIFFER ${firstDiff(sysKey(a), sysKey(b))}`}`);
    out.push(`   tools: ${JSON.stringify(a.body.tools ?? null) === JSON.stringify(b.body.tools ?? null) ? 'same' : 'DIFFER'}`);
    for (const k of ['thinking', 'context_management', 'output_config', 'max_tokens', 'betas']) {
      out.push(`   ${k}: ${JSON.stringify(a.body[k]) === JSON.stringify(b.body[k]) ? 'same' : `DIFFER ${JSON.stringify(a.body[k])} vs ${JSON.stringify(b.body[k])}`}`);
    }
    const n = Math.max(a.body.messages.length, b.body.messages.length);
    let first = -1;
    for (let i = 0; i < n; i += 1) {
      const ma = a.body.messages[i];
      const mb = b.body.messages[i];
      const same = ma !== undefined && mb !== undefined && rawKey(ma) === rawKey(mb);
      const loose = ma !== undefined && mb !== undefined && looseKey(ma) === looseKey(mb);
      if (!same && first < 0) {
        first = i;
      }
      out.push(`   [${i}] ${same ? 'same' : loose ? 'SHAPE (string vs one text block)' : 'DIFF'}  ${ma ? `${ma.role}: ${describe(blocksOf(ma.content))}` : '(none)'}`);
      if (!same) {
        out.push(`        vs ${mb ? `${mb.role}: ${describe(blocksOf(mb.content))}` : '(none)'}`);
        if (ma && mb && !loose) {
          out.push(`        ${firstDiff(rawKey(ma), rawKey(mb))}`);
        }
      }
    }
    out.push(first < 0 ? '   messages identical (cache_control aside)' : `   first difference at messages[${first}]`);
    const whole = (q: Request): string => JSON.stringify({ ...q.body, metadata: undefined, messages: q.body.messages.map((m) => rawKey(m)), system: sysKey(q) });
    out.push(`   whole body (metadata and cache_control aside): ${whole(a) === whole(b) ? 'identical' : 'differs'}`);
  }
  return `${out.join('\n')}\n`;
}

const key = (m: { role: string; content: Block[] }): string => JSON.stringify({ role: m.role, content: m.content });

function stats(xs: number[]): string {
  if (xs.length === 0) {
    return 'none';
  }
  const s = [...xs].sort((p, q) => p - q);
  return `n=${s.length} min ${s[0]} median ${s[Math.floor(s.length / 2)]} max ${s[s.length - 1]} ms`;
}

export function liveReport(seedDir: string): string {
  const out: string[] = [];
  const reqs = mainRequests(seedDir);
  const signals = readJsonl(join(seedDir, 'signals.jsonl'));
  const index = readJsonl(join(seedDir, 'api-bodies', 'index.jsonl'));
  for (const label of ['A', 'B']) {
    const published = readJsonl(join(seedDir, `published-${label}.jsonl`)).filter((p) => String(p.subject).endsWith('changes.message'));
    const byId = new Map(published.map((p) => [String((p.body as Json).id), p.body as Json]));
    out.push(`== ${label}: ${published.length} changes.message published`);
    for (const r of reqs) {
      const actual = newMessages(r.body);
      const sig = signals.find((s) => s.approach === label && (label === 'A' ? s.file === r.file : s.msgId === r.messageId));
      if (!sig) {
        out.push(`   ${r.file.slice(0, 8)}: no ${label} signal`);
        continue;
      }
      const placed = (sig.placed as Json[]).map((p) => (p.entries as string[])[0]);
      const forms = (sig.placed as Json[]).map((p) => {
        const ids = p.entries as string[];
        return [...byId.values()].find((b) => ((b.ccEntries as Json[] | undefined) ?? []).some((c) => ids.includes(String(c.uuid))));
      });
      const same = forms.length === actual.length && forms.every((f, i) => f !== undefined && key({ role: String(f.role), content: f.content as Block[] }) === key(actual[i] as { role: string; content: Block[] }));
      out.push(`   ${r.file.slice(0, 8)} (index line ${r.line}): sent ${actual.length} new message(s); ${label} published ${forms.length}: ${same ? 'IDENTICAL' : 'DIFFERENT'}${placed.length ? '' : ''}`);
      if (!same) {
        actual.forEach((m, i) => {
          const f = forms[i];
          out.push(`      [${i}] sent      ${m.role}: ${describe(m.content)}`);
          out.push(`          published ${f ? `${String(f.role)}: ${describe(f.content as Block[])}` : '(none)'}`);
        });
      }
      if (label === 'A' && ((sig.uncovered as Json[]).length > 0 || (sig.unplaced as Json[]).length > 0)) {
        out.push(`      uncovered ${JSON.stringify(sig.uncovered).slice(0, 300)}; unplaced ${JSON.stringify(sig.unplaced).slice(0, 300)}`);
      }
    }
    const timing = readJsonl(join(seedDir, `timing-${label}.jsonl`));
    const um = timing.filter((t) => t.role === 'user' || t.role === 'system');
    const am = timing.filter((t) => t.role === 'assistant');
    out.push(`   timing: user/system message published after its last entry was appended: ${stats(um.map((t) => Number(t.waitAfterLastEntryMs)))}`);
    out.push(`           signal (${label === 'A' ? 'request file seen' : 'message_start'}) after the last entry was appended: ${stats(um.map((t) => Number(t.signalAfterLastEntryMs)))}`);
    out.push(`           assistant piece published after its entry was appended: ${stats(am.map((t) => Number(t.waitAfterAppendMs)))}`);
    for (const t of timing.filter((x) => x.released)) {
      out.push(`   released without publishing: ${JSON.stringify(t)}`);
    }
  }
  // When each request file was written against when its response started.
  out.push('== request file mtime vs message_start (signals.jsonl)');
  for (const r of reqs) {
    const a = signals.find((s) => s.approach === 'A' && s.file === r.file);
    const b = signals.find((s) => s.approach === 'B' && s.msgId === r.messageId);
    const i = index.find((x) => x.request_file === r.file);
    if (a && b) {
      out.push(`   ${r.file.slice(0, 8)}: file written ${String(a.fileMtime)}, seen ${String(a.seenAt)}, message_start ${String(b.streamAt)}, response done ${String(i?.timestamp)}`);
    }
  }
  return `${out.join('\n')}\n`;
}
