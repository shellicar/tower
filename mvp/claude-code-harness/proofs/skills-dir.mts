// Proof 12: loading skills from a directory declared in config, without
// settingSources. The harness forces settingSources: [] on every run,
// whatever a proof passes (src/harness.mts): that is the constraint the
// Claude Code participant runs under too (no settingSources), so this proof
// asks what still gets a skill in front of Claude under it, and whether the
// directory can be rescanned live, matching bridge's own `skills` control
// line (mvp/CLAUDE.md: "re-scanned per say").
//
// Streaming input mode does not emit `system/init` until the first user
// message is sent (confirmed by this proof's first, broken draft: a loop
// that waited for `init` before any `send()` hung until its `timeout`
// killed it). Every scenario below sends the first turn immediately and
// reads `init` off that turn's message stream, not before it.
//
// Ground truth for "which skills did the model actually see" is the
// transcript's `skill_listing` attachment
// (config-dir/projects/<project>/<session>.jsonl), not the model's own
// free-text answer to a question (a small model can omit or invent names).
// Each turn still asks the question, printed for a human cross-check, but
// the recorded verdict comes from `skill_listing`.
//
// Four scenarios, one process each:
//
//   plugin-no-manifest    A `plugins` entry with no .claude-plugin/plugin.json
//                          manifest, one skill at start. Checks (a) whether a
//                          manifest-less plugin loads and what name its skill
//                          gets, (b) whether a second skill file added to the
//                          same directory mid-run is picked up with no reload
//                          call, with reloadSkills(), or only with
//                          reloadPlugins(), (c) whether the skill is
//                          dispatchable by its bare name as well as its
//                          plugin-qualified name.
//
//   add-dir-only           additionalDirectories pointing at a directory laid
//                          out like a project (<dir>/.claude/skills/...), no
//                          plugin at all: the docs' own "declare a directory"
//                          route (agent-sdk/skills.md's settingSources Note),
//                          checked under the harness's fixed settingSources:[].
//
//   add-dir-reload         Same fixture as add-dir-only, but calls
//                          reloadSkills() on the query object after the first
//                          turn, to see whether the control call reaches past
//                          the settingSources gate that the option itself
//                          can't.
//
//   project-config-root    Same fixture shape as add-dir-only, but passed as
//                          `projectConfigRoot` instead of
//                          `additionalDirectories` (sdk.d.ts: project
//                          settings, .mcp.json and the .claude config trees,
//                          skills included, come from here instead of cwd).
//
//   node proofs/skills-dir.mts <model> <scenario>

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRun } from '../src/harness.mts';

const QUESTION = `Answer from what is already in your context. Don't use any tools.

Under a heading SKILLS, list every skill available to you in this session, by its exact name, one per line. Include plugin-qualified names as written.`;

function skillFile(name: string, note: string): string {
  return `---
name: ${name}
description: Dummy skill for tower proof 12 (skills-dir). ${note}
---

Dummy skill for the tower Claude Code harness proof 12 run. It has no task,
don't use it.
`;
}

const [model, scenario] = process.argv.slice(2);
if (!model || !scenario) {
  process.stderr.write('usage: node proofs/skills-dir.mts <model> <plugin-no-manifest|add-dir-only|add-dir-reload|project-config-root>\n');
  process.exit(2);
}

const root = mkdtempSync(join(tmpdir(), 'tower-proof-12-'));

function writeSkill(dir: string, name: string, note: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), skillFile(name, note));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Every skill_listing attachment in the run's own transcript, in the order
// the session recorded them (README: "The skills the model was actually
// shown are in the transcript's skill_listing attachment, in
// config-dir/projects/<project>/<session>.jsonl"). Each transcript line that
// carries one has the shape {..., attachment: {type: "skill_listing",
// content, skillCount, isInitial, names: [...]}}; a listing is attached only
// when it changes (or on the first turn), not on every turn, so its absence
// after a turn means "unchanged from the previous listing", not "no skills".
function skillListings(runDir: string): { names: string[]; skillCount: number }[] {
  const projectsDir = join(runDir, 'config-dir', 'projects');
  const listings: { names: string[]; skillCount: number }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        for (const line of readFileSync(path, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try {
            const rec = JSON.parse(line) as { attachment?: { type?: string; names?: string[]; skillCount?: number } };
            if (rec.attachment?.type === 'skill_listing') {
              listings.push({ names: rec.attachment.names ?? [], skillCount: rec.attachment.skillCount ?? -1 });
            }
          } catch {
            // not every line is JSON we care about; skip
          }
        }
      }
    }
  };
  try {
    walk(projectsDir);
  } catch {
    // no transcript yet
  }
  return listings;
}

async function runTurn(run: ReturnType<typeof startRun>, label: string, prompt: string): Promise<{ answer: string; systemMessages: unknown[] }> {
  run.send({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null });
  let answer = '';
  const systemMessages: unknown[] = [];
  for await (const message of run.messages()) {
    if (message.type === 'system') {
      systemMessages.push(message);
      if (message.subtype === 'init') {
        process.stdout.write(`  [system/init] skills=${JSON.stringify(message.skills)} plugins=${JSON.stringify(message.plugins)}\n`);
      } else {
        process.stdout.write(`  [system/${message.subtype}] ${JSON.stringify(message).slice(0, 300)}\n`);
      }
    }
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') {
          answer += block.text;
        }
      }
    }
    if (message.type === 'result') {
      process.stdout.write(`  [result] subtype=${message.subtype} is_error=${message.is_error}\n`);
      break;
    }
  }
  process.stdout.write(`\n=== ${label} ===\nprompt: ${prompt.split('\n')[0]}\nanswer:\n${answer}\n`);
  return { answer, systemMessages };
}

function reportListings(configDir: string): void {
  const listings = skillListings(configDir);
  process.stdout.write(`\nskill_listing attachments recorded this run (${listings.length}):\n`);
  listings.forEach((l, i) => {
    process.stdout.write(`  #${i}: skillCount=${l.skillCount} names=${JSON.stringify(l.names)}\n`);
  });
}

try {
  if (scenario === 'plugin-no-manifest') {
    const PLUGIN_DIR = join(root, 'plugin');
    const SKILL_A = 'proof12-plugin-skill-a';
    const SKILL_B = 'proof12-plugin-skill-b';
    // No .claude-plugin/plugin.json anywhere under PLUGIN_DIR: plugins.md
    // ("Plugin structure reference") says the manifest is optional and
    // components are auto-discovered from the directory layout.
    writeSkill(join(PLUGIN_DIR, 'skills', SKILL_A), SKILL_A, 'Present when the run starts.');

    const run = startRun({ name: 'skills-dir-plugin-no-manifest', options: { model, plugins: [{ type: 'local', path: PLUGIN_DIR }] } });
    process.stdout.write(`run dir: ${run.dir}\nplugin dir: ${PLUGIN_DIR}\n`);

    await runTurn(run, 'turn 1: only skill A written', QUESTION);

    // Add a second skill file to the SAME already-loaded plugin directory,
    // wait for the filesystem watcher to have had a chance to fire, then
    // ask again with NO reload call: does the plugin's skills/ dir get the
    // same live filesystem watch a project/personal skills dir gets?
    writeSkill(join(PLUGIN_DIR, 'skills', SKILL_B), SKILL_B, 'Added mid-run, before any reload call.');
    await sleep(3000);
    await runTurn(run, 'turn 2: skill B added, no reload call, 3s settle', QUESTION);

    // reloadSkills(): sdk.d.ts says "Reloads skills from disk and returns
    // the refreshed skill list."
    const reloadSkillsResult = await run.query.reloadSkills();
    process.stdout.write(`reloadSkills() result: ${JSON.stringify(reloadSkillsResult)}\n`);
    await runTurn(run, 'turn 3: after reloadSkills()', QUESTION);

    // reloadPlugins(): skills.md says "For a skill folder that is also a
    // plugin, changes to hooks/, .mcp.json, agents/, and output-styles/ need
    // /reload-plugins to take effect." Tried here even though that sentence
    // names other plugin files, to check whether a brand new skill
    // subdirectory (as opposed to an edit to an existing SKILL.md) needs it.
    const reloadPluginsResult = await run.query.reloadPlugins();
    process.stdout.write(`reloadPlugins() result: ${JSON.stringify(reloadPluginsResult)}\n`);
    await runTurn(run, 'turn 4: after reloadPlugins()', QUESTION);

    // Dispatch by name: does the bare skill name run it, or only the
    // plugin-qualified form? A /<name> that matches nothing is answered as
    // an ordinary prompt (skills.md, "Dispatch commands by name"), so ask
    // the model to say which one happened.
    const supported = await run.query.supportedCommands();
    process.stdout.write(`supportedCommands(): ${JSON.stringify(supported.map((c) => c.name))}\n`);
    await runTurn(run, 'turn 5: dispatch bare name', `/${SKILL_A}`);
    await runTurn(run, 'turn 6: dispatch plugin-qualified name (directory basename "plugin")', `/plugin:${SKILL_A}`);

    run.end();
    await run.done;
    reportListings(run.dir);
    process.stdout.write('done\n');
  } else if (scenario === 'add-dir-only' || scenario === 'add-dir-reload') {
    const ADDED_DIR = join(root, 'added-project');
    const SKILL_C = 'proof12-adddir-skill-c';
    // Project-shaped layout: <dir>/.claude/skills/<name>/SKILL.md, the shape
    // agent-sdk/skills.md's settingSources Note says additionalDirectories
    // covers ("The project source also covers <dir>/.claude/skills/ in each
    // directory you pass through additionalDirectories").
    writeSkill(join(ADDED_DIR, '.claude', 'skills', SKILL_C), SKILL_C, 'Lives under an additionalDirectories entry.');

    const run = startRun({ name: `skills-dir-${scenario}`, options: { model, additionalDirectories: [ADDED_DIR] } });
    process.stdout.write(`run dir: ${run.dir}\nadded dir: ${ADDED_DIR}\n`);

    await runTurn(run, 'turn 1: additionalDirectories only, settingSources forced to []', QUESTION);

    if (scenario === 'add-dir-reload') {
      const reloadSkillsResult = await run.query.reloadSkills();
      process.stdout.write(`reloadSkills() result: ${JSON.stringify(reloadSkillsResult)}\n`);
      await runTurn(run, 'turn 2: after reloadSkills(), still settingSources []', QUESTION);
    }

    run.end();
    await run.done;
    reportListings(run.dir);
    process.stdout.write('done\n');
  } else if (scenario === 'project-config-root') {
    const CONFIG_ROOT = join(root, 'project-root');
    const SKILL_D = 'proof12-projectroot-skill-d';
    writeSkill(join(CONFIG_ROOT, '.claude', 'skills', SKILL_D), SKILL_D, 'Lives under projectConfigRoot.');

    const run = startRun({ name: 'skills-dir-project-config-root', options: { model, projectConfigRoot: CONFIG_ROOT } });
    process.stdout.write(`run dir: ${run.dir}\nprojectConfigRoot: ${CONFIG_ROOT}\n`);

    await runTurn(run, 'turn 1: projectConfigRoot set, settingSources forced to []', QUESTION);

    run.end();
    await run.done;
    reportListings(run.dir);
    process.stdout.write('done\n');
  } else {
    process.stderr.write(`unknown scenario ${JSON.stringify(scenario)}\n`);
    process.exit(2);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
