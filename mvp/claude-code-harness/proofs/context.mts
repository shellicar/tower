// Proof 11: how the participant's own context can reach the model, and how
// CLAUDE.md actually reaches it when it loads (Stephen, 26 Sep: "it needs its
// own proof, what are the options / and how does claude.md work in the
// latest version? ie does it always do what bridge does? write a system
// reminder?").
//
// Bridge's `context` line commits operator-supplied text once, as a
// <system-reminder> inside the opening message. The SDK has no direct string
// equivalent; this proof runs every real option side by side, on one model,
// and inspects the raw API request bodies (OTEL_LOG_RAW_API_BODIES, as in
// proof 1) to see exactly where each one lands and how it's wrapped.
//
// Two scenarios:
//
//   baseline  settingSources: [] (the harness's own baseline, unchanged).
//             One turn carries, together: a <system-reminder> block built
//             into the first user message (bridge's own mechanism); a
//             SessionStart hook's additionalContext; a systemPrompt append;
//             an inline settings.claudeMd (docs say this is honoured only in
//             managed/policy settings, never inline SDK settings -- checked
//             directly); and a CLAUDE.md seeded into cwd before the binary
//             starts, to see whether settingSources: [] really blocks the
//             project-file route too (smoke.mts only checked the user-level
//             ~/.claude/CLAUDE.md). A second turn adds a fresh
//             UserPromptSubmit hook sentinel, to see whether a hook's
//             additionalContext is a one-off ("once, like bridge's context
//             line") or fires fresh every turn.
//
//   scopes    settingSources: ['project', 'user'] (the harness's opt-in
//             escape hatch, added for this proof -- see harness.mts). A
//             CLAUDE.md seeded into cwd (settingSources: ['project']) and
//             another seeded into CLAUDE_CONFIG_DIR (settingSources:
//             ['user'], what ~/.claude/CLAUDE.md is under a real install)
//             before the binary starts, so there's no race with the child
//             process's own read (see harness.mts's seedConfigDir/seedCwd).
//             Two turns, same question, no hooks: does the second turn's
//             request still carry both files' content, and in what wrapper?
//
// Every turn asks the model to name every sentinel string it can currently
// see and where, which is corroborating evidence only -- the request bodies
// are the ground truth, inspected directly below.
//
//   node proofs/context.mts <model> <baseline|scopes>

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HarnessOptions, StartRunArgs } from '../src/harness.mts';
import { startRun } from '../src/harness.mts';
import { redact, stamp } from '../src/record.mts';
import type { HookInput, SDKMessage, SDKUserMessage, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

type Scenario = 'baseline' | 'scopes';
const SCENARIOS: Scenario[] = ['baseline', 'scopes'];

const [model, scenario] = process.argv.slice(2);
if (!model || !SCENARIOS.includes(scenario as Scenario)) {
  process.stderr.write(`usage: node proofs/context.mts <model> <${SCENARIOS.join('|')}>\n`);
  process.exit(2);
}

// One sentinel per mechanism, distinct per scenario so a leftover file from a
// prior run of the same proof name (the work directory is reused, never
// cleared -- README) can't be mistaken for this run's own.
const S = {
  firstMessage: 'SENTINEL-FIRST-MESSAGE-7f3a1c',
  sessionStart: 'SENTINEL-SESSIONSTART-9c1d4e',
  promptHook1: 'SENTINEL-PROMPTHOOK-turn1-4b2e88',
  promptHook2: 'SENTINEL-PROMPTHOOK-turn2-4b2e99',
  appendPrompt: 'SENTINEL-SYSTEMPROMPT-APPEND-2e5fa0',
  settingsClaudeMd: 'SENTINEL-SETTINGS-CLAUDEMD-1a9b77',
  projectClaudeMdBaseline: 'SENTINEL-PROJECT-CLAUDEMD-baseline-6d4c33',
  projectClaudeMdScopes: 'SENTINEL-PROJECT-CLAUDEMD-scopes-3f2a55',
  userClaudeMdScopes: 'SENTINEL-USER-CLAUDEMD-scopes-8b7e21',
};

const ASK =
  'Without using any tools, list every distinct string beginning with "SENTINEL-" that you can currently see anywhere in your context -- the system prompt, project/user instructions already given to you, or this conversation. Quote each one exactly and say where it appears (e.g. "in the system prompt", "in CLAUDE.md-style project context given at the start", "in this message").';

const name = `context-${scenario}`;
const bodiesDir = join(homedir(), '.local', 'state', 'tower-claude-code-harness', 'api-bodies', `${stamp().replace(/[:.]/g, '')}-${name}`);
mkdirSync(bodiesDir, { recursive: true });
const debugFile = join(bodiesDir, 'debug.log');

// InstructionsLoaded fires for every CLAUDE.md/AGENTS.md/rules file Claude
// Code actually loads; recorded here as direct evidence of which files
// loaded, tagged with memory_type and load_reason (harness's
// harness-events.jsonl also has this run's send/end events, but not this).
const instructionsLoaded: HookInput[] = [];
const instructionsLoadedHook = async (input: HookInput): Promise<SyncHookJSONOutput> => {
  instructionsLoaded.push(input);
  return {};
};

const sessionStartHook = async (): Promise<SyncHookJSONOutput> => ({
  hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: S.sessionStart },
});

let promptTurn = 0;
const userPromptSubmitHook = async (): Promise<SyncHookJSONOutput> => {
  promptTurn += 1;
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: promptTurn === 1 ? S.promptHook1 : S.promptHook2,
    },
  };
};

const commonOptions = {
  model,
  tools: [],
  includePartialMessages: false,
  debugFile,
  env: { ...process.env, OTEL_LOG_RAW_API_BODIES: `file:${bodiesDir}` },
  systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: `The current focus phrase is: ${S.appendPrompt}` },
  hooks: {
    InstructionsLoaded: [{ hooks: [instructionsLoadedHook] }],
  },
} satisfies Partial<HarnessOptions>;

const args: StartRunArgs =
  scenario === 'baseline'
    ? {
        name,
        options: {
          ...commonOptions,
          settings: { claudeMd: `Settings.claudeMd sentinel: ${S.settingsClaudeMd}` },
          hooks: {
            ...commonOptions.hooks,
            SessionStart: [{ hooks: [sessionStartHook] }],
            UserPromptSubmit: [{ hooks: [userPromptSubmitHook] }],
          },
        },
        // settingSources omitted: the harness's own baseline, [].
        seedCwd: { 'CLAUDE.md': `# Project instructions (baseline, settingSources: [])\n\n${S.projectClaudeMdBaseline}\n` },
      }
    : {
        name,
        options: commonOptions,
        settingSources: ['project', 'user'],
        seedCwd: { 'CLAUDE.md': `# Project instructions\n\n${S.projectClaudeMdScopes}\n` },
        seedConfigDir: { 'CLAUDE.md': `# User instructions (~/.claude/CLAUDE.md under a real install)\n\n${S.userClaudeMdScopes}\n` },
      };

const run = startRun(args);
process.stdout.write(`run dir: ${run.dir}\nmodel: ${model}\nscenario: ${scenario}\ncwd: ${run.cwd}\nconfigDir: ${run.configDir}\n`);

let line = 0;
let turn = 0;
const turnCount = 2;

const send = (content: SDKUserMessage['message']['content']): void => {
  turn += 1;
  process.stdout.write(`\n--- turn ${turn} ---\n`);
  run.send({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null });
};

// Turn 1: bridge's own mechanism -- a <system-reminder> block built into the
// first user message -- carrying the ASK question too.
send(`<system-reminder>\n${S.firstMessage}\n</system-reminder>\n\n${ASK}`);

for await (const message of run.messages() as AsyncIterable<SDKMessage>) {
  line += 1;
  if (message.type === 'assistant') {
    for (const block of message.message.content) {
      if (block.type === 'text') {
        process.stdout.write(`assistant text (turn ${turn}, line ${line}):\n${block.text}\n`);
      }
    }
  }
  if (message.type === 'result') {
    process.stdout.write(`result (turn ${turn}, line ${line}): ${message.subtype}${message.is_error ? ' (error)' : ''}\n`);
    if (turn < turnCount) {
      send(ASK);
    } else {
      run.end();
    }
  }
}

let failed = false;
try {
  await run.done;
} catch (err) {
  failed = true;
  process.stdout.write(`failed: ${err instanceof Error ? err.message : String(err)}\n`);
}

process.stdout.write(`\nInstructionsLoaded hook fired ${instructionsLoaded.length} time(s):\n`);
for (const input of instructionsLoaded) {
  const i = input as HookInput & { file_path?: string; memory_type?: string; load_reason?: string };
  process.stdout.write(`  file_path=${i.file_path} memory_type=${i.memory_type} load_reason=${i.load_reason}\n`);
}

// Copy the bodies and the debug log into the run directory, redacted, same
// as thinking.mts.
const outDir = join(run.dir, 'api-bodies');
mkdirSync(outDir, { recursive: true });
let redactions = 0;
for (const entry of existsSync(bodiesDir) ? readdirSync(bodiesDir) : []) {
  const { text, count } = redact(readFileSync(join(bodiesDir, entry), 'utf8'));
  redactions += count;
  writeFileSync(entry === 'debug.log' ? join(run.dir, 'debug.log') : join(outDir, entry), text);
}
process.stdout.write(`\ncopied ${bodiesDir} -> ${outDir} (${redactions} redactions)\n`);

// Ground truth: search each request body for every sentinel, and print the
// system block / first user message content verbatim around any hit, so the
// exact wrapper text (a <system-reminder>, a different tag, or none) is
// visible without opening the file by hand.
const indexPath = join(outDir, 'index.jsonl');
if (existsSync(indexPath)) {
  const index = readFileSync(indexPath, 'utf8').trim().split('\n').filter(Boolean);
  index.forEach((raw, i) => {
    const entry = JSON.parse(raw) as { query_source?: string; model?: string; request_file?: string };
    if (!entry.request_file || !existsSync(join(outDir, entry.request_file))) {
      return;
    }
    const reqText = readFileSync(join(outDir, entry.request_file), 'utf8');
    const req = JSON.parse(reqText) as { system?: unknown; messages?: { role: string; content: unknown }[] };
    const hits = Object.entries(S).filter(([, v]) => reqText.includes(v));
    process.stdout.write(`\nrequest ${i + 1} (${entry.request_file}) source=${entry.query_source} model=${entry.model}\n`);
    process.stdout.write(`  sentinels present: ${hits.map(([k]) => k).join(', ') || '(none)'}\n`);
    process.stdout.write(`  system block: ${JSON.stringify(req.system).slice(0, 2000)}\n`);
    const firstUser = req.messages?.find((m) => m.role === 'user');
    process.stdout.write(`  first user message content: ${JSON.stringify(firstUser?.content).slice(0, 4000)}\n`);
  });
} else {
  process.stdout.write('no index.jsonl: no request bodies were written\n');
}

if (failed) {
  process.exitCode = 1;
}
