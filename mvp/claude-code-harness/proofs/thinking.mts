// Proof 1: summarised thinking, end to end (Stephen, 26 Sep: "what are the
// different methods to get summarised thinking, and the thinking streaming
// working"; "thinking on sonnet, opus, fable is what i want").
//
// One run per scenario, on one model:
//
//   summarized  thinking {adaptive, display 'summarized'}; one turn.
//               Do thinking_delta events carry text as they stream, and does
//               the complete assistant message carry the summary?
//   omitted     thinking {adaptive, display 'omitted'}; one turn.
//               Are the empty thinking blocks emitted as messages, or dropped?
//   none        no thinking option at all; one turn. What is requested?
//   long        thinking {adaptive}, no display; one turn with a question
//               that takes long thinking, in case "no display" returns text
//               only past some length.
//   long-summarized  thinking {adaptive, display 'summarized'}; the long
//               question. Does the summary arrive over the thinking, or in
//               one burst at its end?
//   tools       thinking {adaptive}, no display, the Read tool; one turn
//               that reads three files in turn. "No display" asks for
//               display "updates"; does anything come back between tool
//               calls (connector_text blocks)?
//   setting     no thinking option; settings {showThinkingSummaries: true}
//               through the SDK's settings option. Does the setting reach an
//               SDK session's request?
//   switch      thinking {adaptive}, no display; four turns. Turns 1 to 3
//               show what "no display" requests and returns. Turn 1 carries
//               padding so the prompt is long enough to cache. Turn 3's cache
//               read against turn 2 is the control: turn 2 is not, because
//               the account's claude.ai connectors join the tool list after
//               turn 1 and change the prefix. Then
//               setMaxThinkingTokens(null, 'summarized') and turn 4: does the
//               display switch, and does its cache read drop against turn 3?
//
// Every run streams (includePartialMessages) and has no built-in tools, so
// each turn is one API request.
//
// What was requested is not visible between the SDK and the binary. Claude
// Code 2.1.282 writes each API request and response body to a directory when
// OTEL_LOG_RAW_API_BODIES=file:<dir> (its own feature, no proxy). It
// replaces thinking text in both with "<REDACTED>", so the bodies show what
// was asked and the block shapes; the text itself is in the SDK messages.
// The beta list rides in the body (`betas`). The debug log is kept too. Both land in the run directory, under api-bodies/ and
// debug.log, redacted like everything else the harness writes.
//
//   node proofs/thinking.mts <model> <scenario> [NAME=value ...]
//
// Trailing NAME=value pairs are added to Claude Code's environment (e.g.
// CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1), and recorded as names in
// run.json like any other env.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HarnessOptions } from '../src/harness.mts';
import { startRun } from '../src/harness.mts';
import { redact, stamp } from '../src/record.mts';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

type Scenario = 'summarized' | 'omitted' | 'none' | 'long' | 'long-summarized' | 'tools' | 'setting' | 'switch';
const SCENARIOS: Scenario[] = ['summarized', 'omitted', 'none', 'long', 'long-summarized', 'tools', 'setting', 'switch'];

const TOOLS_PROMPT =
  'Read step-1.txt in the working directory. It names the next file to read; follow the chain until a file gives you a number, then reply with that number only. Read one file per tool call.';

// Questions that should make adaptive thinking actually think, each with a
// short checkable answer.
const TURNS = [
  'How many integers n with 1 <= n <= 300 are divisible by 3 or 5 but not by 7? Work it out, then reply with the number only.',
  'How many ways can 12 be written as an ordered sum of 1s, 2s and 3s? Work it out, then reply with the number only.',
  'What is the sum of the digits of 2^40? Work it out, then reply with the number only.',
  'How many positive divisors does 10! have? Work it out, then reply with the number only.',
];

const LONG =
  'How many 7-digit positive integers have digits that sum to 30 and are divisible by 11? Work it out carefully by hand, checking each step, then reply with the number only.';

// The switch scenario's cache comparison needs a prompt above the minimum
// cacheable length (a turn-1 request of a few hundred tokens caches
// nothing), so its first turn carries this block, about 10k tokens.
const PADDING = Array.from({ length: 800 }, (_, i) => `Reference line ${i + 1}: this line is padding so the prompt is long enough to be cached.`).join('\n');

const [model, scenario, ...extraEnv] = process.argv.slice(2);
if (!model || !SCENARIOS.includes(scenario as Scenario)) {
  process.stderr.write(`usage: node proofs/thinking.mts <model> <${SCENARIOS.join('|')}> [NAME=value ...]\n`);
  process.exit(2);
}

const envAdd: Record<string, string> = {};
for (const pair of extraEnv) {
  const at = pair.indexOf('=');
  if (at <= 0) {
    process.stderr.write(`thinking: not NAME=value: ${pair}\n`);
    process.exit(2);
  }
  envAdd[pair.slice(0, at)] = pair.slice(at + 1);
}

const name = `thinking-${scenario}`;
// The run directory is only known once startRun returns, and the env has to
// be passed to it, so the bodies go to a directory of their own first and
// are copied in afterwards (redacted).
const bodiesDir = join(homedir(), '.local', 'state', 'tower-claude-code-harness', 'api-bodies', `${stamp().replace(/[:.]/g, '')}-${name}`);
mkdirSync(bodiesDir, { recursive: true });
const debugFile = join(bodiesDir, 'debug.log');

const thinking: HarnessOptions['thinking'] =
  scenario === 'summarized' || scenario === 'long-summarized'
    ? { type: 'adaptive', display: 'summarized' }
    : scenario === 'omitted'
      ? { type: 'adaptive', display: 'omitted' }
      : scenario === 'switch' || scenario === 'long' || scenario === 'tools'
        ? { type: 'adaptive' }
        : undefined;

const options: HarnessOptions = {
  model,
  includePartialMessages: true,
  tools: scenario === 'tools' ? ['Read'] : [],
  ...(scenario === 'setting' ? { settings: { showThinkingSummaries: true } } : {}),
  debugFile,
  env: { ...process.env, ...envAdd, OTEL_LOG_RAW_API_BODIES: `file:${bodiesDir}` },
  ...(thinking ? { thinking } : {}),
};

const run = startRun({ name, options });
process.stdout.write(`run dir: ${run.dir}\nmodel: ${model}\nscenario: ${scenario}\nextra env: ${Object.keys(envAdd).join(',') || '-'}\n`);

if (scenario === 'tools') {
  writeFileSync(join(run.cwd, 'step-1.txt'), 'Next: read step-2.txt\n');
  writeFileSync(join(run.cwd, 'step-2.txt'), 'Next: read step-3.txt\n');
  writeFileSync(join(run.cwd, 'step-3.txt'), 'The number is 4817.\n');
}

const turnCount = scenario === 'switch' ? 4 : 1;
const switchAfter = 3;

// Line numbers in sdk-messages.jsonl: the harness writes every message there
// in the order it hands them out, one per line, so message i is line i + 1.
let line = 0;
let turn = 0;

interface TurnStats {
  thinkingStarts: { line: number; ts: string }[];
  thinkingDeltas: { line: number; ts: string; chars: number }[];
  signatureDeltas: number;
  otherBlockStarts: string[];
  thinkingTokenMessages: number;
  assistantThinking: { line: number; chars: number; preview: string }[];
  assistantLines: number[];
  resultLine?: number;
  usage?: unknown;
}
const stats: TurnStats[] = [];
const newTurn = (): TurnStats => ({ thinkingStarts: [], thinkingDeltas: [], signatureDeltas: 0, otherBlockStarts: [], thinkingTokenMessages: 0, assistantThinking: [], assistantLines: [] });

const send = (text: string): void => {
  turn += 1;
  stats.push(newTurn());
  process.stdout.write(`\n--- turn ${turn}: ${text.length > 300 ? `[${text.length} chars] ${text.slice(-200)}` : text}\n`);
  run.send({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
};

const first: Record<Scenario, string> = {
  summarized: TURNS[0],
  omitted: TURNS[0],
  none: TURNS[0],
  setting: TURNS[0],
  long: LONG,
  'long-summarized': LONG,
  tools: TOOLS_PROMPT,
  switch: `${PADDING}\n\nIgnore the reference lines above.\n\n${TURNS[0]}`,
};
send(first[scenario as Scenario]);

for await (const message of run.messages() as AsyncIterable<SDKMessage>) {
  line += 1;
  const ts = stamp();
  const s = stats[turn - 1];
  if (message.type === 'system' && message.subtype === 'thinking_tokens') {
    s.thinkingTokenMessages += 1;
  }
  if (message.type === 'system' && message.subtype === 'init') {
    process.stdout.write(`init.model: ${message.model} (line ${line})\n`);
  }
  if (message.type === 'stream_event') {
    const ev = message.event;
    if (ev.type === 'content_block_start') {
      if (ev.content_block.type === 'thinking' || ev.content_block.type === 'redacted_thinking') {
        s.thinkingStarts.push({ line, ts });
      } else {
        s.otherBlockStarts.push(`${ev.content_block.type}@${line}`);
      }
    }
    if (ev.type === 'content_block_delta') {
      if (ev.delta.type === 'thinking_delta') {
        s.thinkingDeltas.push({ line, ts, chars: ev.delta.thinking.length });
      } else if (ev.delta.type === 'signature_delta') {
        s.signatureDeltas += 1;
      }
    }
  }
  if (message.type === 'assistant') {
    s.assistantLines.push(line);
    for (const block of message.message.content) {
      if (block.type === 'thinking') {
        s.assistantThinking.push({ line, chars: block.thinking.length, preview: block.thinking.slice(0, 160).replace(/\s+/g, ' ') });
      }
      if (block.type === 'text') {
        process.stdout.write(`assistant text (line ${line}): ${block.text}\n`);
      }
      if (block.type === 'tool_use') {
        process.stdout.write(`assistant tool_use (line ${line}): ${block.name} ${JSON.stringify(block.input)}\n`);
      }
    }
  }
  if (message.type === 'result') {
    s.resultLine = line;
    s.usage = message.usage;
    process.stdout.write(`result (line ${line}): ${message.subtype}${message.is_error ? ' (error)' : ''}\n`);
    report(turn, s);
    if (turn < turnCount) {
      if (scenario === 'switch' && turn === switchAfter) {
        process.stdout.write(`\nsetMaxThinkingTokens(null, 'summarized') at ${stamp()}\n`);
        await run.query.setMaxThinkingTokens(null, 'summarized');
      }
      send(TURNS[turn]);
    } else {
      run.end();
    }
  }
}

function report(n: number, s: TurnStats): void {
  const deltaChars = s.thinkingDeltas.reduce((sum, d) => sum + d.chars, 0);
  const nonEmpty = s.thinkingDeltas.filter((d) => d.chars > 0);
  process.stdout.write(`turn ${n} thinking content_block_start: ${s.thinkingStarts.length} ${JSON.stringify(s.thinkingStarts.map((t) => t.line))}\n`);
  process.stdout.write(`turn ${n} thinking_delta events: ${s.thinkingDeltas.length}, non-empty ${nonEmpty.length}, total chars ${deltaChars}\n`);
  if (nonEmpty.length > 0) {
    const first = nonEmpty[0];
    const last = nonEmpty[nonEmpty.length - 1];
    process.stdout.write(`turn ${n} first non-empty thinking_delta line ${first.line} at ${first.ts}; last line ${last.line} at ${last.ts}\n`);
  }
  process.stdout.write(`turn ${n} signature_delta events: ${s.signatureDeltas}\n`);
  process.stdout.write(`turn ${n} system thinking_tokens messages: ${s.thinkingTokenMessages}\n`);
  process.stdout.write(`turn ${n} other block starts: ${s.otherBlockStarts.join(' ') || '-'}\n`);
  process.stdout.write(`turn ${n} assistant message lines: ${JSON.stringify(s.assistantLines)}\n`);
  process.stdout.write(`turn ${n} assistant thinking blocks: ${JSON.stringify(s.assistantThinking)}\n`);
  process.stdout.write(`turn ${n} result usage: ${JSON.stringify(s.usage)}\n`);
}

let failed = false;
try {
  await run.done;
} catch (err) {
  failed = true;
  process.stdout.write(`failed: ${err instanceof Error ? err.message : String(err)}\n`);
}

// Copy the bodies and the debug log into the run directory, redacted.
const outDir = join(run.dir, 'api-bodies');
mkdirSync(outDir, { recursive: true });
let redactions = 0;
for (const entry of existsSync(bodiesDir) ? readdirSync(bodiesDir) : []) {
  const { text, count } = redact(readFileSync(join(bodiesDir, entry), 'utf8'));
  redactions += count;
  writeFileSync(entry === 'debug.log' ? join(run.dir, 'debug.log') : join(outDir, entry), text);
}
process.stdout.write(`\ncopied ${bodiesDir} -> ${outDir} (${redactions} redactions)\n`);

// What each request asked for about thinking, from the request bodies in
// index order.
const indexPath = join(outDir, 'index.jsonl');
if (existsSync(indexPath)) {
  const index = readFileSync(indexPath, 'utf8').trim().split('\n').filter(Boolean);
  index.forEach((raw, i) => {
    const entry = JSON.parse(raw) as { query_source?: string; model?: string; request_file?: string; response_file?: string };
    const req = entry.request_file && existsSync(join(outDir, entry.request_file)) ? (JSON.parse(readFileSync(join(outDir, entry.request_file), 'utf8')) as Record<string, unknown>) : undefined;
    const res = entry.response_file && existsSync(join(outDir, entry.response_file)) ? (JSON.parse(readFileSync(join(outDir, entry.response_file), 'utf8')) as { content?: { type: string; thinking?: string }[]; usage?: unknown }) : undefined;
    process.stdout.write(
      `request ${i + 1} (index.jsonl line ${i + 1}) source=${entry.query_source} model=${entry.model} file=${entry.request_file}\n` +
        `  thinking=${JSON.stringify(req?.thinking)} output_config=${JSON.stringify(req?.output_config)} betas=${JSON.stringify(req?.betas)} keys=${Object.keys(req ?? {}).join(',')}\n` +
        `  response ${entry.response_file}: blocks=${JSON.stringify(res?.content?.map((b) => (b.type === 'thinking' ? `thinking(${b.thinking?.length})` : b.type)))} usage=${JSON.stringify(res?.usage)}\n`,
    );
  });
} else {
  process.stdout.write('no index.jsonl: no request bodies were written\n');
}

if (failed) {
  process.exitCode = 1;
}
