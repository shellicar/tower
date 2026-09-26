// Proof 5: what Claude Code sends its host about subagents and shells
// (Stephen, 26 Sep: "the entire set of things that can be communicated about
// subagents and shells"; "is subagent thinking and streaming, and subagent
// response and streaming, separate?").
//
// One run per case, on one model:
//
//   fg          one foreground subagent (Agent, run_in_background false),
//               forwardSubagentText off.
//   fg-forward  the same, forwardSubagentText on.
//   bg          one background subagent (run_in_background true),
//               forwardSubagentText off. The main turn ends after the launch;
//               the run stays open for the completion notice and whatever
//               turn Claude Code starts on it.
//   bg-forward  the same, forwardSubagentText on.
//   shell       one Bash command run in the background that prints five
//               ticks over ~15s and exits. The run stays open for the
//               completion notice.
//   shell-stop  one background Bash `sleep 600`; the host stops it with
//               query.stopTask(task_id) as soon as it has the task id.
//   shell-fg-to-bg  one foreground Bash loop of ~24s; the host
//               moves it to the background with query.backgroundTasks(
//               tool_use_id) as soon as its task_started arrives.
//
// --display summarized|default (subagent cases; default summarized):
// summarized passes thinking {adaptive, display 'summarized'} (an explicit
// display); default passes thinking {adaptive} with no display. Claude Code
// forces a foreground subagent's thinking display to 'omitted' unless the
// session's display is explicit, forwardSubagentText is on, or the subagent
// is in the background (claude 2.1.282, function pko); the pair shows it.
//
// Every run: includePartialMessages, includeHookEvents, and in-process hook
// callbacks on the events that can say anything about a subagent, a shell or
// a tool call, each input recorded to hooks.jsonl. Subagent cases also turn
// on agentProgressSummaries, and the subagent's first step is a ~36s loop so
// at least one ~30s summary has time to fire.
//
// Three more channels are recorded, each copied redacted into the run
// directory:
//   api-bodies/   OTEL_LOG_RAW_API_BODIES=file:<dir> (as proof 1): every API
//                 request and response with its query source, so a
//                 subagent's own requests (and their thinking display) show.
//   otel.jsonl    Claude Code's OpenTelemetry export (metrics, logs, and
//                 traces with the enhanced-telemetry beta), received by a
//                 local OTLP/HTTP JSON endpoint this script runs on
//                 127.0.0.1. Nothing leaves the machine.
//   task-outputs/ copies of every output_file named by a task_notification
//                 or an Agent/Bash tool result, read after the run.
//   debug.log     Claude Code's debug log.
//
// Printed, and written to proof-summary.txt: one line per SDK message that
// concerns a subagent, a shell or a task (with its line in
// sdk-messages.jsonl), then per-case tallies of what came through with
// parent_tool_use_id set.
//
//   node proofs/subagents-shells.mts <model> <case> [--display summarized|default] [NAME=value ...]

import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { HookCallbackMatcher, HookEvent, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { HarnessOptions } from '../src/harness.mts';
import { startRun } from '../src/harness.mts';
import { redact, stamp } from '../src/record.mts';

type Case = 'fg' | 'fg-forward' | 'bg' | 'bg-forward' | 'shell' | 'shell-stop' | 'shell-fg-to-bg';
const CASES: Case[] = ['fg', 'fg-forward', 'bg', 'bg-forward', 'shell', 'shell-stop', 'shell-fg-to-bg'];

const args = process.argv.slice(2);
const model = args.shift();
const kase = args.shift() as Case | undefined;
let display: 'summarized' | 'default' = 'summarized';
const envAdd: Record<string, string> = {};
while (args.length > 0) {
  const a = args.shift() as string;
  if (a === '--display') {
    const v = args.shift();
    if (v !== 'summarized' && v !== 'default') {
      process.stderr.write('--display takes summarized or default\n');
      process.exit(2);
    }
    display = v;
    continue;
  }
  const at = a.indexOf('=');
  if (at <= 0) {
    process.stderr.write(`subagents-shells: not NAME=value: ${a}\n`);
    process.exit(2);
  }
  envAdd[a.slice(0, at)] = a.slice(at + 1);
}
if (!model || !kase || !CASES.includes(kase)) {
  process.stderr.write(`usage: node proofs/subagents-shells.mts <model> <${CASES.join('|')}> [--display summarized|default] [NAME=value ...]\n`);
  process.exit(2);
}

const isSubagent = kase === 'fg' || kase === 'fg-forward' || kase === 'bg' || kase === 'bg-forward';
const background = kase === 'bg' || kase === 'bg-forward';
const forward = kase === 'fg-forward' || kase === 'bg-forward';
const name = `subagents-${kase}${isSubagent ? `-${display}` : ''}`;

// The subagent's task: a sentence of text before each tool call (text between
// tool calls), a ~36s loop (time for a progress summary), a chain of reads,
// and a small sum to think about. Not a plain `sleep 35 && ...`: Claude Code
// 2.1.282 blocks a Bash command that starts with a long sleep ("Blocked:
// sleep 35 followed by: ..."), seen in the first runs.
const SUBAGENT_PROMPT =
  'Before each tool call, write one short sentence saying what you are about to do. ' +
  'First run the shell command `for i in 1 2 3 4 5 6 7 8 9 10 11 12; do echo waiting $i; sleep 3; done; cat chain-1.txt` with the Bash tool (not in the background). ' +
  'It names the next file to read; read files one per Read tool call, following the chain until a file gives you a number. ' +
  'Then work out the sum of the squares of that number\'s digits, and finish with one sentence giving the number and that sum.';

const MAIN_PROMPT = background
  ? 'Use the Agent tool exactly once, with subagent_type "general-purpose", run_in_background true, description "Follow the file chain", and this prompt, verbatim:\n\n' +
    `${SUBAGENT_PROMPT}\n\n` +
    'Do not use any other tool yourself. After launching it, end your turn with the single word "launched". ' +
    'When you are notified that it has finished, reply with the sum it reported, the number only.'
  : 'Use the Agent tool exactly once, with subagent_type "general-purpose", run_in_background false, description "Follow the file chain", and this prompt, verbatim:\n\n' +
    `${SUBAGENT_PROMPT}\n\n` +
    'Do not use any other tool yourself. When it reports, reply with the sum it reported, the number only.';

const SHELL_PROMPT: Record<'shell' | 'shell-stop' | 'shell-fg-to-bg', string> = {
  shell:
    'Run this command with the Bash tool, with run_in_background true: `for i in 1 2 3 4 5; do echo tick $i; sleep 3; done`. ' +
    'Do not use any other tool. After starting it, end your turn with the single word "started". ' +
    'When you are notified that it has finished, reply with the last line it printed, and nothing else.',
  'shell-stop':
    'Run this command with the Bash tool, with run_in_background true: `sleep 600`. ' +
    'Do not use any other tool. After starting it, end your turn with the single word "started". ' +
    'If you are notified that it has ended, reply with the single word "ended".',
  'shell-fg-to-bg':
    'Run this command with the Bash tool, not in the background: `for i in 1 2 3 4 5 6 7 8; do echo step $i; sleep 3; done; echo finished`. ' +
    'Do not use any other tool. If it moves to the background, end your turn with the single word "backgrounded". ' +
    'When you are notified that it has finished, reply with what it printed, and nothing else.',
};

// --- side channels -------------------------------------------------------

const stateRoot = join(homedir(), '.local', 'state', 'tower-claude-code-harness');
const sideDir = join(stateRoot, 'side', `${stamp().replace(/[:.]/g, '')}-${name}`);
const bodiesDir = join(sideDir, 'api-bodies');
mkdirSync(bodiesDir, { recursive: true });
const debugFile = join(sideDir, 'debug.log');

// A local OTLP/HTTP JSON endpoint: every POST body, one line each.
const otelLines: string[] = [];
const otel = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: unknown = raw;
    try {
      body = JSON.parse(raw);
    } catch {
      // kept raw: http/protobuf would land here
    }
    otelLines.push(JSON.stringify({ ts: stamp(), path: req.url, contentType: req.headers['content-type'], body }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
});
await new Promise<void>((resolve) => otel.listen(0, '127.0.0.1', resolve));
const otelPort = (otel.address() as { port: number }).port;

const OTEL_ENV: Record<string, string> = {
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
  OTEL_METRICS_EXPORTER: 'otlp',
  OTEL_LOGS_EXPORTER: 'otlp',
  OTEL_TRACES_EXPORTER: 'otlp',
  OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
  OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${otelPort}`,
  OTEL_METRIC_EXPORT_INTERVAL: '2000',
  OTEL_LOGS_EXPORT_INTERVAL: '1000',
  OTEL_BSP_SCHEDULE_DELAY: '1000',
  OTEL_LOG_TOOL_DETAILS: '1',
  OTEL_LOG_RAW_API_BODIES: `file:${bodiesDir}`,
};

// --- hooks ---------------------------------------------------------------

const hookLog: string[] = [];
const HOOKED: HookEvent[] = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'SubagentStart',
  'SubagentStop',
  'TaskCreated',
  'TaskCompleted',
  'Notification',
  'Stop',
  'SessionEnd',
];
const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
for (const ev of HOOKED) {
  hooks[ev] = [
    {
      hooks: [
        async (input, toolUseID) => {
          hookLog.push(JSON.stringify({ ts: stamp(), event: ev, toolUseID: toolUseID ?? null, input }));
          return {};
        },
      ],
    },
  ];
}

// --- the run -------------------------------------------------------------

const options: HarnessOptions = {
  model,
  includePartialMessages: true,
  includeHookEvents: true,
  hooks,
  thinking: display === 'summarized' ? { type: 'adaptive', display: 'summarized' } : { type: 'adaptive' },
  tools: isSubagent ? ['Agent', 'Bash', 'Read'] : ['Bash', 'Read'],
  allowedTools: isSubagent ? ['Agent', 'Bash', 'Read'] : ['Bash', 'Read'],
  ...(isSubagent ? { forwardSubagentText: forward, agentProgressSummaries: true } : {}),
  debugFile,
  env: { ...process.env, ...OTEL_ENV, ...envAdd },
};

const run = startRun({ name, options });
const summaryOut = createWriteStream(join(run.dir, 'proof-summary.txt'));
const out = (s: string): void => {
  process.stdout.write(`${s}\n`);
  summaryOut.write(`${s}\n`);
};
out(`run dir: ${run.dir}\nmodel: ${model}\ncase: ${kase}\ndisplay: ${display}\nforwardSubagentText: ${isSubagent ? forward : '-'}\notel port: ${otelPort}\nextra env: ${Object.keys(envAdd).join(',') || '-'}`);

if (isSubagent) {
  writeFileSync(join(run.cwd, 'chain-1.txt'), 'Next: read chain-2.txt\n');
  writeFileSync(join(run.cwd, 'chain-2.txt'), 'Next: read chain-3.txt\n');
  writeFileSync(join(run.cwd, 'chain-3.txt'), 'The number is 4817.\n');
}

run.send({ type: 'user', message: { role: 'user', content: isSubagent ? MAIN_PROMPT : SHELL_PROMPT[kase as keyof typeof SHELL_PROMPT] }, parent_tool_use_id: null });

// Ending: the input stays open while background work is live. After a result,
// once no non-ambient background task is live (the last
// background_tasks_changed) and nothing has arrived for QUIET_MS, the input
// is closed. HARD_MS caps the whole run.
const QUIET_MS = 20_000;
const HARD_MS = 8 * 60_000;
let liveBg: { task_id: string; task_type: string; ambient?: boolean }[] = [];
let resultsSeen = 0;
let lastMessageAt = Date.now();
let ended = false;
const endRun = (why: string): void => {
  if (ended) {
    return;
  }
  ended = true;
  out(`\nending input: ${why} at ${stamp()}`);
  run.end();
};
const hardTimer = setTimeout(() => endRun(`hard cap ${HARD_MS}ms`), HARD_MS);
const quietTimer = setInterval(() => {
  if (resultsSeen > 0 && liveBg.filter((t) => !t.ambient).length === 0 && Date.now() - lastMessageAt >= QUIET_MS) {
    endRun(`quiet ${QUIET_MS}ms after result ${resultsSeen} with no live background task`);
  }
}, 1000);

// Tallies.
interface Tally {
  [key: string]: number;
}
const byParent: Tally = {};
const streamByParent: Tally = {};
const typeCounts: Tally = {};
const outputFiles = new Set<string>();
const bump = (t: Tally, k: string, n = 1): void => {
  t[k] = (t[k] ?? 0) + n;
};

let line = 0;
let backgroundRequested = false;
let stopRequested = false;
const trunc = (s: unknown, n = 140): string => {
  const str = typeof s === 'string' ? s : JSON.stringify(s);
  return str === undefined ? 'undefined' : str.length > n ? `${str.slice(0, n)}…[${str.length}]` : str;
};

for await (const message of run.messages() as AsyncIterable<SDKMessage>) {
  line += 1;
  lastMessageAt = Date.now();
  const m = message as SDKMessage & Record<string, unknown>;
  const sub = 'subtype' in m ? `/${String(m.subtype)}` : '';
  bump(typeCounts, `${m.type}${sub}`);
  const parent = 'parent_tool_use_id' in m ? (m.parent_tool_use_id as string | null) : undefined;

  if (m.type === 'stream_event') {
    const ev = message.type === 'stream_event' ? message.event : undefined;
    const key = `${parent === null ? 'main' : `sub:${parent}`} ${ev?.type}${ev?.type === 'content_block_start' ? `:${ev.content_block.type}` : ev?.type === 'content_block_delta' ? `:${ev.delta.type}` : ''}`;
    bump(streamByParent, key);
    continue;
  }

  if (m.type === 'assistant' && message.type === 'assistant') {
    for (const block of message.message.content) {
      const who = parent === null ? 'main' : `sub:${parent}`;
      if (block.type === 'thinking') {
        bump(byParent, `${who} assistant thinking`);
        bump(byParent, `${who} assistant thinking chars`, block.thinking.length);
        out(`${line} assistant ${who} thinking(${block.thinking.length}) ${trunc(block.thinking.replace(/\s+/g, ' '), 100)} subagent_type=${m.subagent_type ?? '-'} task_description=${trunc(m.task_description ?? '-', 40)} msg.id=${message.message.id}`);
      } else if (block.type === 'text') {
        bump(byParent, `${who} assistant text`);
        out(`${line} assistant ${who} text ${trunc(block.text.replace(/\s+/g, ' '), 140)} subagent_type=${m.subagent_type ?? '-'} msg.id=${message.message.id}`);
      } else if (block.type === 'tool_use') {
        bump(byParent, `${who} assistant tool_use`);
        out(`${line} assistant ${who} tool_use ${block.name} id=${block.id} input=${trunc(block.input, 160)} subagent_type=${m.subagent_type ?? '-'}`);
      } else {
        bump(byParent, `${who} assistant ${block.type}`);
        out(`${line} assistant ${who} ${block.type}`);
      }
    }
    continue;
  }

  if (m.type === 'user' && message.type === 'user') {
    const who = parent === null ? 'main' : `sub:${parent}`;
    const content = message.message.content;
    if (typeof content === 'string') {
      bump(byParent, `${who} user string`);
      out(`${line} user ${who} string ${trunc(content.replace(/\s+/g, ' '), 200)} isSynthetic=${m.isSynthetic ?? '-'} origin=${trunc(m.origin ?? '-', 120)}`);
    } else {
      for (const block of content) {
        bump(byParent, `${who} user ${block.type}`);
        if (block.type === 'tool_result') {
          out(`${line} user ${who} tool_result for=${block.tool_use_id} ${trunc(typeof block.content === 'string' ? block.content.replace(/\s+/g, ' ') : block.content, 160)}`);
        } else if (block.type === 'text') {
          out(`${line} user ${who} text ${trunc(block.text.replace(/\s+/g, ' '), 200)} isSynthetic=${m.isSynthetic ?? '-'} origin=${trunc(m.origin ?? '-', 120)}`);
        } else {
          out(`${line} user ${who} ${block.type}`);
        }
      }
    }
    const tur = m.tool_use_result as Record<string, unknown> | undefined;
    if (tur && typeof tur === 'object') {
      const keys = Object.keys(tur);
      out(`${line}   tool_use_result keys=${keys.join(',')} status=${tur.status ?? '-'} agentId=${tur.agentId ?? '-'} backgroundTaskId=${tur.backgroundTaskId ?? '-'} outputFile=${tur.outputFile ?? '-'} backgroundedByUser=${tur.backgroundedByUser ?? '-'}`);
      for (const k of ['outputFile', 'persistedOutputPath']) {
        if (typeof tur[k] === 'string') {
          outputFiles.add(tur[k] as string);
        }
      }
      if (kase === 'shell-stop' && typeof tur.backgroundTaskId === 'string' && !stopRequested) {
        stopRequested = true;
        const id = tur.backgroundTaskId;
        out(`host: stopTask(${id}) at ${stamp()}`);
        run.query.stopTask(id).then(
          () => out(`host: stopTask returned at ${stamp()}`),
          (e) => out(`host: stopTask threw ${e instanceof Error ? e.message : String(e)}`),
        );
      }
    }
    continue;
  }

  if (m.type === 'system') {
    const s = m.subtype as string;
    if (s === 'background_tasks_changed') {
      liveBg = m.tasks as typeof liveBg;
    }
    if (typeof m.output_file === 'string') {
      outputFiles.add(m.output_file);
    }
    // A foreground Bash registers as a task only after a few seconds (in the
    // first run a backgroundTasks call 3s after the tool_use returned false,
    // 90ms before task_started arrived), so the host waits for task_started.
    if (kase === 'shell-fg-to-bg' && s === 'task_started' && m.task_type === 'local_bash' && m.is_backgrounded === false && typeof m.tool_use_id === 'string' && !backgroundRequested) {
      backgroundRequested = true;
      const id = m.tool_use_id;
      out(`host: backgroundTasks(${id}) at ${stamp()}`);
      run.query.backgroundTasks(id).then(
        (r) => out(`host: backgroundTasks returned ${r} at ${stamp()}`),
        (e) => out(`host: backgroundTasks threw ${e instanceof Error ? e.message : String(e)}`),
      );
    }
    if (s === 'init') {
      out(`${line} system/init model=${m.model} agents=${trunc(m.agents, 200)} tools=${trunc(m.tools, 200)}`);
      continue;
    }
    if (s === 'thinking_tokens' || s === 'status') {
      continue;
    }
    const rest = { ...m } as Record<string, unknown>;
    delete rest.type;
    delete rest.subtype;
    delete rest.uuid;
    delete rest.session_id;
    out(`${line} system/${s} ${trunc(rest, 600)}`);
    continue;
  }

  if (m.type === 'tool_progress' || m.type === 'tool_use_summary') {
    const rest = { ...m } as Record<string, unknown>;
    delete rest.uuid;
    delete rest.session_id;
    out(`${line} ${m.type} ${trunc(rest, 400)}`);
    continue;
  }

  if (m.type === 'result') {
    resultsSeen += 1;
    out(`${line} result ${String(m.subtype)} #${resultsSeen} result=${trunc(m.result ?? '-', 80)} num_turns=${m.num_turns} modelUsage=${trunc(Object.keys((m.modelUsage as object) ?? {}), 200)}`);
    continue;
  }

  out(`${line} ${m.type}${sub} ${trunc(m, 300)}`);
}

clearInterval(quietTimer);
clearTimeout(hardTimer);

let failed = false;
try {
  await run.done;
} catch (err) {
  failed = true;
  out(`failed: ${err instanceof Error ? err.message : String(err)}`);
}
// Give the OTel exporters' last flush a moment to land; the binary has exited
// by now, so anything still in flight has already been sent or lost.
await new Promise((r) => setTimeout(r, 1000));
otel.close();

// --- copy the side channels in, redacted ----------------------------------

let redactions = 0;
const put = (to: string, text: string): void => {
  const r = redact(text);
  redactions += r.count;
  writeFileSync(to, r.text);
};
put(join(run.dir, 'hooks.jsonl'), hookLog.map((l) => `${l}\n`).join(''));
put(join(run.dir, 'otel.jsonl'), otelLines.map((l) => `${l}\n`).join(''));
if (existsSync(debugFile)) {
  put(join(run.dir, 'debug.log'), readFileSync(debugFile, 'utf8'));
}
const bodiesOut = join(run.dir, 'api-bodies');
mkdirSync(bodiesOut, { recursive: true });
for (const entry of existsSync(bodiesDir) ? readdirSync(bodiesDir) : []) {
  put(join(bodiesOut, entry), readFileSync(join(bodiesDir, entry), 'utf8'));
}
const outputsOut = join(run.dir, 'task-outputs');
mkdirSync(outputsOut, { recursive: true });
const outputsIndex: Record<string, string> = {};
for (const f of outputFiles) {
  try {
    if (statSync(f).isFile()) {
      const to = `${Object.keys(outputsIndex).length + 1}-${basename(f)}`;
      put(join(outputsOut, to), readFileSync(f, 'utf8'));
      outputsIndex[f] = to;
    }
  } catch (err) {
    outputsIndex[f] = `unreadable: ${err instanceof Error ? err.message : String(err)}`;
  }
}
put(join(outputsOut, 'index.json'), `${JSON.stringify(outputsIndex, null, 2)}\n`);
out(`\nside channels copied (${redactions} redactions): hooks.jsonl ${hookLog.length} lines, otel.jsonl ${otelLines.length} posts, task-outputs ${JSON.stringify(outputsIndex)}`);

// --- tallies ----------------------------------------------------------------

out('\nmessage types:');
for (const [k, v] of Object.entries(typeCounts).sort()) {
  out(`  ${k}: ${v}`);
}
out('\nassistant/user blocks by parent_tool_use_id:');
for (const [k, v] of Object.entries(byParent).sort()) {
  out(`  ${k}: ${v}`);
}
out('\nstream events by parent_tool_use_id:');
for (const [k, v] of Object.entries(streamByParent).sort()) {
  out(`  ${k}: ${v}`);
}
out('\nhooks fired:');
const hookCounts: Tally = {};
for (const l of hookLog) {
  const h = JSON.parse(l) as { event: string; input: { agent_id?: string; tool_name?: string } };
  bump(hookCounts, `${h.event}${h.input.tool_name ? `(${h.input.tool_name})` : ''}${h.input.agent_id ? ' [in subagent]' : ''}`);
}
for (const [k, v] of Object.entries(hookCounts).sort()) {
  out(`  ${k}: ${v}`);
}

// What each API request asked for about thinking, and who sent it.
const indexPath = join(bodiesOut, 'index.jsonl');
if (existsSync(indexPath)) {
  out('\nAPI requests:');
  readFileSync(indexPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .forEach((raw, i) => {
      const entry = JSON.parse(raw) as { query_source?: string; model?: string; request_file?: string; response_file?: string };
      const req = entry.request_file && existsSync(join(bodiesOut, entry.request_file)) ? (JSON.parse(readFileSync(join(bodiesOut, entry.request_file), 'utf8')) as Record<string, unknown>) : undefined;
      const res = entry.response_file && existsSync(join(bodiesOut, entry.response_file)) ? (JSON.parse(readFileSync(join(bodiesOut, entry.response_file), 'utf8')) as { content?: { type: string; thinking?: string }[] }) : undefined;
      out(`  ${i + 1} source=${entry.query_source} model=${entry.model} thinking=${JSON.stringify(req?.thinking)} stream=${JSON.stringify(req?.stream)} response blocks=${JSON.stringify(res?.content?.map((b) => (b.type === 'thinking' ? `thinking(${b.thinking?.length})` : b.type)))} file=${entry.request_file}`);
    });
}

// Subagent transcripts on disk, in the copied config directory.
const projects = join(run.dir, 'config-dir', 'projects');
if (existsSync(projects)) {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) {
        walk(p);
      } else {
        found.push(p.slice(run.dir.length + 1));
      }
    }
  };
  walk(projects);
  out(`\ntranscript files:\n  ${found.join('\n  ')}`);
}

await new Promise((r) => summaryOut.end(r));
if (failed) {
  process.exitCode = 1;
}
