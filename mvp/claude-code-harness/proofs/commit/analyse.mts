// Proof 23: reads what run.mts recorded and reports, per cell:
//   - where the run actually stopped (each trigger races the stream)
//   - what Claude Code wrote (its transcript, and what the store got)
//   - what the next request's history kept (ground truth): after interrupt()
//     the probe's request in the same process; after an abort the probe's
//     request in each resume
//   - when each candidate signal fired, on one clock (epoch ms)
//
// Choices made for this report, not decisions (TODO: undecided):
//   - The reference instant for "how soon after Claude Code commits" is when
//     the kept piece's line reached Claude Code's transcript file (seen by a
//     5 ms poll). The absolute timeline is printed too, so any other
//     reference can be read off it.
//   - A request is main when it is on the cell's model and carries both
//     `thinking` and `thread` (the session title request carries neither).
//
//   node proofs/commit/analyse.mts <index.json> [...]   (writes next to it)

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Json = Record<string, unknown>;
interface Ev extends Json {
  ts: string;
  ms: number;
  src: string;
  kind: string;
}

const readJsonl = (p: string): Json[] =>
  existsSync(p)
    ? readFileSync(p, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as Json)
    : [];

const PROBE = 'Reply with the word NEXT only.';
const PROBE_AGAIN = 'Reply with the word AGAIN only.';
const MARK = '[Request interrupted by user';

interface RunData {
  dir: string;
  plan: Json;
  events: Ev[];
}

function load(dir: string): RunData {
  return { dir, plan: JSON.parse(readFileSync(join(dir, 'commit-plan.json'), 'utf8')) as Json, events: readJsonl(join(dir, 'commit-events.jsonl')) as Ev[] };
}

function sendMs(r: RunData, step: number): number | undefined {
  return r.events.find((e) => e.src === 'proof' && e.kind === 'send' && e.step === step)?.ms;
}

// ---------------------------------------------------------------------------
// Where it stopped: the stream's state for the latest main message when the
// stop was issued, and what still streamed after it.

interface StopState {
  at: number | undefined;
  how: string | undefined;
  messageStarts: number;
  blocks: { index: number; type: string; open: boolean; chars: number }[];
  preToolUse: boolean;
  postToolUse: boolean;
  actual: string;
  after: string[];
}

function stopState(r: RunData, step: number): StopState {
  const from = sendMs(r, step) ?? 0;
  const stop = r.events.find((e) => e.src === 'proof' && e.kind === 'stop');
  const at = stop?.ms;
  let blocks: StopState['blocks'] = [];
  let messageStarts = 0;
  let preToolUse = false;
  let postToolUse = false;
  const after: string[] = [];
  const next = sendMs(r, step + 1) ?? Infinity;
  for (const e of r.events) {
    if (e.ms < from || e.ms >= next) {
      continue;
    }
    const before = at === undefined || e.ms <= at;
    if (e.src === 'sdk' && e.kind.startsWith('stream:') && e.parent === null) {
      if (!before) {
        const tag = e.kind === 'stream:content_block_start' ? `${e.kind}(${String(e.block)})` : e.kind === 'stream:content_block_delta' ? `delta(${String(e.delta)})` : e.kind;
        if (after[after.length - 1] !== tag) {
          after.push(tag);
        }
        continue;
      }
      if (e.kind === 'stream:message_start') {
        messageStarts += 1;
        blocks = [];
      }
      if (e.kind === 'stream:content_block_start') {
        blocks.push({ index: Number(e.index), type: String(e.block), open: true, chars: 0 });
      }
      const b = blocks.find((x) => x.index === Number(e.index));
      if (e.kind === 'stream:content_block_delta' && b && e.delta !== 'signature_delta') {
        b.chars += Number(e.len ?? 0);
      }
      if (e.kind === 'stream:content_block_stop' && b) {
        b.open = false;
      }
    }
    if (before && e.src === 'hook' && e.kind === 'PreToolUse') {
      preToolUse = true;
    }
    if (before && e.src === 'hook' && e.kind === 'PostToolUse') {
      postToolUse = true;
    }
  }
  let actual = 'no stop';
  if (at !== undefined) {
    const open = blocks.find((b) => b.open);
    const last = blocks[blocks.length - 1];
    if (messageStarts === 0) {
      actual = 'first-byte';
    } else if (preToolUse && !postToolUse) {
      actual = 'tool-exec';
    } else if (open?.type === 'thinking') {
      actual = 'thinking';
    } else if (open?.type === 'text') {
      actual = 'mid-text';
    } else if (open?.type === 'tool_use') {
      actual = 'tool-input';
    } else if (last?.type === 'thinking' && !last.open) {
      actual = 'after-thinking';
    } else if (blocks.length === 0) {
      actual = 'after message_start, before any block';
    } else {
      actual = `other (${blocks.map((b) => `${b.type}${b.open ? '+' : '-'}`).join(',')})`;
    }
  }
  return { at, how: stop?.how as string | undefined, messageStarts, blocks, preToolUse, postToolUse, actual, after };
}

// ---------------------------------------------------------------------------
// What Claude Code wrote.

function contentText(content: unknown): string {
  if (!Array.isArray(content)) {
    return '';
  }
  return (content as Json[])
    .map((b) => {
      if (b.type === 'thinking') {
        return `thinking(${String(b.sig ?? '')},${String(b.thinkingLen ?? '?')}ch)`;
      }
      if (b.type === 'text' || b.type === 'string') {
        return `text(${String(b.textLen ?? String(b.text ?? '').length)}ch ${JSON.stringify(String(b.text ?? '').slice(0, 40))})`;
      }
      if (b.type === 'tool_use') {
        return `tool_use(${String(b.name)} ${String(b.id).slice(-6)} input ${String(b.inputLen)}ch)`;
      }
      if (b.type === 'tool_result') {
        return `tool_result(${String(b.tool_use_id).slice(-6)}${b.is_error ? ' error' : ''} ${String(b.content).slice(0, 60)})`;
      }
      return String(b.type);
    })
    .join(' + ');
}

function entryLine(e: Json): string {
  const flags = ['isMeta', 'isApiErrorMessage', 'isAbortedMidStream'].filter((k) => e[k]).join(',');
  const kind = e.attachment ? `attachment:${String(e.attachment)}` : e.subtype ? `${String(e.type)}:${String(e.subtype)}` : String(e.type);
  return `${kind}${flags ? ` [${flags}]` : ''}${e.stop_reason !== undefined && e.stop_reason !== null ? ` stop=${String(e.stop_reason)}` : ''} ${contentText(e.content)}`.trim();
}

const NOISE = new Set(['queue-operation', 'last-prompt', 'ai-title', 'atis-latch', 'cost-state', 'mode', 'custom-title']);

interface Written {
  lines: { ms: number; entry: Json }[];
  storeUuids: Set<string>;
  storeMs: Map<string, number>;
}

function written(r: RunData, from: number, to: number): Written {
  const lines = r.events.filter((e) => e.src === 'transcript' && e.kind === 'line' && e.ms >= from && e.ms < to).map((e) => ({ ms: e.ms, entry: e.entry as Json }));
  const storeUuids = new Set<string>();
  const storeMs = new Map<string, number>();
  for (const e of r.events) {
    if (e.src === 'store' && e.kind === 'append' && !(e.key as Json).subpath) {
      for (const x of e.entries as Json[]) {
        if (typeof x.uuid === 'string') {
          storeUuids.add(x.uuid);
          if (!storeMs.has(x.uuid)) {
            storeMs.set(x.uuid, e.ms);
          }
        }
      }
    }
  }
  return { lines, storeUuids, storeMs };
}

// ---------------------------------------------------------------------------
// The next request's history.

interface Kept {
  run: string;
  file: string;
  seenMs: number;
  thread: string;
  lines: string[];
  prompt: string;
  thinkingSigs: string[];
  textChars: number;
  toolUses: string[];
  toolResults: string[];
  markers: string[];
}

const isReminder = (t: string): boolean => t.startsWith('<system-reminder>');

function blockLine(b: Json): string {
  if (b.type === 'text') {
    const t = String(b.text);
    return isReminder(t) ? 'reminder' : `text(${t.length}ch ${JSON.stringify(t.slice(0, 50))})`;
  }
  if (b.type === 'thinking') {
    return `thinking(${String(b.signature ?? '').slice(0, 16)})`;
  }
  if (b.type === 'redacted_thinking') {
    return 'redacted_thinking';
  }
  if (b.type === 'tool_use') {
    return `tool_use(${String(b.name)} ${String(b.id).slice(-6)} input ${JSON.stringify(b.input).length}ch)`;
  }
  if (b.type === 'tool_result') {
    return `tool_result(${String(b.tool_use_id).slice(-6)}${b.is_error ? ' error' : ''} ${JSON.stringify(b.content).slice(0, 70)})`;
  }
  return String(b.type);
}

function blocksOf(m: Json): Json[] {
  return typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content as Json[]);
}

function groundTruth(r: RunData, afterMs: number, probe: string, model: string, promptText: string): Kept | undefined {
  const reqs = r.events.filter((e) => e.src === 'bodies' && e.kind === 'request' && e.ms >= afterMs);
  for (const q of reqs) {
    const path = join(r.dir, 'api-bodies', String(q.file));
    if (!existsSync(path)) {
      continue;
    }
    const body = JSON.parse(readFileSync(path, 'utf8')) as Json;
    if (!String(body.model).startsWith(model) || body.thinking === undefined || body.thread === undefined) {
      continue;
    }
    const msgs = body.messages as Json[];
    if (!JSON.stringify(msgs).includes(probe)) {
      continue;
    }
    const thread = String((body.thread as Json).type);
    const key = promptText.slice(0, 40);
    let start = msgs.findIndex((m) => JSON.stringify(m.content).includes(key));
    const lines: string[] = [];
    const k: Kept = { run: r.dir, file: String(q.file), seenMs: q.ms, thread, lines, prompt: 'absent', thinkingSigs: [], textChars: 0, toolUses: [], toolResults: [], markers: [] };
    if (start < 0) {
      k.prompt = thread === 'continue' ? `not in body (continue from ${String((body.thread as Json).previous_message_id)})` : 'absent';
      start = Math.max(0, msgs.length - 3);
    }
    for (const m of msgs.slice(start)) {
      const bl = blocksOf(m);
      lines.push(`${String(m.role)}: ${bl.map(blockLine).filter((x, i, a) => !(x === 'reminder' && a[i - 1] === 'reminder')).join(' + ')}`);
      for (const b of bl) {
        const t = String(b.text ?? '');
        if (b.type === 'text' && t.includes(MARK)) {
          k.markers.push(t.trim());
        }
        if (m.role === 'assistant' && b.type === 'thinking') {
          k.thinkingSigs.push(String(b.signature ?? '').slice(0, 16));
        }
        if (m.role === 'assistant' && b.type === 'text') {
          k.textChars += t.length;
        }
        if (b.type === 'tool_use') {
          k.toolUses.push(String(b.id));
        }
        if (b.type === 'tool_result') {
          k.toolResults.push(`${String(b.tool_use_id)}${b.is_error ? ' error' : ''}: ${JSON.stringify(b.content).slice(0, 80)}`);
        }
      }
    }
    const pm = msgs.findIndex((m) => JSON.stringify(m.content).includes(key));
    if (pm >= 0) {
      const texts = blocksOf(msgs[pm] as Json)
        .filter((b) => b.type === 'text' && !isReminder(String(b.text)))
        .map((b) => String(b.text).trim());
      k.prompt = texts.length === 1 ? 'own message' : `merged with ${JSON.stringify(texts.filter((t) => !t.startsWith(key)))}`;
    }
    return k;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Signals: the first time each fired in the cell's step, epoch ms.

function signals(r: RunData, step: number, promptText: string, model: string): Record<string, number | undefined> {
  const from = sendMs(r, step) ?? 0;
  const to = sendMs(r, step + 1) ?? Infinity;
  const inStep = r.events.filter((e) => e.ms >= from && e.ms < to);
  const key = promptText.slice(0, 40);
  const first = (pred: (e: Ev) => boolean): number | undefined => inStep.find(pred)?.ms;
  const promptLine = (e: Ev): boolean => e.src === 'transcript' && e.kind === 'line' && (e.entry as Json).type === 'user' && JSON.stringify((e.entry as Json).content).includes(key);
  const promptAppend = (e: Ev): boolean => e.src === 'store' && e.kind === 'append' && (e.entries as Json[]).some((x) => x.type === 'user' && JSON.stringify(x.content).includes(key));
  const mainReq = inStep.find((e) => e.src === 'bodies' && e.kind === 'request' && String(e.model).startsWith(model) && e.hasThinking === true && e.thread !== null);
  const assistantLine = (e: Ev): boolean => e.src === 'transcript' && e.kind === 'line' && (e.entry as Json).type === 'assistant';
  const assistantAppend = (e: Ev): boolean => e.src === 'store' && e.kind === 'append' && (e.entries as Json[]).some((x) => x.type === 'assistant');
  return {
    'UserPromptSubmit hook': first((e) => e.src === 'hook' && e.kind === 'UserPromptSubmit'),
    'prompt line in transcript': first(promptLine),
    'prompt entry in store': first(promptAppend),
    // mtime is wall clock; put it on the monotonic clock through the seen
    // event's own wall/ms pair (older runs have no wall: left out).
    'request file (mtime)': mainReq && typeof mainReq.wall === 'number' ? mainReq.ms - (Number(mainReq.wall) - Number(mainReq.mtimeMs)) : undefined,
    'request file (seen)': mainReq?.ms,
    'api_retry': first((e) => e.src === 'sdk' && e.kind === 'system:api_retry'),
    'message_start': first((e) => e.src === 'sdk' && e.kind === 'stream:message_start' && e.parent === null),
    'first SDK assistant block': first((e) => e.src === 'sdk' && e.kind === 'assistant' && e.parent === null),
    'first reply line in transcript': first(assistantLine),
    'first reply entry in store': first(assistantAppend),
    'message_stop': first((e) => e.src === 'sdk' && e.kind === 'stream:message_stop' && e.parent === null),
    'response file': first((e) => e.src === 'bodies' && e.kind === 'response' && String(e.file).startsWith('req_') && inStep.some((x) => x.src === 'bodies' && x.kind === 'index' && x.response_file === e.file && x.query_source !== 'generate_session_title')),
    'index.jsonl line': first((e) => e.src === 'bodies' && e.kind === 'index' && e.query_source !== 'generate_session_title'),
    'MessageDisplay final': first((e) => e.src === 'hook' && e.kind === 'MessageDisplay' && e.final === true),
    'Stop hook': first((e) => e.src === 'hook' && e.kind === 'Stop'),
    'StopFailure hook': first((e) => e.src === 'hook' && e.kind === 'StopFailure'),
    'result': first((e) => e.src === 'sdk' && e.kind === 'result'),
    'stop issued': first((e) => e.src === 'proof' && e.kind === 'stop'),
  };
}

// ---------------------------------------------------------------------------

function fmt(ms: number | undefined, ref: number | undefined): string {
  if (ms === undefined) {
    return '-';
  }
  if (ref === undefined) {
    return '-';
  }
  const d = ms - ref;
  return `${d >= 0 ? '+' : ''}${d.toFixed(1)}`;
}

function analyseCell(row: Json, out: string[], summary: Json[]): void {
  const cell = String(row.cell);
  const model = String(row.model);
  if (row.failed || !row.main) {
    out.push(`## ${cell}: failed (${String(row.failed ?? 'no main run')})`, '');
    summary.push({ cell, failed: true });
    return;
  }
  const main = load(String(row.main));
  const plan = main.plan;
  const promptText = String((plan.steps as string[])[1]);
  const st = stopState(main, 1);
  const stepFrom = sendMs(main, 1) ?? 0;
  const stepTo = sendMs(main, 2) ?? Infinity;
  const w = written(main, stepFrom, stepTo);
  const sig = signals(main, 1, promptText, model);
  out.push(`## ${cell}`, '');
  out.push(`main run: ${main.dir}`);
  const trig = plan.trigger as Json | null;
  if (trig) {
    out.push(`stop: ${String(trig.method)} aimed at ${String(trig.ending)}; issued ${st.how ? `on ${st.how}` : 'never'}; actual: ${st.actual}`);
    out.push(`  at the stop: ${st.messageStarts} message_start(s); blocks ${st.blocks.map((b) => `${b.type}[${b.chars}ch${b.open ? ', open' : ''}]`).join(', ') || 'none'}; PreToolUse ${st.preToolUse}; PostToolUse ${st.postToolUse}`);
    out.push(`  streamed after the stop: ${st.after.join(', ') || 'nothing'}`);
  }
  out.push('', 'what Claude Code wrote (transcript lines in the step, ms from the step\'s send; S = the store got it):');
  for (const l of w.lines) {
    const e = l.entry;
    if (NOISE.has(String(e.type))) {
      continue;
    }
    const inStore = typeof e.uuid === 'string' ? (w.storeUuids.has(e.uuid) ? 'S' : '-') : ' ';
    out.push(`  ${fmt(l.ms, stepFrom).padStart(9)} ${inStore} ${entryLine(e)}`);
  }
  const missing = w.lines.filter((l) => typeof l.entry.uuid === 'string' && !w.storeUuids.has(String(l.entry.uuid)));
  out.push(`  transcript entries the store never got: ${missing.length}`);
  // Ground truth.
  const kepts: [string, Kept | undefined][] = [];
  const resumes = (row.resumes ?? {}) as Json;
  if (trig?.method === 'abort') {
    for (const src of ['store', 'transcript']) {
      if (resumes[src]) {
        const r = load(String(resumes[src]));
        kepts.push([`resume from ${src}`, groundTruth(r, 0, PROBE, model, promptText)]);
      }
    }
  } else {
    kepts.push(['same process', groundTruth(main, sendMs(main, 2) ?? Infinity, PROBE, model, promptText)]);
    if (resumes.transcript) {
      const r = load(String(resumes.transcript));
      kepts.push(['resume from transcript (AGAIN probe)', groundTruth(r, 0, PROBE_AGAIN, model, promptText)]);
    }
  }
  const keptSummary: Json = {};
  for (const [label, k] of kepts) {
    out.push('', `next request's history (${label}):`);
    if (!k) {
      out.push('  no main request with the probe found');
      continue;
    }
    out.push(`  ${k.run}/api-bodies/${k.file} (${k.thread})`);
    for (const l of k.lines) {
      out.push(`    ${l}`);
    }
    out.push(`  prompt: ${k.prompt}; thinking kept: ${k.thinkingSigs.length}; reply text kept: ${k.textChars}ch; tool_use kept: ${k.toolUses.length}; tool_results: ${k.toolResults.length}; markers: ${JSON.stringify(k.markers)}`);
    keptSummary[label] = { prompt: k.prompt, thinking: k.thinkingSigs.length, textChars: k.textChars, toolUses: k.toolUses.length, toolResults: k.toolResults, markers: k.markers, thread: k.thread, file: `${k.run}/api-bodies/${k.file}` };
  }
  // Written vs streamed, for the reply.
  const wroteThinking = w.lines.filter((l) => l.entry.type === 'assistant' && Array.isArray(l.entry.content) && (l.entry.content as Json[]).some((b) => b.type === 'thinking')).length;
  const wroteText = w.lines.reduce((n, l) => n + (l.entry.type === 'assistant' && Array.isArray(l.entry.content) ? (l.entry.content as Json[]).filter((b) => b.type === 'text').reduce((a, b) => a + Number(b.textLen ?? 0), 0) : 0), 0);
  const streamedText = main.events.filter((e) => e.ms >= stepFrom && e.ms < stepTo && e.src === 'sdk' && e.kind === 'stream:content_block_delta' && e.delta === 'text_delta' && e.parent === null).reduce((n, e) => n + Number(e.len ?? 0), 0);
  const streamedThinking = main.events.filter((e) => e.ms >= stepFrom && e.ms < stepTo && e.src === 'sdk' && e.kind === 'stream:content_block_start' && e.block === 'thinking' && e.parent === null).length;
  out.push('', `reply: streamed ${streamedThinking} thinking block(s) and ${streamedText}ch of text; wrote ${wroteThinking} thinking entr(y/ies) and ${wroteText}ch of text`);
  // Signals.
  const promptRef = sig['prompt line in transcript'];
  const replyRef = sig['first reply line in transcript'];
  out.push('', 'signals (first in the step): ms from the step\'s send | from the prompt\'s transcript line | from the first reply transcript line');
  for (const [name, ms] of Object.entries(sig)) {
    out.push(`  ${name.padEnd(32)} ${fmt(ms, stepFrom).padStart(10)} ${fmt(ms, promptRef).padStart(10)} ${fmt(ms, replyRef).padStart(10)}`);
  }
  for (const [label, k] of kepts) {
    if (k) {
      out.push(`  ${`next request file seen (${label})`.padEnd(32)} ${label === 'same process' ? `${fmt(k.seenMs, stepFrom).padStart(10)} ${fmt(k.seenMs, promptRef).padStart(10)} ${fmt(k.seenMs, replyRef).padStart(10)}` : '(another run)'}`);
    }
  }
  out.push('');
  summary.push({ cell, model, main: main.dir, aimed: trig?.ending ?? null, method: trig?.method ?? null, actual: st.actual, streamedThinking, streamedText, wroteThinking, wroteText, missingFromStore: missing.length, kept: keptSummary, signals: Object.fromEntries(Object.entries(sig).map(([k, v]) => [k, v === undefined ? null : Math.round((v - stepFrom) * 10) / 10])), promptRef: promptRef === undefined ? null : Math.round((promptRef - stepFrom) * 10) / 10, replyRef: replyRef === undefined ? null : Math.round((replyRef - stepFrom) * 10) / 10 });
}

function main(): void {
  for (const indexPath of process.argv.slice(2)) {
    const rows = JSON.parse(readFileSync(indexPath, 'utf8')) as Json[];
    const out: string[] = [`# Proof 23 report for ${indexPath}`, ''];
    const summary: Json[] = [];
    for (const row of rows) {
      try {
        analyseCell(row, out, summary);
      } catch (err) {
        out.push(`## ${String(row.cell)}: analysis failed: ${err instanceof Error ? err.stack : String(err)}`, '');
      }
    }
    const base = indexPath.replace(/\.json$/, '');
    writeFileSync(`${base}.report.txt`, `${out.join('\n')}\n`);
    writeFileSync(`${base}.summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
    process.stdout.write(`${base}.report.txt\n`);
  }
}

main();
