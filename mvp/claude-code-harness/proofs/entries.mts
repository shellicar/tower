// Proof 2: how Claude Code's transcript entries map to messages (Stephen,
// 26 Sep: tower shows what the model sees, on `changes`, with Claude Code's
// own ids; "what the model sees is the *CORE* ie the minimum / anything else
// is potentially helpful to the *user*").
//
// One run, four turns, on one model:
//
//   turn 1   sent with a client uuid, content as two text blocks. Asks for
//            thinking, a sentence, then two Read calls in one response, so
//            one API response holds thinking + text + tool_use + tool_use.
//   turn 2   sent while turn 1 is still running (on turn 1's first
//            tool_use), no client uuid. Is it queued, folded into turn 1,
//            and what does the transcript write for it?
//   turn 3   a long reply, interrupted on its first streamed text delta.
//   turn 4   a short reply after the interrupt: what does the model see of
//            the interrupted turn?
//
// A phase moves on once the run has been quiet for QUIET_MS after a result
// (a queued message may run as its own turn, with its own result).
//
// Scenarios: `default` (the SDK's own flags) and `replay` (adds
// --replay-user-messages, so the binary echoes each sent user message back
// with its uuid).
//
// What was sent to the model is recorded by Claude Code itself:
// OTEL_LOG_RAW_API_BODIES=file:<dir> writes each API request and response
// body (the technique proof 1, thinking.mts, uses). Thinking text is
// "<REDACTED>" in those bodies; the SDK messages carry it.
//
// After the run the proof prints an analysis (also written to
// <run dir>/analysis.txt): every SDK message and every transcript entry with
// their line numbers, uuids, message ids and links, the uuid join between
// the two, and each API request's messages.
//
//   node proofs/entries.mts <model> <default|replay>
//   node proofs/entries.mts --analyse <run dir>

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { HarnessOptions } from '../src/harness.mts';
import { startRun } from '../src/harness.mts';
import { redact, stamp } from '../src/record.mts';

const QUIET_MS = 5000;

// Turn 1 asks for arithmetic before the tool calls, so adaptive thinking
// has something to think about and the first response holds thinking + text
// + two tool_use blocks (a first run with a plain request got no thinking).
// The answers: 17 primes below 60; the digits of 2^20 = 1048576 sum to 31.
const TURN_1 = [
  'Let N be the number of primes below 60, and M the sum of the digits of 2^20. Work both out before you act.',
  "Then, in one response: write one short sentence saying what you are about to do, and read file-N.txt and file-M.txt (with N and M replaced by the numbers) from the working directory with two Read calls in that same response. After the results come back, reply with the two files' contents joined by a single space, nothing else.",
];
const TURN_2 = 'One more thing: after that, read c.txt and reply with its contents only.';
const TURN_3 = 'Count from 1 to 300, one number per line, no other text.';
const TURN_4 = 'Reply with the word DONE and nothing else.';

type Scenario = 'default' | 'replay';

if (process.argv[2] === '--analyse') {
  const dir = process.argv[3];
  if (!dir) {
    process.stderr.write('usage: node proofs/entries.mts --analyse <run dir>\n');
    process.exit(2);
  }
  process.stdout.write(analyse(dir));
  process.exit(0);
}

const [model, scenario] = process.argv.slice(2) as [string | undefined, Scenario | undefined];
if (!model || (scenario !== 'default' && scenario !== 'replay')) {
  process.stderr.write('usage: node proofs/entries.mts <model> <default|replay>\n');
  process.exit(2);
}

const name = `entries-${scenario}`;
const bodiesDir = join(homedir(), '.local', 'state', 'tower-claude-code-harness', 'api-bodies', `${stamp().replace(/[:.]/g, '')}-${name}`);
mkdirSync(bodiesDir, { recursive: true });

const options: HarnessOptions = {
  model,
  includePartialMessages: true,
  tools: ['Read'],
  thinking: { type: 'adaptive', display: 'summarized' },
  debugFile: join(bodiesDir, 'debug.log'),
  env: { ...process.env, OTEL_LOG_RAW_API_BODIES: `file:${bodiesDir}` },
  ...(scenario === 'replay' ? { extraArgs: { 'replay-user-messages': null } } : {}),
};

const run = startRun({ name, options });
process.stdout.write(`run dir: ${run.dir}\nmodel: ${model}\nscenario: ${scenario}\n`);

writeFileSync(join(run.cwd, 'file-17.txt'), 'alpha\n');
writeFileSync(join(run.cwd, 'file-31.txt'), 'bravo\n');
writeFileSync(join(run.cwd, 'c.txt'), 'charlie\n');

const turn1Uuid = randomUUID();
const log = (text: string): void => {
  process.stdout.write(`${stamp()} ${text}\n`);
};

log(`send turn 1 (uuid ${turn1Uuid})`);
run.send({
  type: 'user',
  uuid: turn1Uuid as `${string}-${string}-${string}-${string}-${string}`,
  message: { role: 'user', content: TURN_1.map((text) => ({ type: 'text' as const, text })) },
  parent_tool_use_id: null,
});

// phase 1: turn 1 (+ turn 2 queued) running; 3: turn 3 running; 4: turn 4.
let phase = 1;
let sentTurn2 = false;
let interrupted = false;
let quiet: NodeJS.Timeout | undefined;
let resultSeen = false;
let line = 0;

const advance = (): void => {
  quiet = undefined;
  if (phase === 1) {
    phase = 3;
    log('quiet after phase 1; send turn 3');
    run.send({ type: 'user', message: { role: 'user', content: TURN_3 }, parent_tool_use_id: null });
  } else if (phase === 3) {
    phase = 4;
    log('quiet after phase 3; send turn 4');
    run.send({ type: 'user', message: { role: 'user', content: TURN_4 }, parent_tool_use_id: null });
  } else {
    log('quiet after phase 4; end');
    run.end();
  }
};

for await (const message of run.messages() as AsyncIterable<SDKMessage>) {
  line += 1;
  if (quiet) {
    clearTimeout(quiet);
    quiet = undefined;
  }
  if (message.type === 'assistant') {
    const kinds = message.message.content.map((b) => b.type).join(',');
    log(`sdk line ${line}: assistant uuid=${message.uuid} message.id=${message.message.id} blocks=${kinds}`);
    if (phase === 1 && !sentTurn2 && message.message.content.some((b) => b.type === 'tool_use')) {
      sentTurn2 = true;
      log('send turn 2 (mid-turn, no uuid)');
      run.send({ type: 'user', message: { role: 'user', content: TURN_2 }, parent_tool_use_id: null });
    }
  }
  if (message.type === 'user') {
    log(`sdk line ${line}: user uuid=${message.uuid} replay=${'isReplay' in message} synthetic=${message.isSynthetic ?? false}`);
  }
  if (phase === 3 && !interrupted && message.type === 'stream_event' && message.event.type === 'content_block_delta' && message.event.delta.type === 'text_delta') {
    interrupted = true;
    log(`sdk line ${line}: first text delta of turn 3; interrupt`);
    void run.interrupt().catch((err: unknown) => log(`interrupt failed: ${err instanceof Error ? err.message : String(err)}`));
  }
  if (message.type === 'result') {
    log(`sdk line ${line}: result ${message.subtype}${message.is_error ? ' (error)' : ''}`);
  }
  // Once a result has been seen in this phase, every message re-arms the
  // quiet timer.
  if (message.type === 'result' || resultSeen) {
    resultSeen = true;
    quiet = setTimeout(() => {
      resultSeen = false;
      advance();
    }, QUIET_MS);
  }
}

if (quiet) {
  clearTimeout(quiet);
}

let failed = false;
try {
  await run.done;
} catch (err) {
  failed = true;
  log(`failed: ${err instanceof Error ? err.message : String(err)}`);
}

const outDir = join(run.dir, 'api-bodies');
mkdirSync(outDir, { recursive: true });
let redactions = 0;
for (const entry of existsSync(bodiesDir) ? readdirSync(bodiesDir) : []) {
  const { text, count } = redact(readFileSync(join(bodiesDir, entry), 'utf8'));
  redactions += count;
  writeFileSync(entry === 'debug.log' ? join(run.dir, 'debug.log') : join(outDir, entry), text);
}
log(`copied ${bodiesDir} -> ${outDir} (${redactions} redactions)`);

const analysis = analyse(run.dir);
writeFileSync(join(run.dir, 'analysis.txt'), analysis);
process.stdout.write(`\n${analysis}`);
if (failed) {
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function readJsonl(path: string): Json[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Json);
}

function blockSummary(content: unknown): string {
  if (typeof content === 'string') {
    return `string(${content.length}) ${JSON.stringify(content.slice(0, 60))}`;
  }
  if (!Array.isArray(content)) {
    return String(content);
  }
  return content
    .map((b: Json) => {
      if (b.type === 'text') {
        const t = String(b.text);
        return `text ${JSON.stringify(t.slice(0, 60))}${t.length > 60 ? `…(${t.length})` : ''}`;
      }
      if (b.type === 'thinking') {
        return `thinking(${String(b.thinking).length})`;
      }
      if (b.type === 'tool_use') {
        return `tool_use ${String(b.id)} ${String(b.name)} ${JSON.stringify(b.input)}`;
      }
      if (b.type === 'tool_result') {
        return `tool_result ${String(b.tool_use_id)} ${JSON.stringify(b.content).slice(0, 60)}`;
      }
      return String(b.type);
    })
    .join(' | ');
}

function findTranscripts(dir: string): string[] {
  const projects = join(dir, 'config-dir', 'projects');
  if (!existsSync(projects)) {
    return [];
  }
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (e.name.endsWith('.jsonl')) {
        out.push(p);
      }
    }
  };
  walk(projects);
  return out;
}

function analyse(dir: string): string {
  const out: string[] = [];
  const w = (s = ''): void => {
    out.push(s);
  };

  const sdk = readJsonl(join(dir, 'sdk-messages.jsonl')).map((e) => e.message as Json);
  w(`== SDK messages (${join(dir, 'sdk-messages.jsonl')}), line: fields`);
  const sdkByUuid = new Map<string, number>();
  sdk.forEach((m, i) => {
    const n = i + 1;
    if (m.type === 'stream_event') {
      return;
    }
    if (typeof m.uuid === 'string') {
      sdkByUuid.set(m.uuid, n);
    }
    const msg = m.message as Json | undefined;
    const extra = ['isReplay', 'isSynthetic', 'parent_tool_use_id', 'user_message_uuid', 'user_message_uuids', 'aborted', 'priority', 'timestamp']
      .filter((k) => m[k] !== undefined && m[k] !== null)
      .map((k) => `${k}=${JSON.stringify(m[k])}`)
      .join(' ');
    w(`${n}: ${String(m.type)}${m.subtype ? `/${String(m.subtype)}` : ''} uuid=${String(m.uuid)}${msg?.id ? ` message.id=${String(msg.id)}` : ''}${msg ? ` [${blockSummary(msg.content)}]` : ''}${extra ? ` ${extra}` : ''}${m.tool_use_result !== undefined ? ' tool_use_result=yes' : ''}`);
  });

  for (const path of findTranscripts(dir)) {
    const entries = readJsonl(path);
    w();
    w(`== transcript (${path}), line: fields`);
    const tByUuid = new Map<string, number>();
    entries.forEach((e, i) => {
      if (typeof e.uuid === 'string') {
        tByUuid.set(e.uuid, i + 1);
      }
    });
    entries.forEach((e, i) => {
      const n = i + 1;
      const msg = e.message as Json | undefined;
      const att = e.attachment as Json | undefined;
      const parent = typeof e.parentUuid === 'string' ? `${e.parentUuid}(line ${tByUuid.get(e.parentUuid) ?? '-'})` : String(e.parentUuid);
      const flags = ['isMeta', 'isSidechain', 'isCompactSummary', 'isVisibleInTranscriptOnly', 'isApiErrorMessage', 'promptId', 'requestId', 'sourceToolAssistantUUID', 'sourceToolUseID', 'logicalParentUuid', 'toolUseID', 'level', 'operation', 'subtype']
        .filter((k) => e[k] !== undefined && e[k] !== null && e[k] !== false)
        .map((k) => `${k}=${JSON.stringify(e[k])}`)
        .join(' ');
      w(
        `${n}: ${String(e.type)}${att ? `/${String(att.type)}` : ''} uuid=${String(e.uuid)} parent=${parent}${msg?.id ? ` message.id=${String(msg.id)}` : ''}${msg ? ` [${blockSummary(msg.content)}]` : ''}${e.toolUseResult !== undefined ? ' toolUseResult=yes' : ''}${flags ? ` ${flags}` : ''} sdk=${typeof e.uuid === 'string' ? (sdkByUuid.get(e.uuid) ?? '-') : '-'}`,
      );
      w(`     keys: ${Object.keys(e).join(',')}`);
    });

    w();
    w('== SDK uuids with no transcript entry of the same uuid');
    sdk.forEach((m, i) => {
      if (m.type !== 'stream_event' && typeof m.uuid === 'string' && !tByUuid.has(m.uuid)) {
        w(`sdk line ${i + 1}: ${String(m.type)}${m.subtype ? `/${String(m.subtype)}` : ''} ${m.uuid}`);
      }
    });

    w();
    w('== message.id groups (SDK lines / transcript lines)');
    const groups = new Map<string, { sdk: number[]; t: number[] }>();
    const g = (id: string): { sdk: number[]; t: number[] } => {
      let v = groups.get(id);
      if (!v) {
        v = { sdk: [], t: [] };
        groups.set(id, v);
      }
      return v;
    };
    sdk.forEach((m, i) => {
      const id = (m.message as Json | undefined)?.id;
      if (m.type === 'assistant' && typeof id === 'string') {
        g(id).sdk.push(i + 1);
      }
    });
    entries.forEach((e, i) => {
      const id = (e.message as Json | undefined)?.id;
      if (e.type === 'assistant' && typeof id === 'string') {
        g(id).t.push(i + 1);
      }
    });
    for (const [id, v] of groups) {
      w(`${id}: sdk ${JSON.stringify(v.sdk)} transcript ${JSON.stringify(v.t)}`);
    }
  }

  const indexPath = join(dir, 'api-bodies', 'index.jsonl');
  if (existsSync(indexPath)) {
    w();
    w(`== API requests (${indexPath})`);
    readJsonl(indexPath).forEach((entry, i) => {
      w(`request ${i + 1} (index line ${i + 1}) source=${String(entry.query_source)} message_uuid=${String(entry.message_uuid)} message_id=${String(entry.message_id)} file=${String(entry.request_file)}`);
      if (entry.query_source !== 'sdk') {
        return;
      }
      const reqPath = join(dir, 'api-bodies', String(entry.request_file));
      if (!existsSync(reqPath)) {
        return;
      }
      const req = JSON.parse(readFileSync(reqPath, 'utf8')) as { messages?: { role: string; content: unknown }[]; thread?: unknown };
      // With the message-threads beta a request may continue a server-side
      // thread and carry only the messages since previous_message_id.
      w(`  thread=${JSON.stringify(req.thread)}`);
      (req.messages ?? []).forEach((m, j) => {
        w(`  messages[${j}] ${m.role}: ${blockSummary(m.content)}`);
      });
      const resPath = join(dir, 'api-bodies', String(entry.response_file));
      if (existsSync(resPath)) {
        const res = JSON.parse(readFileSync(resPath, 'utf8')) as { id?: string; content?: unknown; stop_reason?: string };
        w(`  response ${String(res.id)} stop=${String(res.stop_reason)}: ${blockSummary(res.content)}`);
      }
    });
  }
  return `${out.join('\n')}\n`;
}
