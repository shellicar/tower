// Smoke run: proves the harness's isolation baseline, positively and
// negatively (Stephen, 26 Sep: "CLAUDE.md shouldnt load, there shouldnt be any
// skills or permissions, but the credentials should work").
//
// - Negative: a dummy skill is put in ~/.claude/skills for the length of the
//   run. It must not appear.
// - Positive: a dummy skill comes from this proof's own plugin
//   (proofs/smoke-plugin), passed through the SDK's `plugins` option. It must
//   appear.
// - Claude is asked which skills it has and whether any CLAUDE.md is in its
//   context. Skills that come with the account show up too; the two dummies
//   are told apart by name.
//
// It also prints the agent's config directory and the session transcripts
// already in it: run twice, the second run shows the first run's transcript,
// since every run named smoke reuses one config directory.
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
import { startRun } from '../src/harness.mts';

const NEGATIVE = 'tower-harness-negative-probe';
const POSITIVE = 'tower-harness-positive-probe';
const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), 'smoke-plugin');
const NEGATIVE_DIR = join(homedir(), '.claude', 'skills', NEGATIVE);

const QUESTION = `Answer from what is already in your context. Don't use any tools.

1. Under a heading SKILLS, list every skill available to you in this session, by its exact name, one per line. Include plugin-qualified names as written.
2. Under a heading CLAUDE.MD, list every CLAUDE.md (or other instruction file) whose contents are in your context, by path, one per line, or write NONE.
3. Under a heading PERMISSIONS, say whether your context contains any permission rules (allow or deny lists), and quote them, or write NONE.
4. Under a heading PHRASES, answer yes or no for each: outside this message, does your context contain the phrase "I hold the decision ball"? The phrase "Working with Stephen"?`;

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

  const run = startRun({ name: 'smoke', options: { model, plugins: [{ type: 'local', path: PLUGIN_DIR }] } });
  process.stdout.write(`run dir: ${run.dir}\ncwd: ${run.cwd}\nconfig dir: ${run.configDir}\n`);
  // Listed in the same tick startRun returned in, before anything is sent:
  // Claude Code writes this run's transcript only once it has a message.
  const projects = join(run.configDir, 'projects');
  const before = existsSync(projects) ? readdirSync(projects, { recursive: true, encoding: 'utf8' }).filter((p) => p.endsWith('.jsonl')) : [];
  process.stdout.write(`transcripts already in config dir: ${JSON.stringify(before)}\n`);

  run.send({ type: 'user', message: { role: 'user', content: QUESTION }, parent_tool_use_id: null });

  let answer = '';
  for await (const message of run.messages()) {
    if (message.type === 'system' && message.subtype === 'init') {
      process.stdout.write(`init.skills: ${JSON.stringify(message.skills)}\n`);
      process.stdout.write(`init.plugins: ${JSON.stringify(message.plugins.map((p) => p.name))}\n`);
      process.stdout.write(`init.permissionMode: ${message.permissionMode}\n`);
      process.stdout.write(`init.apiKeySource: ${message.apiKeySource}\n`);
      process.stdout.write(`init.skills has ${POSITIVE}: ${message.skills.some((s) => s.endsWith(POSITIVE))}\n`);
      process.stdout.write(`init.skills has ${NEGATIVE}: ${message.skills.some((s) => s.endsWith(NEGATIVE))}\n`);
    }
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') {
          answer += block.text;
          process.stdout.write(`assistant: ${block.text}\n`);
        }
        if (block.type === 'tool_use') {
          process.stdout.write(`assistant tool_use: ${block.name}\n`);
        }
      }
    }
    if (message.type === 'result') {
      process.stdout.write(`result: ${message.subtype}${message.is_error ? ' (error)' : ''}\n`);
      run.end();
    }
  }

  process.stdout.write(`answer names ${POSITIVE}: ${answer.includes(POSITIVE)}\n`);
  process.stdout.write(`answer names ${NEGATIVE}: ${answer.includes(NEGATIVE)}\n`);

  try {
    await run.done;
    process.stdout.write('done\n');
  } catch (err) {
    process.stdout.write(`failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
} finally {
  rmSync(NEGATIVE_DIR, { recursive: true, force: true });
  process.stdout.write(`removed ${NEGATIVE_DIR}: ${!existsSync(NEGATIVE_DIR)}\n`);
}
