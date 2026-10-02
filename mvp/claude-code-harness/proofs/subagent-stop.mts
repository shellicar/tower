// What each way of stopping does to running subagents: foreground,
// background, and nested (a subagent's own subagent).
//
// One run per method, each under its own harness name (its own config dir):
//
//   interrupt             query.interrupt(), no perTaskStopAffordance
//   interrupt-affordance  query.interrupt(), perTaskStopAffordance: true
//   stoptask              query.stopTask(id) on one task at a time:
//                         F (foreground leaf), NBc (nested child, foreground
//                         for its background parent), NBB (background parent
//                         with a background child and its own loop), NF
//                         (foreground parent with a foreground child), B
//                         (background leaf), then a made-up id and B again
//   close                 query.close()
//   abort                 options.abortController.abort()
//   end-input             closing the streaming input
//   taskstop-model        no host stop: the model's own TaskStop tool. A
//                         background subagent S launches its own background
//                         child, stops it, then tries to stop sibling B; then
//                         the lead is asked to stop NBBc (nested child),
//                         NBB (nested parent) and B, one at a time
//
// The tree (all subagent_type general-purpose; every leaf runs a ~90s loop
// that appends a timestamp to its own .ticks file every 2s):
//
//   send 1, background:  B (leaf), NB -> NBc (NB waits on a foreground child),
//                        NBB -> NBBc (background child) + NBB's own loop
//   send 2, foreground:  F (leaf), NF -> NFc (NF waits on a foreground child)
//                        (taskstop-model sends S instead, in the background)
//
// Ground truth for "stopped" is the .ticks files: a loop that is still alive
// keeps appending. At each checkpoint the script also lists every process
// whose command line holds this run's tick directory, and the size of every
// transcript file in the config dir.
//
//   node proofs/subagent-stop.mts <model> <case>

import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import type { HookCallbackMatcher, HookEvent, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

// TODO: undecided. Where this proof lives. The harness is not on this branch
// (it is on claude-code-harness, whose lockfile and workspace conflict with
// epic/claude-code-participant), so the proof imports it from that worktree
// by absolute path and its runs land in that worktree's gitignored runs/.
// The alternatives are to bring the harness onto this branch, or to put the
// proof on a branch off claude-code-harness.
const HARNESS = '/home/stephen/repos/@shellicar/tower/.claude/worktrees/claude-code-harness/mvp/claude-code-harness';
const { startRun } = (await import(`${HARNESS}/src/harness.mts`)) as typeof import('../../../../claude-code-harness/mvp/claude-code-harness/src/harness.mts');
const { redact, stamp } = (await import(`${HARNESS}/src/record.mts`)) as typeof import('../../../../claude-code-harness/mvp/claude-code-harness/src/record.mts');

type Case = 'interrupt' | 'interrupt-affordance' | 'stoptask' | 'close' | 'abort' | 'end-input' | 'taskstop-model';
const CASES: Case[] = ['interrupt', 'interrupt-affordance', 'stoptask', 'close', 'abort', 'end-input', 'taskstop-model'];

const [model, kase] = process.argv.slice(2) as [string | undefined, Case | undefined];
if (!model || !kase || !CASES.includes(kase)) {
  process.stderr.write(`usage: node proofs/subagent-stop.mts <model> <${CASES.join('|')}>\n`);
  process.exit(2);
}
const name = `subagent-stop-${kase}`;

// --- side channels (as proof 5) -------------------------------------------

const stateRoot = join(homedir(), '.local', 'state', 'tower-claude-code-harness');
const sideDir = join(stateRoot, 'side', `${stamp().replace(/[:.]/g, '')}-${name}`);
const bodiesDir = join(sideDir, 'api-bodies');
mkdirSync(bodiesDir, { recursive: true });
const debugFile = join(sideDir, 'debug.log');

const hookLog: string[] = [];
const HOOKED: HookEvent[] = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop', 'TaskCreated', 'TaskCompleted', 'Stop', 'SessionEnd'];
const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
for (const ev of HOOKED) {
  hooks[ev] = [
    {
      hooks: [
        async (input) => {
          hookLog.push(JSON.stringify({ ts: stamp(), event: ev, input }));
          return {};
        },
      ],
    },
  ];
}

const abortController = new AbortController();
const TOOLS = ['Agent', 'Bash', 'Read', 'TaskStop', 'ToolSearch'];

const run = startRun({
  name,
  options: {
    model,
    tools: TOOLS,
    allowedTools: TOOLS,
    hooks,
    includeHookEvents: true,
    forwardSubagentText: true,
    agentProgressSummaries: true,
    debugFile,
    ...(kase === 'interrupt-affordance' ? { perTaskStopAffordance: true } : {}),
    ...(kase === 'abort' ? { abortController } : {}),
    env: { ...process.env, OTEL_LOG_RAW_API_BODIES: `file:${bodiesDir}` },
  },
});

const summaryOut = createWriteStream(join(run.dir, 'proof-summary.txt'));
const out = (s: string): void => {
  const line = `${stamp()} ${s}`;
  process.stdout.write(`${line}\n`);
  summaryOut.write(`${line}\n`);
};
const trunc = (s: unknown, n = 300): string => {
  const str = typeof s === 'string' ? s : JSON.stringify(s);
  return str === undefined ? 'undefined' : str.length > n ? `${str.slice(0, n)}…[${str.length}]` : str;
};

// This run's tick directory, inside the proof's working directory.
const tag = `ticks-${run.id}`;
const ticksDir = join(run.cwd, tag);
mkdirSync(ticksDir, { recursive: true });
out(`run dir: ${run.dir}\nconfig dir: ${run.configDir}\ncwd: ${run.cwd}\nticks: ${ticksDir}\ncase: ${kase}\nmodel: ${model}`);

// --- prompts --------------------------------------------------------------

const loop = (who: string): string => `for i in $(seq 1 45); do date +%s.%N >> ${tag}/${who}.ticks; sleep 2; done; echo ${who} finished`;
const leaf = (who: string): string =>
  `Run exactly this shell command with the Bash tool, in the foreground (not in the background), and wait for it to finish: \`${loop(who)}\`. Do not use any other tool. Then reply with the last line it printed.`;
const fgParent = (who: string, child: string): string =>
  `Use the Agent tool exactly once, with subagent_type "general-purpose", run_in_background false, description "${child}", and this prompt, verbatim: [[${leaf(child)}]] ` +
  'Do not use any other tool. Wait for its result, then reply with it.';
const bgParentWithLoop = (who: string, child: string): string =>
  `Do two steps in order. Step 1: use the Agent tool exactly once, with subagent_type "general-purpose", run_in_background true, description "${child}", and this prompt, verbatim: [[${leaf(child)}]] ` +
  `Step 2: straight after launching it, run exactly this shell command with the Bash tool, in the foreground: \`${loop(who)}\`. Then reply with the single word done.`;
const agentCall = (desc: string, bg: boolean, prompt: string): string => `description "${desc}", run_in_background ${bg}, prompt verbatim between <<< and >>>: <<<${prompt}>>>`;

const SEND1 =
  'Use the Agent tool three times in a single message (three parallel tool calls), each with subagent_type "general-purpose":\n' +
  `(1) ${agentCall('B', true, leaf('B'))}\n` +
  `(2) ${agentCall('NB', true, fgParent('NB', 'NBc'))}\n` +
  `(3) ${agentCall('NBB', true, bgParentWithLoop('NBB', 'NBBc'))}\n` +
  'Do not use any other tool. After launching them, end your turn with the single word "launched". ' +
  'Whenever you are later told that one of them finished or was stopped, reply with the single word "noted" and nothing else.';

const SEND2 =
  'Now use the Agent tool twice in a single message (two parallel tool calls), each with subagent_type "general-purpose":\n' +
  `(1) ${agentCall('F', false, leaf('F'))}\n` +
  `(2) ${agentCall('NF', false, fgParent('NF', 'NFc'))}\n` +
  'Do not use any other tool. When they have reported, reply with the single word "done".';

const sPrompt = (siblingId: string): string =>
  'Do these steps in order. ' +
  `Step 1: use the Agent tool exactly once, with subagent_type "general-purpose", run_in_background true, description "Sc", and this prompt, verbatim: [[${leaf('Sc')}]] ` +
  'Step 2: run the shell command `sleep 8; echo waited` with the Bash tool. ' +
  "Step 3: call the TaskStop tool with task_id set to the agent id the Agent tool gave you for Sc. If TaskStop is not loaded, load it with ToolSearch first. " +
  `Step 4: call the TaskStop tool with task_id "${siblingId}". ` +
  'Then reply with the exact result text of each TaskStop call, one per line.';

const SEND2_MODEL = (siblingId: string): string =>
  `Now use the Agent tool exactly once, with subagent_type "general-purpose", ${agentCall('S', true, sPrompt(siblingId))}\n` +
  'Do not use any other tool. After launching it, end your turn with the single word "launched". When told it finished, reply "noted".';

const askStop = (id: string): string =>
  `Call the TaskStop tool with task_id "${id}" (load it with ToolSearch first if it is not loaded). Use no other tool. Then reply with the tool's exact result text and nothing else.`;

// --- state from the message stream ----------------------------------------

interface TaskInfo {
  task_id: string;
  description?: string;
  task_type?: string;
  tool_use_id?: string;
  started?: Record<string, unknown>;
  notifications: Record<string, unknown>[];
}
const tasks = new Map<string, TaskInfo>();
const byDesc = (d: string): TaskInfo | undefined => [...tasks.values()].find((t) => t.description === d && t.task_type === 'local_agent');
let results = 0;
let line = 0;
let liveBg: unknown[] = [];

const pump = (async (): Promise<void> => {
  for await (const message of run.messages() as AsyncIterable<SDKMessage>) {
    line += 1;
    const m = message as SDKMessage & Record<string, unknown>;
    const parent = 'parent_tool_use_id' in m ? (m.parent_tool_use_id as string | null) : undefined;
    const who = parent ? `sub:${parent.slice(-8)}` : 'main';
    if (m.type === 'stream_event') {
      continue;
    }
    if (m.type === 'system') {
      const s = String(m.subtype);
      if (s === 'init') {
        out(`${line} system/init session=${m.session_id} tools=${trunc(m.tools, 400)} agents=${trunc(m.agents, 200)}`);
        continue;
      }
      if (s === 'task_started' || s === 'task_notification' || s === 'task_updated' || s === 'task_progress') {
        const id = String(m.task_id);
        const t = tasks.get(id) ?? { task_id: id, notifications: [] };
        if (s === 'task_started') {
          t.description = m.description as string;
          t.task_type = m.task_type as string;
          t.tool_use_id = m.tool_use_id as string;
          t.started = m;
        }
        if (s === 'task_notification') {
          t.notifications.push(m);
        }
        tasks.set(id, t);
      }
      if (s === 'background_tasks_changed') {
        liveBg = m.tasks as unknown[];
      }
      const rest = { ...m } as Record<string, unknown>;
      delete rest.type;
      delete rest.subtype;
      delete rest.uuid;
      delete rest.session_id;
      out(`${line} system/${s} ${trunc(rest, 700)}`);
      continue;
    }
    if (m.type === 'assistant' && message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') {
          out(`${line} assistant ${who} text ${trunc(block.text.replace(/\s+/g, ' '), 300)}`);
        } else if (block.type === 'tool_use') {
          out(`${line} assistant ${who} tool_use ${block.name} id=${block.id} input=${trunc(block.input, 200)}`);
        }
      }
      continue;
    }
    if (m.type === 'user' && message.type === 'user') {
      const content = message.message.content;
      if (typeof content === 'string') {
        out(`${line} user ${who} string ${trunc(content.replace(/\s+/g, ' '), 300)} origin=${trunc(m.origin ?? '-', 100)}`);
      } else {
        for (const block of content) {
          if (block.type === 'tool_result') {
            out(`${line} user ${who} tool_result for=${block.tool_use_id} is_error=${block.is_error ?? false} ${trunc(typeof block.content === 'string' ? block.content.replace(/\s+/g, ' ') : block.content, 400)}`);
          } else if (block.type === 'text') {
            out(`${line} user ${who} text ${trunc(block.text.replace(/\s+/g, ' '), 300)} origin=${trunc(m.origin ?? '-', 100)}`);
          }
        }
      }
      continue;
    }
    if (m.type === 'result') {
      results += 1;
      out(`${line} result ${String(m.subtype)} #${results} is_error=${m.is_error} result=${trunc(m.result ?? '-', 200)} origin=${trunc(m.origin ?? '-', 100)} subagent_stats=${trunc(m.subagent_stats ?? '-', 600)}`);
      continue;
    }
    if (m.type === 'rate_limit_event') {
      out(`${line} rate_limit_event ${trunc(m.rate_limit_info ?? m, 400)}`);
      continue;
    }
    if (m.type === 'tool_progress') {
      continue;
    }
    out(`${line} ${m.type} ${trunc(m, 300)}`);
  }
  out('message stream ended');
})();

// --- observation ----------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(what: string, pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) {
      out(`gate: ${what}: yes`);
      return true;
    }
    await sleep(250);
  }
  out(`gate: ${what}: TIMED OUT after ${ms}ms`);
  return false;
}

function ticks(): Record<string, { count: number; last: number }> {
  const r: Record<string, { count: number; last: number }> = {};
  for (const f of existsSync(ticksDir) ? readdirSync(ticksDir) : []) {
    const lines = readFileSync(join(ticksDir, f), 'utf8').trim().split('\n').filter(Boolean);
    r[f.replace(/\.ticks$/, '')] = { count: lines.length, last: Number(lines.at(-1)) };
  }
  return r;
}

// Every process whose command line names this run's tick directory.
function liveLoops(): string[] {
  const found: string[] = [];
  for (const p of readdirSync('/proc')) {
    if (!/^\d+$/.test(p)) {
      continue;
    }
    try {
      const cmd = readFileSync(`/proc/${p}/cmdline`, 'utf8').replace(/\0/g, ' ');
      if (cmd.includes(tag) && Number(p) !== process.pid) {
        const stat = readFileSync(`/proc/${p}/stat`, 'utf8');
        const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        found.push(`pid ${p} ppid ${f[1]} state ${f[0]}: ${cmd.slice(0, 120)}`);
      }
    } catch {
      // gone
    }
  }
  return found;
}

function transcripts(): Record<string, number> {
  const r: Record<string, number> = {};
  const root = join(run.configDir, 'projects');
  const walk = (d: string): void => {
    for (const e of existsSync(d) ? readdirSync(d) : []) {
      const p = join(d, e);
      const st = statSync(p);
      if (st.isDirectory()) {
        walk(p);
      } else {
        r[relative(root, p)] = st.size;
      }
    }
  };
  walk(root);
  return r;
}

const checkpoints: unknown[] = [];
function checkpoint(label: string): void {
  const now = Date.now() / 1000;
  const t = ticks();
  const ages = Object.fromEntries(Object.entries(t).map(([k, v]) => [k, `${v.count} ticks, last ${(now - v.last).toFixed(1)}s ago`]));
  const loops = liveLoops();
  const tr = transcripts();
  const taskView = [...tasks.values()].map((x) => ({ id: x.task_id, desc: x.description, type: x.task_type, notes: x.notifications.map((n) => n.status) }));
  checkpoints.push({ ts: stamp(), label, ticks: t, loops, transcripts: tr, tasks: taskView, liveBg });
  out(`CHECKPOINT ${label}\n  ticks: ${JSON.stringify(ages)}\n  live loop processes: ${loops.length}\n    ${loops.join('\n    ')}\n  tasks: ${JSON.stringify(taskView)}\n  live background (last background_tasks_changed): ${trunc(liveBg, 600)}\n  transcripts: ${JSON.stringify(tr)}`);
}

const send = (text: string): void => {
  out(`host: send ${trunc(text, 160)}`);
  run.send({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
};
const tickFile = (who: string): boolean => existsSync(join(ticksDir, `${who}.ticks`));

async function hostStop(desc: string, id: string | undefined): Promise<void> {
  if (!id) {
    out(`host: stopTask(${desc}): no task id known`);
    return;
  }
  const t0 = Date.now();
  out(`host: stopTask(${id}) [${desc}]`);
  try {
    await run.query.stopTask(id);
    out(`host: stopTask(${id}) [${desc}] resolved after ${Date.now() - t0}ms`);
  } catch (e) {
    out(`host: stopTask(${id}) [${desc}] threw after ${Date.now() - t0}ms: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// --- the scenario -----------------------------------------------------------

const HARD_MS = 12 * 60_000;
const hard = setTimeout(() => {
  out('hard cap reached: close()');
  run.query.close();
}, HARD_MS);

send(SEND1);
await waitFor('send 1 answered', () => results >= 1, 120_000);
await waitFor('B, NBc, NBB, NBBc ticking', () => ['B', 'NBc', 'NBB', 'NBBc'].every(tickFile), 120_000);

if (kase === 'taskstop-model') {
  const bId = byDesc('B')?.task_id ?? 'unknown';
  send(SEND2_MODEL(bId));
  await waitFor('S answered', () => results >= 2, 120_000);
  // S's own TaskStop calls happen in the background; give it time.
  await waitFor('S finished (task_notification)', () => (byDesc('S')?.notifications.length ?? 0) > 0, 180_000);
  checkpoint('after S');
  for (const desc of ['NBBc', 'NBB', 'B']) {
    const id = byDesc(desc)?.task_id ?? `unknown-${desc}`;
    const before = results;
    send(askStop(id));
    await waitFor(`lead answered TaskStop(${desc})`, () => results > before, 120_000);
    await sleep(5000);
    checkpoint(`5s after lead TaskStop(${desc})`);
  }
} else {
  send(SEND2);
  await waitFor('F, NFc ticking', () => ['F', 'NFc'].every(tickFile), 120_000);
  await sleep(6000);
  checkpoint('before stop');

  const t0 = Date.now();
  if (kase === 'interrupt' || kase === 'interrupt-affordance') {
    out('host: interrupt()');
    const r = await run.interrupt();
    out(`host: interrupt() resolved after ${Date.now() - t0}ms: ${trunc(r ?? null)}`);
  } else if (kase === 'close') {
    out('host: close()');
    run.query.close();
  } else if (kase === 'abort') {
    out('host: abortController.abort()');
    abortController.abort();
  } else if (kase === 'end-input') {
    out('host: end()');
    run.end();
  } else if (kase === 'stoptask') {
    for (const desc of ['F', 'NBc', 'NBB', 'NF']) {
      await hostStop(desc, byDesc(desc)?.task_id);
      await sleep(8000);
      checkpoint(`8s after stopTask(${desc})`);
    }
    await hostStop('B', byDesc('B')?.task_id);
    await sleep(3000);
    await hostStop('made-up id', 'no-such-task-0000');
    await hostStop('B again', byDesc('B')?.task_id);
  }
  await sleep(3000);
  checkpoint('3s after stop');
  await sleep(15_000);
  checkpoint('18s after stop');
}

await sleep(15_000);
checkpoint('before ending input');
if (kase !== 'end-input' && kase !== 'close') {
  run.end();
}
const settled = await Promise.race([run.done.then(() => 'done', (e) => `rejected: ${e instanceof Error ? e.message : String(e)}`), sleep(240_000).then(() => 'still running')]);
out(`run.done: ${settled}`);
if (settled === 'still running') {
  out('host: close() after 240s');
  run.query.close();
  await run.done.catch(() => undefined);
}
clearTimeout(hard);
await pump.catch((e) => out(`pump error: ${e instanceof Error ? e.message : String(e)}`));
checkpoint('after the run');
await sleep(10_000);
checkpoint('10s after the run');

// --- copy side channels in, redacted -------------------------------------

const put = (to: string, text: string): void => writeFileSync(to, redact(text).text);
put(join(run.dir, 'hooks.jsonl'), hookLog.map((l) => `${l}\n`).join(''));
put(join(run.dir, 'checkpoints.json'), `${JSON.stringify(checkpoints, null, 2)}\n`);
if (existsSync(debugFile)) {
  put(join(run.dir, 'debug.log'), readFileSync(debugFile, 'utf8'));
}
const bodiesOut = join(run.dir, 'api-bodies');
mkdirSync(bodiesOut, { recursive: true });
for (const entry of existsSync(bodiesDir) ? readdirSync(bodiesDir) : []) {
  put(join(bodiesOut, entry), readFileSync(join(bodiesDir, entry), 'utf8'));
}
const tickOut = join(run.dir, 'ticks');
mkdirSync(tickOut, { recursive: true });
for (const f of existsSync(ticksDir) ? readdirSync(ticksDir) : []) {
  put(join(tickOut, f), readFileSync(join(ticksDir, f), 'utf8'));
}
out(`hooks: ${hookLog.length} lines`);
await new Promise((r) => summaryOut.end(r));
