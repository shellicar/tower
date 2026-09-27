// Offline checks over recorded runs: approach A's attribution and approach
// B's prediction against the request bodies Claude Code logged, request by
// request, and whether each form carries what load() needs to rebuild the
// entries.

import { attribute, newMessages } from './by-body.mts';
import { type FoldSettings, predict, settingsForModel } from './by-fold.mts';
import { groups, mainRequests, runEntries, sessionIdOf } from './corpus.mts';
import { type Block, blocksOf, type FormMessage, isCarrier, type Json, rebuild, renderedTexts, type TowerMessage } from './form.mts';

export function settingsFor(model: string, _entriesSoFar: Json[]): FoldSettings & { from: string } {
  const s = settingsForModel(model);
  return { ...s, from: `model table (${model}${s.known ? '' : ', unknown'})` };
}

const key = (m: { role: string; content: Block[] }): string => JSON.stringify({ role: m.role, content: m.content });

function short(s: string, n = 100): string {
  return JSON.stringify(s.length > n ? `${s.slice(0, n)}…` : s);
}

export interface RunCheck {
  run: string;
  entriesFrom: string;
  requests: number;
  aClean: number;
  aIssues: string[];
  aRoundTrip: string[];
  bMatch: number;
  bIssues: string[];
  bRules: Set<string>;
  types: Map<string, Set<string>>;
}

// What load() rebuilds from a form message, compared with the entries it came
// from: each attachment's type, payload and rendered text; each user entry's
// content and isMeta.
function roundTrip(form: FormMessage, originals: Map<string, Json>): string[] {
  const issues: string[] = [];
  const tm: TowerMessage = { id: 'x', ts: 't', turnId: 't', role: form.role, content: form.content, ccEntries: form.ccEntries };
  for (const r of rebuild([tm], new Map(), '', '')) {
    const o = originals.get(String(r.uuid));
    if (!o) {
      issues.push(`rebuilt ${String(r.uuid)} has no original`);
      continue;
    }
    if (r.type !== o.type) {
      issues.push(`${String(r.uuid)} type ${String(r.type)} was ${String(o.type)}`);
    }
    if (o.type === 'attachment') {
      if (JSON.stringify(r.attachment) !== JSON.stringify(o.attachment)) {
        issues.push(`${String(r.uuid)} attachment differs`);
      }
      const a = JSON.stringify(renderedTexts(r));
      const b = JSON.stringify(renderedTexts(o));
      if (a !== b) {
        issues.push(`${String((o.attachment as Json).type)} ${String(r.uuid).slice(0, 8)} rendered ${short(a, 60)} was ${short(b, 60)}`);
      }
    } else {
      const a = JSON.stringify(blocksOf((r.message as Json).content));
      const b = JSON.stringify(blocksOf((o.message as Json).content));
      if (a !== b) {
        issues.push(`user ${String(r.uuid).slice(0, 8)} content ${short(a, 60)} was ${short(b, 60)}`);
      }
      if ((r.isMeta === true) !== (o.isMeta === true)) {
        issues.push(`user ${String(r.uuid).slice(0, 8)} isMeta differs`);
      }
    }
  }
  return issues;
}

export function checkRun(runDir: string): RunCheck {
  const sessionId = sessionIdOf(runDir);
  const { entries, source } = runEntries(runDir, sessionId);
  const requests = mainRequests(runDir);
  const out: RunCheck = { run: runDir, entriesFrom: source, requests: 0, aClean: 0, aIssues: [], aRoundTrip: [], bMatch: 0, bIssues: [], bRules: new Set(), types: new Map() };
  const originals = new Map(entries.filter((e) => typeof e.uuid === 'string').map((e) => [String(e.uuid), e]));
  let carried: Json[] = [];
  const main = entries.filter((e) => e.isSidechain !== true);
  for (const g of groups(entries, requests)) {
    out.requests += 1;
    const label = `line ${g.request.line} ${g.request.file.slice(0, 8)}`;
    const actual = newMessages(g.request.body);
    // A
    const pendingA = [...carried, ...g.pending.filter((e) => !carried.includes(e))];
    const a = attribute(g.request.body, pendingA);
    carried = a.unplaced;
    const aProblems = [
      ...a.uncovered.map((u) => `${label} messages+${u.message} block ${u.block}: no entry accounts for ${short(u.text)}`),
      ...a.unplaced.map((e) => `${label}: ${String(e.type)}/${String((e.attachment as Json | undefined)?.type ?? (e.isMeta ? 'isMeta' : 'user'))} ${String(e.uuid).slice(0, 8)} not found in this request (kept pending)`),
      ...a.notes.map((n) => `${label}: ${n}`),
    ];
    if (aProblems.length === 0) {
      out.aClean += 1;
    }
    out.aIssues.push(...aProblems);
    for (const m of a.messages) {
      out.aRoundTrip.push(...roundTrip(m, originals).map((s) => `${label}: ${s}`));
      for (const c of m.ccEntries) {
        const t = c.type === 'attachment' ? String((c.attachment as Json).type) : c.isMeta ? 'user isMeta' : 'user';
        out.types.set(t, (out.types.get(t) ?? new Set()).add(m.role));
      }
    }
    // B: from the entries alone, with the model the host asked for.
    const s = settingsFor(g.request.model, main.slice(0, g.at));
    const b = predict(g.pending, s);
    for (const r of b.rules) {
      out.bRules.add(r);
    }
    const same = b.messages.length === actual.length && b.messages.every((m, i) => key(m) === key(actual[i] as { role: string; content: Block[] }));
    if (same) {
      out.bMatch += 1;
    } else {
      out.bIssues.push(`${label} (${s.from}: systemTurns ${s.systemTurns}): predicted ${b.messages.length} message(s), sent ${actual.length}`);
      const n = Math.max(b.messages.length, actual.length);
      for (let i = 0; i < n; i += 1) {
        const p = b.messages[i];
        const q = actual[i];
        if (p && q && key(p) === key(q)) {
          out.bIssues.push(`    [${i}] same ${p.role}`);
          continue;
        }
        out.bIssues.push(`    [${i}] predicted ${p ? `${p.role}: ${describe(p.content)}` : '(none)'}`);
        out.bIssues.push(`         sent      ${q ? `${q.role}: ${describe(q.content)}` : '(none)'}`);
        if (p && q) {
          const x = key(p);
          const y = key(q);
          let k = 0;
          while (k < x.length && x[k] === y[k]) {
            k += 1;
          }
          out.bIssues.push(`         first difference at char ${k}: predicted …${short(x.slice(Math.max(0, k - 30), k + 60), 100)} sent …${short(y.slice(Math.max(0, k - 30), k + 60), 100)}`);
        }
      }
      const carriers = g.pending.filter(isCarrier);
      out.bIssues.push(`    entries: ${carriers.map((e) => `${String(e.type)}/${String((e.attachment as Json | undefined)?.type ?? (e.isMeta ? 'isMeta' : 'user'))}`).join(', ')}`);
    }
  }
  return out;
}

export function describe(content: Block[]): string {
  return content
    .map((b) => {
      if (b.type === 'text') {
        const t = String(b.text);
        const n = (t.match(/<system-reminder>/g) ?? []).length;
        return `text${n ? ` reminders(${n})` : ''} ${short(t.replace(/<\/?system-reminder>\n?/g, '').trim(), 50)}`;
      }
      if (b.type === 'tool_result') {
        return `tool_result ${String(b.tool_use_id).slice(-6)}`;
      }
      return String(b.type);
    })
    .join(' | ');
}

export function report(c: RunCheck): string {
  const lines = [
    `== ${c.run}`,
    `   entries from ${c.entriesFrom}; ${c.requests} main-thread request(s) paired with entries`,
    `   A: ${c.aClean}/${c.requests} requests fully accounted for; round trip ${c.aRoundTrip.length === 0 ? 'exact' : `${c.aRoundTrip.length} difference(s)`}`,
    ...c.aIssues.map((s) => `      A ${s}`),
    ...c.aRoundTrip.map((s) => `      A round trip ${s}`),
    `   B: ${c.bMatch}/${c.requests} requests predicted exactly; rules used ${[...c.bRules].join(' ')}`,
    ...c.bIssues.map((s) => `      B ${s}`),
    `   types placed (A): ${[...c.types].map(([t, r]) => `${t}->${[...r].join('/')}`).join(', ')}`,
  ];
  return `${lines.join('\n')}\n`;
}
