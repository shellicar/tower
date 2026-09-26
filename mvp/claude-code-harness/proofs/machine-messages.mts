// Proof 15: which messages Claude Code writes itself, how it marks them, and
// which of them reach the model (Stephen, 26 Sep: "user = my side of the API /
// assistant = your side of the API"; "the message didnt originate from the
// user / but the message to the model still comes from the machine, just like
// a tool result"; "well we should confirm, what does it show in the
// transcript?").
//
// Most kinds are already in the earlier proofs' runs. This proof runs only the
// kinds those runs don't show, or show without request bodies:
//
//   interrupt-tool  a Bash call (wait.sh, sleep 25) interrupted with
//                   query.interrupt() while it runs, then one more prompt.
//                   Writes "[Request interrupted by user for tool use]".
//   compact         one prompt, then "/compact", then one more prompt.
//                   Writes the compaction summary and its boundary.
//   skill           "/tower-harness-smoke:tower-harness-positive-probe" (a
//                   skill invoked as a slash command), then one more prompt.
//                   Writes <command-message> and the skill's
//                   "Base directory for this skill" entry.
//   stop-hook       a Stop hook (SDK callback) that blocks the first stop with
//                   a reason, then lets the second one through.
//
// What was sent to the model is read from Claude Code's own request body log
// (OTEL_LOG_RAW_API_BODIES, as proofs 1 and 6), copied redacted into
// <run>/api-bodies/. The transcript is in <run>/config-dir/projects/.
//
//   node proofs/machine-messages.mts <model> <scenario>

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HookCallback, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { HarnessOptions } from '../src/harness.mts';
import { startRun } from '../src/harness.mts';
import { redact, stamp } from '../src/record.mts';

type Scenario = 'interrupt-tool' | 'compact' | 'skill' | 'stop-hook';
const SCENARIOS: Scenario[] = ['interrupt-tool', 'compact', 'skill', 'stop-hook'];

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), 'smoke-plugin');
const WAIT_SH = 'sleep 25\necho waited\n';
const STOP_REASON = 'PROOF15-STOP-HOOK-REASON: before stopping, reply with the word AGAIN on its own line.';

const out = (s: string): void => {
  process.stdout.write(`${s}\n`);
};

const [model, scenario] = process.argv.slice(2) as [string, Scenario];
if (!model || !SCENARIOS.includes(scenario)) {
  process.stderr.write(`usage: node proofs/machine-messages.mts <model> <${SCENARIOS.join('|')}>\n`);
  process.exit(2);
}

const name = `machine-${scenario}`;
const bodiesDir = join(homedir(), '.local', 'state', 'tower-claude-code-harness', 'api-bodies', `${stamp().replace(/[:.]/g, '')}-${name}`);
mkdirSync(bodiesDir, { recursive: true });

let stopCalls = 0;
const stopHook: HookCallback = async () => {
  stopCalls += 1;
  note(`Stop hook call ${stopCalls}`);
  return stopCalls === 1 ? { decision: 'block', reason: STOP_REASON } : {};
};

const options: HarnessOptions = {
  model,
  tools: scenario === 'interrupt-tool' ? ['Bash'] : [],
  ...(scenario === 'interrupt-tool' ? { allowedTools: ['Bash'] } : {}),
  ...(scenario === 'skill' ? { plugins: [{ type: 'local' as const, path: PLUGIN_DIR }] } : {}),
  ...(scenario === 'stop-hook' ? { hooks: { Stop: [{ hooks: [stopHook] }] } } : {}),
  env: { ...process.env, OTEL_LOG_RAW_API_BODIES: `file:${bodiesDir}` },
};

const notes: { at: string; what: string; detail?: unknown }[] = [];
function note(what: string, detail?: unknown): void {
  const at = stamp();
  notes.push({ at, what, detail });
  out(`[${at}] ${what}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
}

const run = startRun({ name, options });
out(`run dir: ${run.dir}\nmodel: ${model}\nscenario: ${scenario}`);
writeFileSync(join(run.cwd, 'wait.sh'), WAIT_SH);

const TURNS: Record<Scenario, string[]> = {
  'interrupt-tool': ['Run `bash wait.sh` in the working directory with the Bash tool, then reply DONE.', 'Reply with the word TWO and nothing else.'],
  compact: ['Reply with the word ONE and nothing else.', '/compact', 'Reply with the word TWO and nothing else.'],
  skill: ['/tower-harness-smoke:tower-harness-positive-probe', 'Reply with the word TWO and nothing else.'],
  'stop-hook': ['Reply with the word ONE and nothing else.'],
};
const turns = TURNS[scenario];

let turn = 0;
const send = (text: string): void => {
  turn += 1;
  note(`send turn ${turn}`, text);
  run.send({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
};

send(turns[0]);
let interrupted = false;
for await (const message of run.messages() as AsyncIterable<SDKMessage>) {
  if (scenario === 'interrupt-tool' && !interrupted && message.type === 'assistant' && message.message.content.some((b) => b.type === 'tool_use')) {
    interrupted = true;
    note('tool_use seen; interrupting in 3 s');
    setTimeout(() => {
      note('interrupt');
      run.interrupt().then(
        () => note('interrupt returned'),
        (err: unknown) => note('interrupt failed', String(err)),
      );
    }, 3000);
    continue;
  }
  if (message.type !== 'result') {
    continue;
  }
  note(`result for turn ${turn}`, { subtype: message.subtype, is_error: message.is_error });
  if (turn < turns.length) {
    send(turns[turn]);
  } else {
    run.end();
  }
}

let failed = false;
try {
  await run.done;
} catch (err) {
  failed = true;
  out(`failed: ${err instanceof Error ? err.message : String(err)}`);
}

writeFileSync(join(run.dir, 'proof-notes.jsonl'), notes.map((n) => `${redact(JSON.stringify(n)).text}\n`).join(''));

const outDir = join(run.dir, 'api-bodies');
mkdirSync(outDir, { recursive: true });
let redactions = 0;
for (const entry of existsSync(bodiesDir) ? readdirSync(bodiesDir) : []) {
  const { text, count } = redact(readFileSync(join(bodiesDir, entry), 'utf8'));
  redactions += count;
  writeFileSync(join(outDir, entry), text);
}
out(`copied ${bodiesDir} -> ${outDir} (${redactions} redactions)`);
if (failed) {
  process.exitCode = 1;
}
