// Proof 6: the max_tokens Claude Code sends (Stephen, 26 Sep: tower's
// turn.started.maxTokens is "required because it's required to hit the
// Claude API / but claude code has a default value"). Can the participant
// know the value Claude Code actually sends, and why does it rise after the
// first request?
//
// One run per scenario, on one model. Every scenario but `hit` sends the same
// three turns: turn 1 follows a chain of three files with the Read tool (four
// API requests in one turn), turns 2 and 3 are one-word replies (one request
// each). What differs is CLAUDE_CODE_MAX_OUTPUT_TOKENS and when it is set:
//
//   unset      not set at all.
//   delayed    not set; the first message is sent only after Claude Code's
//              start-up "[Bootstrap]" fetch has finished (waits until the
//              debug log says "[Bootstrap] Fetch ok"). Tests whether that
//              fetch is what raises the value after the first request.
//   env        4096, set at start-up.
//   env-over   1000000, set at start-up: above any model's limit.
//   live       not set for turn 1; applyFlagSettings({env: 4096}) before
//              turn 2; applyFlagSettings({env: 1000000}) before turn 3.
//   hit        256, set at start-up; one turn that asks for a long answer, so
//              the response stops on max_tokens. What does the SDK say then?
//
// What was sent is read from Claude Code's own request body log
// (OTEL_LOG_RAW_API_BODIES, as proof 1). What the SDK reports is every
// result message's modelUsage[model].maxOutputTokens, plus any SDK message
// that mentions max_tokens or an output token maximum. The debug log's
// request dispatch lines, its [Bootstrap] lines and anything it logs about
// CLAUDE_CODE_MAX_OUTPUT_TOKENS are printed with their line numbers.
//
//   node proofs/max-tokens.mts <model> <scenario>
//   node proofs/max-tokens.mts --summarise <run dir>

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { HarnessOptions } from '../src/harness.mts';
import { startRun } from '../src/harness.mts';
import { redact, stamp } from '../src/record.mts';

type Scenario = 'unset' | 'delayed' | 'env' | 'env-over' | 'live' | 'hit';
const SCENARIOS: Scenario[] = ['unset', 'delayed', 'env', 'env-over', 'live', 'hit'];

const CHAIN_PROMPT =
  'Read step-1.txt in the working directory. It names the next file to read; follow the chain until a file gives you a number, then reply with that number only. Read one file per tool call.';
const TURNS = [CHAIN_PROMPT, 'Reply with the word TWO and nothing else.', 'Reply with the word THREE and nothing else.'];
const HIT_PROMPT = 'Write a 2,000-word short story about a lighthouse keeper. Start writing straight away, with no preamble.';

const out = (s: string): void => {
  process.stdout.write(`${s}\n`);
};

if (process.argv[2] === '--summarise') {
  const dir = process.argv[3];
  if (!dir) {
    process.stderr.write('usage: node proofs/max-tokens.mts --summarise <run dir>\n');
    process.exit(2);
  }
  summarise(dir);
  process.exit(0);
}

const [model, scenario] = process.argv.slice(2) as [string, Scenario];
if (!model || !SCENARIOS.includes(scenario)) {
  process.stderr.write(`usage: node proofs/max-tokens.mts <model> <${SCENARIOS.join('|')}>\n`);
  process.exit(2);
}

const startEnv: Record<string, string> = scenario === 'env' ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '4096' } : scenario === 'env-over' ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '1000000' } : scenario === 'hit' ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '256' } : {};

const name = `max-tokens-${scenario}`;
const bodiesDir = join(homedir(), '.local', 'state', 'tower-claude-code-harness', 'api-bodies', `${stamp().replace(/[:.]/g, '')}-${name}`);
mkdirSync(bodiesDir, { recursive: true });
const debugFile = join(bodiesDir, 'debug.log');

const env: Record<string, string | undefined> = { ...process.env, ...startEnv, OTEL_LOG_RAW_API_BODIES: `file:${bodiesDir}` };
// The proof's own shell may carry the variable; only the scenario sets it.
if (!('CLAUDE_CODE_MAX_OUTPUT_TOKENS' in startEnv)) {
  delete env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
}

const options: HarnessOptions = {
  model,
  tools: scenario === 'hit' ? [] : ['Read'],
  debugFile,
  env,
};

const run = startRun({ name, options });
out(`run dir: ${run.dir}\nmodel: ${model}\nscenario: ${scenario}\nstart env: ${JSON.stringify(startEnv)}`);

writeFileSync(join(run.cwd, 'step-1.txt'), 'Next: read step-2.txt\n');
writeFileSync(join(run.cwd, 'step-2.txt'), 'Next: read step-3.txt\n');
writeFileSync(join(run.cwd, 'step-3.txt'), 'The number is 4817.\n');

const notes: { at: string; what: string; detail?: unknown }[] = [];
const note = (what: string, detail?: unknown): void => {
  const at = stamp();
  notes.push({ at, what, detail });
  out(`[${at}] ${what}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
};

let turn = 0;
const send = (text: string): void => {
  turn += 1;
  note(`send turn ${turn}`, text);
  run.send({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
};

if (scenario === 'delayed') {
  // Wait for the start-up fetch before the first message.
  const deadline = Date.now() + 60_000;
  for (;;) {
    const log = existsSync(debugFile) ? readFileSync(debugFile, 'utf8') : '';
    if (log.includes('[Bootstrap] Fetch ok') || log.includes('[Bootstrap] Cache unchanged') || log.includes('[Bootstrap] Cache updated')) {
      note('debug log shows the [Bootstrap] fetch finished');
      break;
    }
    if (Date.now() >= deadline) {
      note('no [Bootstrap] line in the debug log after 60s; sending anyway');
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const turnCount = scenario === 'hit' ? 1 : TURNS.length;
send(scenario === 'hit' ? HIT_PROMPT : TURNS[0]);

for await (const message of run.messages() as AsyncIterable<SDKMessage>) {
  if (message.type !== 'result') {
    continue;
  }
  note(`result for turn ${turn}`, { subtype: message.subtype, is_error: message.is_error });
  if (turn < turnCount) {
    if (scenario === 'live') {
      const value = turn === 1 ? '4096' : '1000000';
      note(`applyFlagSettings({env: {CLAUDE_CODE_MAX_OUTPUT_TOKENS: '${value}'}})`);
      const reply = await run.query.applyFlagSettings({ env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: value } });
      note('applyFlagSettings returned', reply);
    }
    send(TURNS[turn]);
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
  writeFileSync(entry === 'debug.log' ? join(run.dir, 'debug.log') : join(outDir, entry), text);
}
out(`\ncopied ${bodiesDir} -> ${outDir} (${redactions} redactions)\n`);

const summary = summarise(run.dir);
writeFileSync(join(run.dir, 'summary.txt'), summary);
if (failed) {
  process.exitCode = 1;
}

// The comparison, from the run directory alone: each request's max_tokens
// (api-bodies), what each result reported (sdk-messages.jsonl), and the
// debug log lines that explain them. Printed and returned.
function summarise(dir: string): string {
  const lines: string[] = [];
  const say = (s: string): void => {
    lines.push(s);
    out(s);
  };
  say(`=== summary of ${dir}`);

  const bodies = join(dir, 'api-bodies');
  const indexPath = join(bodies, 'index.jsonl');
  say('\n-- requests (api-bodies/index.jsonl, in order)');
  if (existsSync(indexPath)) {
    readFileSync(indexPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .forEach((raw, i) => {
        const e = JSON.parse(raw) as { timestamp?: string; query_source?: string; model?: string; request_file?: string; response_file?: string };
        const reqPath = e.request_file ? join(bodies, e.request_file) : undefined;
        const req = reqPath && existsSync(reqPath) ? (JSON.parse(readFileSync(reqPath, 'utf8')) as { max_tokens?: number; thinking?: unknown }) : undefined;
        const resPath = e.response_file ? join(bodies, e.response_file) : undefined;
        const res = resPath && existsSync(resPath) ? (JSON.parse(readFileSync(resPath, 'utf8')) as { stop_reason?: string; usage?: { output_tokens?: number } }) : undefined;
        say(`index line ${i + 1} ${e.timestamp} source=${e.query_source} model=${e.model} max_tokens=${req?.max_tokens} thinking=${JSON.stringify(req?.thinking)} stop_reason=${res?.stop_reason} output_tokens=${res?.usage?.output_tokens} file=${e.request_file}`);
      });
  } else {
    say('no index.jsonl');
  }

  say('\n-- what the SDK reported (sdk-messages.jsonl)');
  const sdkPath = join(dir, 'sdk-messages.jsonl');
  if (existsSync(sdkPath)) {
    readFileSync(sdkPath, 'utf8')
      .split('\n')
      .forEach((raw, i) => {
        if (!raw) {
          return;
        }
        const { message } = JSON.parse(raw) as { message: SDKMessage };
        if (message.type === 'result') {
          const usage = Object.fromEntries(Object.entries(message.modelUsage ?? {}).map(([k, v]) => [k, { maxOutputTokens: v.maxOutputTokens, outputTokens: v.outputTokens, contextWindow: v.contextWindow }]));
          say(`line ${i + 1} result ${message.subtype} stop_reason=${(message as { stop_reason?: string }).stop_reason} modelUsage=${JSON.stringify(usage)}`);
          return;
        }
        if (message.type === 'system' && message.subtype === 'init') {
          say(`line ${i + 1} init model=${message.model}`);
        }
        // Anything else that names an output limit.
        if (/max_tokens|maxOutputTokens|output token maximum|max_output_tokens/i.test(raw)) {
          const hits = raw.match(/.{0,120}(max_tokens|maxOutputTokens|output token maximum|max_output_tokens).{0,120}/gi) ?? [];
          say(`line ${i + 1} ${message.type}${'subtype' in message ? `/${message.subtype}` : ''}: ${hits.join(' | ')}`);
        }
      });
  }

  say('\n-- debug.log');
  const debugPath = join(dir, 'debug.log');
  if (existsSync(debugPath)) {
    readFileSync(debugPath, 'utf8')
      .split('\n')
      .forEach((l, i) => {
        if (/\[Bootstrap\]|\[API REQUEST\]|dispatching to|CLAUDE_CODE_MAX_OUTPUT_TOKENS|max_tokens|output token|applyFlagSettings|apply_flag_settings/i.test(l)) {
          say(`debug.log:${i + 1} ${l.slice(0, 260)}`);
        }
      });
  }

  const notesPath = join(dir, 'proof-notes.jsonl');
  if (existsSync(notesPath)) {
    say('\n-- proof notes (proof-notes.jsonl)');
    readFileSync(notesPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .forEach((l, i) => say(`proof-notes.jsonl:${i + 1} ${l.slice(0, 260)}`));
  }
  return `${lines.join('\n')}\n`;
}
