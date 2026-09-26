// Defaults survey: additional working directories (Stephen, 26 Sep, the
// defaults brief: "Include additional working directories, which Claude Code
// supports and bridge never did (/add-dir interactively): how can they be
// set (at start, live, through which option or request), and is each way
// documented?").
//
// One run per way. Each run is one query() on Haiku 4.5 with only the Read
// tool and permission mode default. A directory outside the working
// directory (<scratch>/extra) holds marker.txt. Every turn asks the model to
// Read that file and to name the additional working directories its
// environment information lists. Evidence: the API requests
// (OTEL_LOG_RAW_API_BODIES, as proof 1) for what the model was told, and
// whether the Read needed approval (canUseTool records every ask; it denies
// all of them except in `permission-update`, so a Read that succeeds without
// an ask was inside the working directories).
//
//   node proofs/add-dir.mts <way>
//
//   none               control: nothing adds the directory
//   option             Options.additionalDirectories at start
//   settings           Options.settings {permissions: {additionalDirectories}} at start
//   flag-live          turn 1 bare; applyFlagSettings({permissions: {additionalDirectories}}); turn 2
//   slash-live         turn 1 bare; the user message "/add-dir <dir>"; turn 3
//   register-live      turn 1 bare; request({subtype: register_repo_root}) for the
//                      outside directory, then for a subdirectory of the
//                      working directory; turn 2
//   permission-update  turn 1: canUseTool allows the Read and returns
//                      updatedPermissions [{type: addDirectories, destination:
//                      session}]; turn 2 reads a second file there

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CanUseTool, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { HarnessOptions } from '../src/harness.mts';
import { startRun } from '../src/harness.mts';
import { redact, stamp } from '../src/record.mts';

const WAYS = ['none', 'option', 'settings', 'flag-live', 'slash-live', 'register-live', 'permission-update'] as const;
type Way = (typeof WAYS)[number];

const way = process.argv[2] as Way;
if (!WAYS.includes(way)) {
  process.stderr.write(`usage: node proofs/add-dir.mts <${WAYS.join('|')}>\n`);
  process.exit(2);
}

const STATE_ROOT = join(homedir(), '.local', 'state', 'tower-claude-code-harness');
const name = `add-dir-${way}`;
const id = `${stamp().replace(/[:.]/g, '')}-${name}`;
const bodiesDir = join(STATE_ROOT, 'api-bodies', id);
mkdirSync(bodiesDir, { recursive: true });
const scratch = join(STATE_ROOT, 'add-dir-scratch', id);
const extra = join(scratch, 'extra');
mkdirSync(extra, { recursive: true });
writeFileSync(join(extra, 'marker.txt'), 'MARKER-EXTRA-4411\n');
writeFileSync(join(extra, 'second.txt'), 'MARKER-SECOND-9025\n');

const events: unknown[] = [];
const note = (what: string, detail?: unknown): void => {
  events.push({ ts: stamp(), what, detail });
  process.stdout.write(`[${what}] ${detail === undefined ? '' : JSON.stringify(detail)}\n`);
};

const canUseTool: CanUseTool = async (toolName, input) => {
  note('canUseTool', { toolName, input });
  if (way === 'permission-update' && toolName === 'Read' && String(input.file_path ?? '').startsWith(extra)) {
    return { behavior: 'allow', updatedInput: input, updatedPermissions: [{ type: 'addDirectories', directories: [extra], destination: 'session' }] };
  }
  return { behavior: 'deny', message: 'proof: every approval is denied in this run' };
};

const options: HarnessOptions = {
  model: 'claude-haiku-4-5',
  tools: ['Read'],
  permissionMode: 'default',
  canUseTool,
  env: { ...process.env, OTEL_LOG_RAW_API_BODIES: `file:${bodiesDir}` },
  debugFile: join(bodiesDir, 'debug.log'),
  ...(way === 'option' ? { additionalDirectories: [extra] } : {}),
  ...(way === 'settings' ? { settings: { permissions: { additionalDirectories: [extra] } } } : {}),
};

const run = startRun({ name, options });
process.stdout.write(`run dir: ${run.dir}\nway: ${way}\nextra: ${extra}\n`);

const ask = (file: string): string =>
  `Use the Read tool once on ${join(extra, file)} and quote what it returns (or the error). Then list, verbatim, every additional working directory your environment information names, or say there are none. Nothing else.`;

type Step = { control?: { label: string; call: () => Promise<unknown> }; prompt: string };
const request = (r: Record<string, unknown>): Promise<unknown> =>
  (run.query as unknown as { request: (r: Record<string, unknown>) => Promise<unknown> }).request.bind(run.query)(r);

const steps: Step[] = (() => {
  switch (way) {
    case 'none':
    case 'option':
    case 'settings':
      return [{ prompt: ask('marker.txt') }];
    case 'flag-live':
      return [
        { prompt: ask('marker.txt') },
        { control: { label: 'applyFlagSettings({permissions: {additionalDirectories: [extra]}})', call: () => run.query.applyFlagSettings({ permissions: { additionalDirectories: [extra] } }) }, prompt: ask('second.txt') },
      ];
    case 'slash-live':
      return [{ prompt: ask('marker.txt') }, { prompt: `/add-dir ${extra}` }, { prompt: ask('second.txt') }];
    case 'register-live': {
      const inside = join(run.cwd, 'inside-sub');
      mkdirSync(inside, { recursive: true });
      return [
        { prompt: ask('marker.txt') },
        {
          control: {
            label: 'request register_repo_root: outside dir, then a subdirectory of cwd',
            call: async () => {
              const out: Record<string, unknown> = {};
              try {
                out.outside = await request({ subtype: 'register_repo_root', directory: extra });
              } catch (e) {
                out.outside = { error: String(e) };
              }
              try {
                out.insideCwd = await request({ subtype: 'register_repo_root', directory: inside });
              } catch (e) {
                out.insideCwd = { error: String(e) };
              }
              return out;
            },
          },
          prompt: ask('second.txt'),
        },
      ];
    }
    case 'permission-update':
      return [{ prompt: ask('marker.txt') }, { prompt: ask('second.txt') }];
  }
})();

let stepIndex = 0;
const sendStep = async (): Promise<void> => {
  const step = steps[stepIndex];
  if (step.control) {
    try {
      note('control', { label: step.control.label, result: await step.control.call() });
    } catch (e) {
      note('control-error', { label: step.control.label, error: String(e) });
    }
  }
  note('send', { step: stepIndex + 1, prompt: step.prompt });
  run.send({ type: 'user', message: { role: 'user', content: step.prompt }, parent_tool_use_id: null });
};

await sendStep();
for await (const message of run.messages() as AsyncIterable<SDKMessage>) {
  if (message.type === 'assistant') {
    for (const block of message.message.content) {
      if (block.type === 'text') note('assistant text', block.text);
      if (block.type === 'tool_use') note('tool_use', block.input);
    }
  }
  if (message.type === 'user' && Array.isArray(message.message.content)) {
    for (const block of message.message.content) {
      if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'tool_result') {
        note('tool_result', (block as { content?: unknown }).content);
      }
    }
  }
  if (message.type === 'system' && message.subtype !== 'init') note(`system/${message.subtype}`, undefined);
  if (message.type === 'result') {
    note('result', { subtype: message.subtype, result: 'result' in message ? message.result : undefined });
    stepIndex += 1;
    if (stepIndex < steps.length) await sendStep();
    else run.end();
  }
}
await run.done;

writeFileSync(join(run.dir, 'proof-events.json'), `${JSON.stringify(events, null, 2)}\n`);
const outDir = join(run.dir, 'api-bodies');
mkdirSync(outDir, { recursive: true });
for (const entry of existsSync(bodiesDir) ? readdirSync(bodiesDir) : []) {
  const { text } = redact(readFileSync(join(bodiesDir, entry), 'utf8'));
  writeFileSync(join(outDir, entry), text);
}

// What each main-thread request told the model about working directories.
const index = join(outDir, 'index.jsonl');
const lines: string[] = [];
if (existsSync(index)) {
  for (const row of readFileSync(index, 'utf8').split('\n').filter(Boolean)) {
    const e = JSON.parse(row) as { query_source?: string; request_file?: string };
    if (e.query_source !== 'sdk' || !e.request_file) continue;
    const body = JSON.parse(readFileSync(join(outDir, e.request_file), 'utf8')) as { messages: { role: string; content: unknown }[] };
    const text = JSON.stringify(body.messages);
    const hits = [...text.matchAll(/(Additional working directories[^\\]*(?:\\n[^\\]*){0,2}|Primary working directory: [^\\]*)/g)].map((m) => m[0]);
    lines.push(`${e.request_file}: ${hits.length ? hits.join(' | ') : '(no working-directory text)'}`);
  }
}
const summary = `way: ${way}\nextra: ${extra}\n\n${lines.join('\n')}\n`;
writeFileSync(join(run.dir, 'summary.txt'), summary);
process.stdout.write(`\n${summary}`);
rmSync(scratch, { recursive: true, force: true });
