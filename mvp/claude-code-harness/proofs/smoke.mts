// Smoke run: proves the harness's isolation baseline, positively and
// negatively (Stephen, 26 Sep: "CLAUDE.md shouldnt load, there shouldnt be any
// skills or permissions, but the credentials should work"), and that the
// agent's config directory carries Claude Code's state from one run to the
// next ("its ONE directory PER agent", 27 Sep).
//
// - Negative: a dummy skill is put in ~/.claude/skills for the length of both
//   runs. It must not appear.
// - Positive: a dummy skill comes from this proof's own plugin
//   (proofs/smoke-plugin), passed through the SDK's `plugins` option. It must
//   appear.
// - Run 1: Claude is asked which skills it has and whether any CLAUDE.md is in
//   its context. Skills that come with the account show up too; the two
//   dummies are told apart by name.
// - Run 2: a second run under the same name resumes run 1's session by id,
//   straight from the shared config directory, with no session store, and is
//   asked to quote run 1's question back. Before it starts, it prints the
//   transcripts already in the config directory.
//
// The dummy in ~/.claude/skills is removed afterwards, whatever happens. The
// run refuses to start if that path already exists, so it never touches
// anything it didn't create.
//
//   node proofs/smoke.mts <model>

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { type HarnessOptions, startRun } from '../src/harness.mts';

const NAME = 'smoke';
const NEGATIVE = 'tower-harness-negative-probe';
const POSITIVE = 'tower-harness-positive-probe';
const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), 'smoke-plugin');
const NEGATIVE_DIR = join(homedir(), '.claude', 'skills', NEGATIVE);

const QUESTION = `Answer from what is already in your context. Don't use any tools.

1. Under a heading SKILLS, list every skill available to you in this session, by its exact name, one per line. Include plugin-qualified names as written.
2. Under a heading CLAUDE.MD, list every CLAUDE.md (or other instruction file) whose contents are in your context, by path, one per line, or write NONE.
3. Under a heading PERMISSIONS, say whether your context contains any permission rules (allow or deny lists), and quote them, or write NONE.
4. Under a heading PHRASES, answer yes or no for each: outside this message, does your context contain the phrase "I hold the decision ball"? The phrase "Working with Stephen"?`;

// Run 1's question opens with this line; run 2 must quote it back.
const RECALL_MARK = "Answer from what is already in your context. Don't use any tools.";
const RECALL = `Don't use any tools. Quote, exactly, the first line of the first user message in this conversation, or write NO EARLIER MESSAGE if there is none.`;

function user(content: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
}

function transcripts(configDir: string): string[] {
  const projects = join(configDir, 'projects');
  return existsSync(projects) ? readdirSync(projects, { recursive: true, encoding: 'utf8' }).filter((p) => p.endsWith('.jsonl')) : [];
}

// One run: send one message, print what the smoke run checks, end on the
// result. Returns the session id from init and the assistant's text.
async function oneRun(label: string, options: HarnessOptions, content: string): Promise<{ sessionId: string | undefined; answer: string; failed: boolean }> {
  const run = startRun({ name: NAME, options });
  const say = (line: string): void => {
    process.stdout.write(`[${label}] ${line}\n`);
  };
  say(`run dir: ${run.dir}`);
  say(`cwd: ${run.cwd}`);
  say(`config dir: ${run.configDir}`);
  // Listed in the same tick startRun returned in, before anything is sent:
  // Claude Code writes this run's transcript only once it has a message.
  say(`transcripts already in config dir: ${JSON.stringify(transcripts(run.configDir))}`);

  run.send(user(content));

  let sessionId: string | undefined;
  let answer = '';
  for await (const message of run.messages()) {
    if (message.type === 'system' && message.subtype === 'init') {
      sessionId = message.session_id;
      say(`init.session_id: ${message.session_id}`);
      say(`init.skills: ${JSON.stringify(message.skills)}`);
      say(`init.plugins: ${JSON.stringify(message.plugins.map((p) => p.name))}`);
      say(`init.permissionMode: ${message.permissionMode}`);
      say(`init.apiKeySource: ${message.apiKeySource}`);
      say(`init.skills has ${POSITIVE}: ${message.skills.some((s) => s.endsWith(POSITIVE))}`);
      say(`init.skills has ${NEGATIVE}: ${message.skills.some((s) => s.endsWith(NEGATIVE))}`);
    }
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') {
          answer += block.text;
          say(`assistant: ${block.text}`);
        }
        if (block.type === 'tool_use') {
          say(`assistant tool_use: ${block.name}`);
        }
      }
    }
    if (message.type === 'result') {
      say(`result: ${message.subtype}${message.is_error ? ' (error)' : ''}`);
      run.end();
    }
  }

  let failed = false;
  try {
    await run.done;
    say('done');
  } catch (err) {
    say(`failed: ${err instanceof Error ? err.message : String(err)}`);
    failed = true;
  }
  say(`transcripts in config dir after: ${JSON.stringify(transcripts(run.configDir))}`);
  return { sessionId, answer, failed };
}

const model = process.argv[2];
if (!model) {
  process.stderr.write('usage: node proofs/smoke.mts <model>\n');
  process.exit(2);
}

if (existsSync(NEGATIVE_DIR)) {
  process.stderr.write(`smoke: ${NEGATIVE_DIR} already exists; not touching it\n`);
  process.exit(2);
}

mkdirSync(NEGATIVE_DIR, { recursive: true });
try {
  writeFileSync(
    join(NEGATIVE_DIR, 'SKILL.md'),
    `---
name: ${NEGATIVE}
description: Dummy skill placed in ~/.claude/skills by the tower harness smoke run. It must NOT appear in the run's skill listing. Does nothing.
---

Dummy skill for the tower Claude Code harness smoke run. If you can see this
skill, the run is reading ~/.claude/skills. It has no task; don't use it.
`,
  );

  const plugins: HarnessOptions['plugins'] = [{ type: 'local', path: PLUGIN_DIR }];

  const first = await oneRun('run 1', { model, plugins }, QUESTION);
  process.stdout.write(`[run 1] answer names ${POSITIVE}: ${first.answer.includes(POSITIVE)}\n`);
  process.stdout.write(`[run 1] answer names ${NEGATIVE}: ${first.answer.includes(NEGATIVE)}\n`);
  if (first.failed) {
    process.exitCode = 1;
  }

  if (first.sessionId === undefined) {
    process.stdout.write('[run 2] skipped: run 1 reported no session id\n');
    process.exitCode = 1;
  } else {
    const second = await oneRun('run 2', { model, plugins, resume: first.sessionId }, RECALL);
    process.stdout.write(`[run 2] resumed ${first.sessionId}; init session id ${second.sessionId}\n`);
    process.stdout.write(`[run 2] answer quotes run 1's question: ${second.answer.includes(RECALL_MARK)}\n`);
    process.stdout.write(`[run 2] answer names ${NEGATIVE}: ${second.answer.includes(NEGATIVE)}\n`);
    if (second.failed) {
      process.exitCode = 1;
    }
  }
} finally {
  rmSync(NEGATIVE_DIR, { recursive: true, force: true });
  process.stdout.write(`removed ${NEGATIVE_DIR}: ${!existsSync(NEGATIVE_DIR)}\n`);
}
