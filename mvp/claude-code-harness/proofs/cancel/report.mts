// Renders a cancel-scenarios index (runs/cancel-index-*.json) as text: per
// run, what Claude Code wrote (transcript lines, with parent, and whether
// the store got each), what a resume loaded, and the next request's history.
//
//   node proofs/cancel/report.mts <index.json> [...] > out.txt

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

type Json = Record<string, unknown>;

const sid = (u: unknown): string => (typeof u === 'string' ? u.slice(0, 8) : u === null ? 'null    ' : '-       ');

// A hosted run's file has two writers (the SDK host and the recording
// parent): sort by time. Buffered events carry the time they happened.
function readEvents(dir: string): Json[] {
  const p = join(dir, 'cancel-events.jsonl');
  if (!existsSync(p)) {
    return [];
  }
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Json)
    .map((e) => (typeof e.bufferedMs === 'number' ? { ...e, ms: e.bufferedMs } : e))
    .sort((a, b) => Number(a.ms) - Number(b.ms));
}

function blocks(content: unknown): string {
  if (!Array.isArray(content)) {
    return String(content ?? '');
  }
  return (content as Json[])
    .map((b) => {
      switch (b.type) {
        case 'string':
        case 'text': {
          const t = String(b.text ?? '').replace(/\s+/g, ' ');
          return `text(${b.textLen ?? t.length}ch "${t.slice(0, 60)}")`;
        }
        case 'thinking':
          return `thinking(${b.thinkingLen}ch${b.sigLen ? `, sig ${b.sigLen}` : ', no sig'})`;
        case 'redacted_thinking':
          return 'redacted_thinking';
        case 'tool_use':
          return `tool_use(${b.name} ${String(b.id).slice(-6)} ${String(b.input ?? '').slice(0, 50)})`;
        case 'tool_result':
          return `tool_result(${String(b.tool_use_id).slice(-6)}${b.is_error ? ' ERROR' : ''} ${String(b.content ?? '').slice(0, 70)})`;
        default:
          return String(b.type);
      }
    })
    .join(' + ');
}

const META = new Set(['queue-operation', 'last-prompt', 'ai-title', 'atis-latch', 'cost-state', 'custom-title', 'summary', 'file-history-snapshot', 'tag']);

function entryLine(e: Json): string {
  const flags: string[] = [];
  for (const k of ['isMeta', 'isSidechain', 'isApiErrorMessage', 'isAbortedMidStream', 'isCompactSummary']) {
    if (e[k] === true) {
      flags.push(k);
    }
  }
  if (e.stop_reason) {
    flags.push(`stop=${e.stop_reason}`);
  }
  if (e.model === '<synthetic>') {
    flags.push('model=<synthetic>');
  }
  if (typeof e.msgId === 'string') {
    flags.push(`id=${String(e.msgId).slice(0, 12)}`);
  }
  let kind = String(e.type);
  if (e.subtype) {
    kind += `:${e.subtype}`;
  }
  if (e.attachment) {
    kind += `:${e.attachment}`;
  }
  const body = META.has(String(e.type)) ? (e.type === 'queue-operation' && Array.isArray(e.content) ? blocks(e.content) : '') : blocks(e.content);
  return `${sid(e.uuid)} <- ${sid(e.parentUuid)}  ${kind}${flags.length ? ` [${flags.join(' ')}]` : ''} ${body}`.trimEnd();
}

function requestHistory(dir: string, file: string): string[] {
  const p = join(dir, 'api-bodies', file);
  if (!existsSync(p)) {
    return [`  (request file ${file} missing)`];
  }
  const b = JSON.parse(readFileSync(p, 'utf8')) as Json;
  const out: string[] = [];
  for (const m of (b.messages as Json[]) ?? []) {
    const c = m.content;
    let desc: string;
    if (typeof c === 'string') {
      desc = `text(${c.length}ch "${c.replace(/\s+/g, ' ').slice(0, 70)}")`;
    } else {
      desc = (c as Json[])
        .map((x) => {
          if (x.type === 'text') {
            const t = String(x.text).replace(/\s+/g, ' ');
            if (t.startsWith('<system-reminder>')) {
              return `reminder(${t.length}ch "${t.slice(17, 60)}")`;
            }
            return `text(${t.length}ch "${t.slice(0, 70)}")`;
          }
          if (x.type === 'thinking') {
            return `thinking(${String(x.thinking ?? '').length}ch)`;
          }
          if (x.type === 'tool_use') {
            return `tool_use(${x.name} ${String(x.id).slice(-6)})`;
          }
          if (x.type === 'tool_result') {
            const rc = typeof x.content === 'string' ? x.content : JSON.stringify(x.content);
            return `tool_result(${String(x.tool_use_id).slice(-6)}${x.is_error ? ' ERROR' : ''} "${String(rc).replace(/\s+/g, ' ').slice(0, 60)}")`;
          }
          return String(x.type);
        })
        .join(' + ');
    }
    out.push(`    ${String(m.role).padEnd(9)} ${desc}`);
  }
  return out;
}

function renderRun(title: string, dir: string, probe: string | undefined): string[] {
  const ev = readEvents(dir);
  const out: string[] = [`### ${title}`, `run: ${dir}`];
  if (ev.length === 0) {
    out.push('  (no events)');
    return out;
  }
  const stop = ev.find((e) => e.src === 'proof' && e.kind === 'stop');
  const t0 = Number(stop?.ms ?? ev[0]?.ms);
  const rel = (e: Json): string => {
    const d = Number(e.ms) - t0;
    return `${d >= 0 ? '+' : ''}${d.toFixed(1)}`.padStart(9);
  };
  out.push(`times in ms from ${stop ? 'the stop' : 'the run start'}`);
  // Store appends by uuid, for the S marker.
  const stored = new Map<string, number>();
  for (const e of ev) {
    if (e.src === 'store' && e.kind === 'append') {
      for (const x of (e.entries as Json[]) ?? []) {
        if (typeof x.uuid === 'string') {
          stored.set(x.uuid, Number(e.ms));
        }
      }
    }
  }
  const load = ev.find((e) => e.src === 'store' && e.kind === 'load');
  if (load && Array.isArray(load.entries)) {
    out.push(`store load returned ${load.returned} entries; conversation entries:`);
    for (const x of load.entries as Json[]) {
      if (!META.has(String(x.type))) {
        out.push(`      ${entryLine(x)}`);
      }
    }
  }
  for (const e of ev) {
    const k = `${e.src}:${e.kind}`;
    if (k === 'proof:send' || k === 'proof:push') {
      out.push(`${rel(e)} ${String(e.kind).toUpperCase()} step ${e.step}: "${String(e.text).slice(0, 60)}"`);
    } else if (k === 'proof:stop') {
      out.push(`${rel(e)} STOP ${e.method} at ${e.at} (${e.how})`);
    } else if (k === 'proof:kill') {
      out.push(`${rel(e)} KILL ${e.signal ?? ''} pid ${e.pid ?? ''} sent=${e.sent}${e.why ? ` ${e.why}` : ''}`);
    } else if (k === 'proof:kill-gone') {
      out.push(`${rel(e)} pid ${e.pid} gone (${Number(e.afterMs).toFixed(1)} ms after the signal)`);
    } else if (k === 'proc:exit') {
      const x = e.exit as Json | undefined;
      out.push(`${rel(e)} Claude Code exit: code=${x?.code ?? null} signal=${x?.signal ?? null}`);
    } else if (k === 'proc:found') {
      out.push(`${rel(e)} Claude Code pid ${e.pid}${e.configDir && !String(e.configDir).includes('/config-dirs/') ? ` (config dir ${e.configDir})` : ''}`);
    } else if (k === 'proof:host-kill') {
      out.push(`${rel(e)} HOST KILL ${e.signal} (the SDK host, pid ${e.pid}, signals itself)`);
    } else if (k === 'proof:host-exit') {
      out.push(`${rel(e)} SDK host exit: code=${e.code} signal=${e.signal}`);
    } else if (k === 'proof:claude-gone') {
      out.push(`${rel({ ms: e.goneMs })} Claude Code pid ${e.pid} gone`);
    } else if (k === 'proof:canUseTool' || k === 'proof:permission-aborted' || k === 'proof:permission-released') {
      out.push(`${rel(e)} ${e.kind} ${e.toolName}${e.agentID ? ` (agent ${e.agentID})` : ''}`);
    } else if (e.src === 'fwd' && e.kind !== 'listening') {
      out.push(`${rel(e)} forwarder #${e.id} ${e.kind}${e.rule ? ` rule=${JSON.stringify(e.rule)}` : ''}${e.status ? ` status=${e.status}` : ''}${e.deltas ? ` after ${e.deltas} deltas` : ''}${e.error ? ` ${e.error}` : ''}${e.kind === 'request' && !e.rule ? ` ${e.model}` : ''}`);
    } else if (k === 'proof:interrupt-returned' || k === 'proof:abort-called' || k === 'proof:trigger-missed' || k === 'proof:end' || k === 'proof:end-idle' || k === 'proof:run-done' || k === 'proof:skip-pushed') {
      out.push(`${rel(e)} ${e.kind}${e.error ? ` (${e.error})` : ''}${e.why ? ` (${e.why})` : ''}`);
    } else if (e.src === 'transcript' && (e.kind === 'line' || e.kind === 'preexisting')) {
      const x = e.entry as Json;
      if (META.has(String(x.type)) && x.type !== 'queue-operation') {
        out.push(`${rel(e)}   T ${e.kind === 'preexisting' ? 'pre ' : ''}(${x.type})`);
        continue;
      }
      const s = typeof x.uuid === 'string' && stored.has(x.uuid) ? 'S' : ' ';
      const f = String(e.file);
      const where = f.includes('/subagents/') ? ` [${f.slice(f.indexOf('/subagents/') + 1)}]` : '';
      out.push(`${rel(e)}   T${s}${e.kind === 'preexisting' ? ' pre' : ''} ${entryLine(x)}${where}`);
    } else if (k === 'sdk:result') {
      out.push(`${rel(e)} result ${e.subtype} stop=${e.stop_reason ?? null} "${String(e.result ?? '').slice(0, 40)}"${e.errors ? ` errors=${JSON.stringify(e.errors).slice(0, 120)}` : ''}`);
    } else if (k === 'sdk:stream:message_start') {
      out.push(`${rel(e)} stream message_start ${String(e.id).slice(0, 12)}${e.parent ? ` (sub ${e.parent})` : ''}`);
    } else if (k === 'sdk:stream:content_block_start' && e.parent === null) {
      out.push(`${rel(e)} stream block_start ${e.block}`);
    } else if (k === 'bodies:index') {
      out.push(`${rel(e)} request ${e.query_source} -> ${e.request_file}`);
    } else if (e.src === 'hook' && !String(e.kind).endsWith(':returned')) {
      out.push(`${rel(e)} hook ${e.kind}${e.tool_name ? ` ${e.tool_name}` : ''}${e.reason ? ` reason=${e.reason}` : ''}`);
    } else if (k === 'sdk:assistant' && (e.error || (Array.isArray(e.content) && (e.content as Json[]).some((b) => String(b.text ?? '').startsWith('API Error'))))) {
      out.push(`${rel(e)} sdk assistant error=${JSON.stringify(e.error ?? null)} ${blocks(e.content)}`);
    } else if (k === 'sdk:system:status') {
      if (e.status) {
        out.push(`${rel(e)} system:status ${e.status}`);
      }
    } else if (k === 'sdk:system:api_retry' || k === 'sdk:system:compact_boundary') {
      out.push(`${rel(e)} ${e.kind} ${JSON.stringify(e).slice(0, 160)}`);
    }
  }
  // Store appends of entries the transcript lines never showed (a resume's
  // own writes the watcher might have missed).
  const tUuids = new Set(ev.filter((e) => e.src === 'transcript').map((e) => (e.entry as Json | undefined)?.uuid));
  const storeOnly = ev.filter((e) => e.src === 'store' && e.kind === 'append').flatMap((e) => ((e.entries as Json[]) ?? []).filter((x) => typeof x.uuid === 'string' && !tUuids.has(x.uuid)).map((x) => ({ e, x })));
  if (storeOnly.length > 0) {
    out.push('store appends with no transcript line seen:');
    for (const { e, x } of storeOnly) {
      out.push(`${rel(e)}   S ${entryLine(x)}`);
    }
  }
  if (probe) {
    const reqs = ev.filter((e) => e.src === 'bodies' && e.kind === 'request');
    const idx = ev.filter((e) => e.src === 'bodies' && e.kind === 'index');
    const srcOf = (f: string): string => String(idx.find((i) => i.request_file === f)?.query_source ?? '?');
    const hit = reqs.find((r) => {
      const last = r.last as Json | null;
      return JSON.stringify(last ?? '').includes(probe.slice(0, 25)) || (srcOf(String(r.file)) === 'sdk' && readFileSync(join(dir, 'api-bodies', String(r.file)), 'utf8').includes(probe));
    });
    if (hit) {
      out.push(`next request (${srcOf(String(hit.file))}): ${join(dir, 'api-bodies', String(hit.file))}`);
      out.push(...requestHistory(dir, String(hit.file)));
    } else {
      out.push(`next request: none carrying "${probe}"`);
    }
  }
  return out;
}

const PROBES = ['Reply with the word NEXT only.', 'Reply with the word AGAIN only.'];

function probeFor(dir: string): string | undefined {
  const p = join(dir, 'cancel-plan.json');
  if (!existsSync(p)) {
    return undefined;
  }
  const plan = JSON.parse(readFileSync(p, 'utf8')) as { steps: { text: string }[] };
  return plan.steps.map((s) => s.text).find((t) => PROBES.includes(t));
}

for (const indexPath of process.argv.slice(2)) {
  const index = JSON.parse(readFileSync(indexPath, 'utf8')) as Json[];
  process.stdout.write(`# ${indexPath}\n\n`);
  for (const row of index) {
    process.stdout.write(`## ${row.scenario} rep ${row.rep}${row.failed ? ` FAILED ${row.failed}` : ''}\n`);
    if (!row.main) {
      continue;
    }
    process.stdout.write(`session ${row.sessionId}; main error: ${row.mainError ?? 'none'}\n`);
    process.stdout.write(`${renderRun('main', String(row.main), probeFor(String(row.main))).join('\n')}\n\n`);
    for (const r of (row.resumes as Json[]) ?? []) {
      if (r.skipped) {
        process.stdout.write(`### resume ${r.label}: skipped (${r.skipped})\n\n`);
        continue;
      }
      const at = r.atEntry as Json | null;
      const title = `resume ${r.label} (source ${r.source}${r.resumeSessionAt ? `, resumeSessionAt ${sid(r.resumeSessionAt)} = ${at ? entryLine(at) : '?'}` : ''})${r.error ? ` error: ${r.error}` : ''}`;
      process.stdout.write(`${renderRun(title, String(r.dir), probeFor(String(r.dir))).join('\n')}\n\n`);
    }
  }
}
