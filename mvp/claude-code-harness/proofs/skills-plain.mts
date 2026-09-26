// Proof 19: skills from config-declared directories, without a prefix.
//
// The goal (Stephen): "to declare skills directories in config", and not the
// plugin route ("doesnt the plugin prefix them? thats ugly"). Each scenario
// below is one route, measured against:
//   - plain names: the transcript's skill_listing, not the model's answer
//   - whether it loads under the harness's settingSources: [] or what it
//     needs opened up (opened in this file, never in the harness)
//   - live: a new skill, an edited skill, a re-pointed directory
//   - only skills: sentinels placed next to the skills
//
// Sources found in the 2.1.282 binary (undocumented; function names are the
// minified ones in that build):
//   L$o (skill loader): managed = <Ik()>/.claude/skills loaded as
//     policySettings with no settingSources gate (only
//     CLAUDE_CODE_DISABLE_POLICY_SKILLS); user = <CLAUDE_CONFIG_DIR>/skills
//     gated by nr("userSettings"); --add-dir <dir>/.claude/skills gated by
//     nr("projectSettings").
//   X() (skill watcher): chokidar, polling, on <CLAUDE_CONFIG_DIR>/skills,
//     <project>/.claude/skills and each --add-dir's .claude/skills, if they
//     exist when the watcher starts. Not the managed directory.
//
// Every scenario passes debugFile and OTEL_LOG_RAW_API_BODIES, copied
// redacted into the run directory: the loader's own "Loading skills from" /
// "Loaded N unique skills (... managed: X, user: Y ...)" lines and the
// watcher's "Watching for changes" / "Detected skill change" lines, and
// every request body (sentinel markers are searched for there).
//
//   node proofs/skills-plain.mts <model> <scenario>
//
// Scenario `managed` refuses to run unless it is inside a private mount
// namespace with its own /etc (see proofs/private-etc.sh).

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { startRun } from '../src/harness.mts';
import { redact, stamp } from '../src/record.mts';

const [model, scenario] = process.argv.slice(2);
const SCENARIOS = ['user-closed', 'user-open', 'user-open-late', 'user-open-links', 'user-open-nosync', 'managed', 'project-adddir', 'project-config-root-open', 'canusetool-closed', 'canusetool-open', 'register-root-open', 'bare-adddir', 'bare-adddir-closed'];
if (!model || !scenario || !SCENARIOS.includes(scenario)) {
  process.stderr.write(`usage: node proofs/skills-plain.mts <model> <${SCENARIOS.join('|')}>\n`);
  process.exit(2);
}

const root = mkdtempSync(join(tmpdir(), 'tower-proof-19-'));
const SETTLE_MS = 8000;
const OK = "Reply with the single word OK. Don't use any tools.";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(line: string): void {
  process.stdout.write(`${stamp()} ${line}\n`);
}

function skillMd(name: string, marker: string, extraFrontmatter = '', body = "Dummy skill for tower proof 19. It has no task, don't use it."): string {
  return `---\nname: ${name}\ndescription: Dummy skill for tower proof 19 (skills-plain). MARKER=${marker}\n${extraFrontmatter}---\n\n${body}\n`;
}

function writeSkill(dir: string, name: string, marker: string, extraFrontmatter = '', body?: string): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'SKILL.md'), skillMd(name, marker, extraFrontmatter, body));
}

// A skill whose own frontmatter carries a hook (a skill-scoped hook): the
// question is whether a skill-only route still brings hooks in through the
// skill itself. The hook only touches a file under this run's fixture root.
function hookedSkill(dir: string, name: string, hookRanFile: string): void {
  const fm = `hooks:\n  PostToolUse:\n    - matcher: "Read"\n      hooks:\n        - type: command\n          command: "touch ${hookRanFile}"\n`;
  writeSkill(dir, name, 'HOOKED', fm, 'When invoked: use the Read tool once on the file p19-probe.txt in the current working directory, then reply with the single word DONE.');
}

// Sentinels next to the skills in a declared directory: things a plugin root
// would load (agents/, commands/, hooks/hooks.json, .mcp.json) plus a
// CLAUDE.md and a settings.json. None should load on a skills-only route.
function declSentinels(dir: string, tag: string, hookRanFile: string): void {
  mkdirSync(join(dir, 'agents'), { recursive: true });
  writeFileSync(join(dir, 'agents', `p19-sentinel-agent-${tag}.md`), `---\nname: p19-sentinel-agent-${tag}\ndescription: P19-SENTINEL-AGENT-${tag}\n---\n\nP19-SENTINEL-AGENT-BODY-${tag}\n`);
  mkdirSync(join(dir, 'commands'), { recursive: true });
  writeFileSync(join(dir, 'commands', `p19-sentinel-cmd-${tag}.md`), `---\ndescription: P19-SENTINEL-CMD-${tag}\n---\n\nP19-SENTINEL-CMD-BODY-${tag}\n`);
  mkdirSync(join(dir, 'hooks'), { recursive: true });
  const hooks = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch ${hookRanFile}` }] }], UserPromptSubmit: [{ hooks: [{ type: 'command', command: `touch ${hookRanFile}` }] }] } };
  writeFileSync(join(dir, 'hooks', 'hooks.json'), JSON.stringify(hooks, null, 2));
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(hooks, null, 2));
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { [`p19-sentinel-mcp-${tag}`]: { command: 'true' } } }, null, 2));
  writeFileSync(join(dir, 'CLAUDE.md'), `P19-SENTINEL-CLAUDEMD-${tag}\n`);
}

// The declared directories every scenario uses: A at start, B for the
// re-point. A has a plain skill, a hooked skill and the sentinels; B one
// plain skill.
function declaredDirs(): { A: string; B: string; hookRanDecl: string; hookRanSkill: string; hookRanPluginShaped: string } {
  const A = join(root, 'declared-a');
  const B = join(root, 'declared-b');
  const hookRanDecl = join(root, 'HOOK-RAN-declared-dir');
  const hookRanSkill = join(root, 'HOOK-RAN-skill-frontmatter');
  const hookRanPluginShaped = join(root, 'HOOK-RAN-plugin-shaped-entry');
  writeSkill(A, 'p19-a1', 'V1');
  hookedSkill(A, 'p19-hooked', hookRanSkill);
  declSentinels(A, 'decl', hookRanDecl);
  // An entry in the declared directory shaped like a plugin (a
  // .claude-plugin/ manifest and a skills/ child): the binary's debug log
  // ("[plugins] skipping hidden skills-dir entry ...: dot-prefixed dirs are
  // never adopted as plugins") shows skills-dir entries can be adopted as
  // plugins. Its hooks/hooks.json touches a file if that happens.
  const shaped = join(A, 'p19-pluginshaped');
  mkdirSync(join(shaped, '.claude-plugin'), { recursive: true });
  writeFileSync(join(shaped, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'p19-pluginshaped' }, null, 2));
  writeSkill(join(shaped, 'skills'), 'p19-inner', 'INNER');
  declSentinels(shaped, 'shaped', hookRanPluginShaped);
  writeSkill(B, 'p19-b1', 'B');
  return { A, B, hookRanDecl, hookRanSkill, hookRanPluginShaped };
}

type Run = ReturnType<typeof startRun>;

async function turn(run: Run, label: string, prompt: string): Promise<void> {
  log(`>>> ${label}: send ${JSON.stringify(prompt.slice(0, 80))}`);
  run.send({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null });
  let answer = '';
  for await (const message of run.messages()) {
    if (message.type === 'system') {
      if (message.subtype === 'init') {
        log(`  [system/init] skills=${JSON.stringify(message.skills)}`);
        log(`  [system/init] slash_commands=${JSON.stringify(message.slash_commands)}`);
        log(`  [system/init] agents=${JSON.stringify(message.agents)} mcp_servers=${JSON.stringify(message.mcp_servers)} plugins=${JSON.stringify(message.plugins)}`);
      } else {
        log(`  [system/${message.subtype}] ${JSON.stringify(message).slice(0, 600)}`);
      }
    }
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') answer += block.text;
        if (block.type === 'tool_use') log(`  [tool_use] ${block.name} ${JSON.stringify(block.input).slice(0, 200)}`);
      }
    }
    if (message.type === 'result') {
      log(`  [result] subtype=${message.subtype} is_error=${message.is_error}`);
      break;
    }
  }
  log(`<<< ${label}: answer ${JSON.stringify(answer.slice(0, 200))}`);
}

async function reloadSkills(run: Run, label: string): Promise<void> {
  try {
    const r = await run.query.reloadSkills();
    log(`reloadSkills() [${label}]: ${JSON.stringify(r.skills.map((s) => s.name))}`);
  } catch (err) {
    log(`reloadSkills() [${label}] threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}

type RawQuery = { request(req: Record<string, unknown>): Promise<unknown> };

// get_hooks_listing and list_permission_rules have no method on the typed
// Query; they go through the same internal request() reloadSkills uses
// (undocumented, as proof 12's register_repo_root call was).
async function raw(run: Run, req: Record<string, unknown>): Promise<unknown> {
  try {
    return await (run.query as unknown as RawQuery).request(req);
  } catch (err) {
    return { threw: err instanceof Error ? err.message : String(err) };
  }
}

async function hooksAndRules(run: Run, label: string): Promise<void> {
  log(`get_hooks_listing [${label}]: ${JSON.stringify(await raw(run, { subtype: 'get_hooks_listing' })).slice(0, 3000)}`);
  log(`list_permission_rules [${label}]: ${JSON.stringify(await raw(run, { subtype: 'list_permission_rules' })).slice(0, 1500)}`);
}

// Per-scenario instrumentation: debug log and request bodies, outside the
// repo while live, copied redacted into the run directory afterwards.
function instrument(name: string): { bodiesDir: string; debugFile: string; env: Record<string, string | undefined> } {
  const bodiesDir = join(homedir(), '.local', 'state', 'tower-claude-code-harness', 'api-bodies', `${stamp().replace(/[:.]/g, '')}-${name}`);
  mkdirSync(bodiesDir, { recursive: true });
  return { bodiesDir, debugFile: join(bodiesDir, 'debug.log'), env: { ...process.env, OTEL_LOG_RAW_API_BODIES: `file:${bodiesDir}` } };
}

interface Listing {
  ts: string;
  isInitial: boolean;
  names: string[];
  skillCount: number;
  content: string;
}

function transcriptLines(runDir: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        for (const line of readFileSync(path, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try {
            out.push(JSON.parse(line) as Record<string, unknown>);
          } catch {
            // not JSON
          }
        }
      }
    }
  };
  walk(join(runDir, 'config-dir', 'projects'));
  return out;
}

function report(runDir: string, bodiesDir: string, extraFiles: Record<string, string>): void {
  // Copy the debug log and request bodies, redacted.
  const outDir = join(runDir, 'api-bodies');
  mkdirSync(outDir, { recursive: true });
  for (const entry of existsSync(bodiesDir) ? readdirSync(bodiesDir) : []) {
    const { text } = redact(readFileSync(join(bodiesDir, entry), 'utf8'));
    writeFileSync(entry === 'debug.log' ? join(runDir, 'debug.log') : join(outDir, entry), text);
  }

  const lines = transcriptLines(runDir);
  const listings: Listing[] = [];
  for (const rec of lines) {
    const att = rec.attachment as { type?: string; names?: string[]; skillCount?: number; content?: string; isInitial?: boolean } | undefined;
    if (att?.type === 'skill_listing') listings.push({ ts: String(rec.timestamp), isInitial: att.isInitial === true, names: att.names ?? [], skillCount: att.skillCount ?? -1, content: att.content ?? '' });
  }
  log(`skill_listing attachments (${listings.length}), p19 names only; the rest are the account's built-ins:`);
  for (const l of listings) {
    const p19 = l.names.filter((n) => n.includes('p19'));
    const markers = [...l.content.matchAll(/MARKER=(\w+)/g)].map((m) => m[1]);
    log(`  ${l.ts} isInitial=${l.isInitial} skillCount=${l.skillCount} p19=${JSON.stringify(p19)} markers=${JSON.stringify(markers)}`);
  }
  const commandNames = lines
    .map((rec) => JSON.stringify(rec))
    .flatMap((s) => [...s.matchAll(/<command-name>([^<]*)<\/command-name>/g)].map((m) => m[1]))
    .filter((v, i, a) => a.indexOf(v) === i);
  log(`<command-name> values in the transcript: ${JSON.stringify(commandNames)}`);
  const bodyMarkers = [...new Set(lines.map((rec) => JSON.stringify(rec)).flatMap((t) => [...t.matchAll(/BODY-MARKER-\w+/g)].map((m) => m[0])))];
  log(`BODY-MARKER values anywhere in the transcript: ${JSON.stringify(bodyMarkers)}`);
  const attachmentTypes = [...new Set(lines.map((rec) => (rec.attachment as { type?: string } | undefined)?.type).filter(Boolean))];
  log(`transcript attachment types: ${JSON.stringify(attachmentTypes)}`);

  // Sentinels in any request body.
  const hits = new Map<string, Set<string>>();
  for (const entry of existsSync(outDir) ? readdirSync(outDir) : []) {
    const text = readFileSync(join(outDir, entry), 'utf8');
    for (const m of text.matchAll(/P19-SENTINEL-[A-Z]+(?:-BODY)?-[a-z-]+/g)) {
      if (!hits.has(m[0])) hits.set(m[0], new Set());
      hits.get(m[0])?.add(entry);
    }
  }
  log(`sentinel markers found in request bodies: ${hits.size === 0 ? 'none' : JSON.stringify(Object.fromEntries([...hits].map(([k, v]) => [k, [...v]])))}`);

  // Debug-log lines the loader and watcher write.
  const debugPath = join(runDir, 'debug.log');
  if (existsSync(debugPath)) {
    const wanted = /Loading skills from|Loaded \d+ unique skills|Watching for changes in skill|Detected skill change|session moved|reduced mode|setting.?sources|skill_listing|Skipping|not loading|leads outside/i;
    for (const line of readFileSync(debugPath, 'utf8').split('\n')) {
      if (wanted.test(line)) log(`  [debug] ${line.slice(0, 400)}`);
    }
  } else {
    log('no debug.log');
  }

  for (const [label, path] of Object.entries(extraFiles)) {
    log(`hook-ran file ${label}: ${existsSync(path) ? 'EXISTS (the hook ran)' : 'absent'}`);
  }
}

// The live sequence every positive route runs, given how to re-point.
async function liveSequence(run: Run, dirs: { A: string; B: string }, repoint: () => void): Promise<void> {
  await turn(run, 'T1 initial listing', OK);
  await hooksAndRules(run, 'after T1');

  // Bare-name dispatch of the hooked skill (also exercises its frontmatter
  // hook: the skill asks for one Read of a file in cwd).
  writeFileSync(join(run.cwd, 'p19-probe.txt'), 'probe\n');
  await turn(run, 'T2 dispatch /p19-hooked by bare name', '/p19-hooked');
  await hooksAndRules(run, 'after T2');

  writeSkill(dirs.A, 'p19-a2', 'NEW');
  log(`wrote new skill p19-a2 into ${dirs.A}; settling ${SETTLE_MS}ms`);
  await sleep(SETTLE_MS);
  await turn(run, 'T3 after adding p19-a2, no reload call', OK);

  writeFileSync(join(dirs.A, 'p19-a1', 'SKILL.md'), skillMd('p19-a1', 'V2'));
  log(`edited p19-a1 MARKER=V1 -> V2; settling ${SETTLE_MS}ms`);
  await sleep(SETTLE_MS);
  await turn(run, 'T4 after editing p19-a1, no reload call', OK);

  repoint();
  log(`re-pointed to ${dirs.B}; settling ${SETTLE_MS}ms`);
  await sleep(SETTLE_MS);
  await turn(run, 'T5 after re-point, no reload call', OK);
  // Is a re-point a removal, or only an addition? Invoke a skill that is
  // only in the old directory, still with no reload call.
  await turn(run, 'T5b invoke /p19-a1 (only in the old directory), no reload call', '/p19-a1');

  await reloadSkills(run, 'after re-point');
  await turn(run, 'T6 after reloadSkills()', OK);
}

// What is in each declared directory after the run: Claude Code may write
// into a directory it reaches through a symlink (skills sync's synced/).
function listDeclared(): void {
  for (const d of ['declared-a', 'declared-b']) {
    const dir = join(root, d);
    if (existsSync(dir)) log(`declared dir ${d} top-level entries after the run: ${JSON.stringify(readdirSync(dir).sort())}`);
  }
}

async function finish(run: Run, bodiesDir: string, files: Record<string, string>): Promise<void> {
  run.end();
  try {
    await run.done;
  } catch (err) {
    log(`run.done rejected: ${err instanceof Error ? err.message : String(err)}`);
  }
  log(`run dir: ${run.dir}`);
  report(run.dir, bodiesDir, files);
  listDeclared();
  const cfgSkills = join(run.configDir, 'skills');
  if (existsSync(cfgSkills)) log(`<CLAUDE_CONFIG_DIR>/skills entries after the run: ${JSON.stringify(readdirSync(cfgSkills).sort())}`);
}

function swapLink(link: string, target: string): void {
  unlinkSync(link);
  symlinkSync(target, link);
}

try {
  const name = `skills-plain-${scenario}`;
  const inst = instrument(name);

  if (scenario === 'user-closed' || scenario === 'user-open' || scenario === 'user-open-late' || scenario === 'user-open-nosync') {
    // <CLAUDE_CONFIG_DIR>/skills as a symlink to the declared directory.
    // user-closed: the harness's settingSources [] untouched.
    // user-open / user-open-late: the proof opens userSettings with
    // extraArgs (the SDK already passed --setting-sources= empty; the CLI
    // gets both flags, argv.json shows which came last).
    const dirs = declaredDirs();
    const open = scenario !== 'user-closed';
    const run = startRun({
      name,
      options: {
        model,
        debugFile: inst.debugFile,
        env: inst.env,
        ...(open ? { extraArgs: { 'setting-sources': 'user' } } : {}),
        // syncClaudeAiSkills (a settings key found in the binary, next to
        // syncClaudeAiPlugins): off here to see whether it stops Claude Code
        // writing the account's skills into <CLAUDE_CONFIG_DIR>/skills/synced.
        ...(scenario === 'user-open-nosync' ? { settings: { syncClaudeAiSkills: false } } : {}),
      },
    });
    const link = join(run.configDir, 'skills');
    // Sentinels in the config dir itself: opening userSettings reads
    // <CLAUDE_CONFIG_DIR>/{settings.json,CLAUDE.md,agents,commands,rules}.
    const hookRanConfig = join(root, 'HOOK-RAN-config-dir');
    mkdirSync(join(run.configDir, 'agents'), { recursive: true });
    writeFileSync(join(run.configDir, 'agents', 'p19-sentinel-agent-cfg.md'), '---\nname: p19-sentinel-agent-cfg\ndescription: P19-SENTINEL-AGENT-cfg\n---\n\nP19-SENTINEL-AGENT-BODY-cfg\n');
    mkdirSync(join(run.configDir, 'commands'), { recursive: true });
    writeFileSync(join(run.configDir, 'commands', 'p19-sentinel-cmd-cfg.md'), '---\ndescription: P19-SENTINEL-CMD-cfg\n---\n\nP19-SENTINEL-CMD-BODY-cfg\n');
    mkdirSync(join(run.configDir, 'rules'), { recursive: true });
    writeFileSync(join(run.configDir, 'rules', 'p19.md'), 'P19-SENTINEL-RULE-cfg\n');
    writeFileSync(join(run.configDir, 'CLAUDE.md'), 'P19-SENTINEL-CLAUDEMD-cfg\n');
    writeFileSync(
      join(run.configDir, 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(echo P19-SENTINEL-PERM-cfg)'] }, hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `touch ${hookRanConfig}` }] }] } }, null, 2),
    );
    if (scenario !== 'user-open-late') {
      symlinkSync(dirs.A, link);
      log(`symlinked ${link} -> ${dirs.A} (right after startRun)`);
    }
    log(`run dir: ${run.dir}\nconfig dir: ${run.configDir}`);

    if (scenario === 'user-closed') {
      await turn(run, 'T1 initial listing', OK);
      await reloadSkills(run, 'closed');
      await turn(run, 'T2 after reloadSkills()', OK);
      await hooksAndRules(run, 'after T2');
    } else if (scenario === 'user-open') {
      await liveSequence(run, dirs, () => swapLink(link, dirs.B));
    } else if (scenario === 'user-open-nosync') {
      // user-open's run wrote synced/ a few seconds in; give it time.
      await turn(run, 'T1 initial listing', OK);
      await sleep(SETTLE_MS);
      await turn(run, 'T2 after a settle', OK);
    } else {
      // No skills dir set when the run starts; set one after the first turn.
      await turn(run, 'T1 initial listing, no skills dir yet', OK);
      if (existsSync(link)) {
        // Claude Code made <CLAUDE_CONFIG_DIR>/skills itself (seen in the
        // first draft of this scenario: EEXIST on the symlink). Link each
        // declared skill into it instead.
        log(`Claude Code created ${link} itself; entries: ${JSON.stringify(readdirSync(link))}`);
        for (const entry of ['p19-a1', 'p19-hooked']) symlinkSync(join(dirs.A, entry), join(link, entry));
        log(`linked p19-a1, p19-hooked from ${dirs.A} into ${link} mid-run; settling ${SETTLE_MS}ms`);
      } else {
        symlinkSync(dirs.A, link);
        log(`created ${link} -> ${dirs.A} mid-run; settling ${SETTLE_MS}ms`);
      }
      await sleep(SETTLE_MS);
      await turn(run, 'T2 after creating the skills dir, no reload call', OK);
      await reloadSkills(run, 'after late create');
      await turn(run, 'T3 after reloadSkills()', OK);
      writeFileSync(join(dirs.A, 'p19-a1', 'SKILL.md'), skillMd('p19-a1', 'V2'));
      log(`edited p19-a1 MARKER=V1 -> V2; settling ${SETTLE_MS}ms`);
      await sleep(SETTLE_MS);
      await turn(run, 'T4 after editing p19-a1, no reload call', OK);
    }
    await finish(run, inst.bodiesDir, { configDirHook: hookRanConfig, declaredDirHook: dirs.hookRanDecl, skillFrontmatterHook: dirs.hookRanSkill, pluginShapedEntryHook: dirs.hookRanPluginShaped });
  } else if (scenario === 'user-open-links') {
    // Several declared directories through one user skills dir: a real
    // <CLAUDE_CONFIG_DIR>/skills whose entries are per-skill symlinks into
    // two declared directories.
    const dirs = declaredDirs();
    const run = startRun({ name, options: { model, debugFile: inst.debugFile, env: inst.env, extraArgs: { 'setting-sources': 'user' } } });
    const skills = join(run.configDir, 'skills');
    mkdirSync(skills, { recursive: true });
    symlinkSync(join(dirs.A, 'p19-a1'), join(skills, 'p19-a1'));
    symlinkSync(join(dirs.B, 'p19-b1'), join(skills, 'p19-b1'));
    log(`per-skill links in ${skills}: p19-a1 -> A, p19-b1 -> B`);
    await turn(run, 'T1 initial listing', OK);
    writeSkill(dirs.B, 'p19-b2', 'NEW');
    symlinkSync(join(dirs.B, 'p19-b2'), join(skills, 'p19-b2'));
    log(`added link p19-b2 -> B; settling ${SETTLE_MS}ms`);
    await sleep(SETTLE_MS);
    await turn(run, 'T2 after adding a link, no reload call', OK);
    unlinkSync(join(skills, 'p19-a1'));
    log(`removed link p19-a1; settling ${SETTLE_MS}ms`);
    await sleep(SETTLE_MS);
    await turn(run, 'T3 after removing a link, no reload call', OK);
    await finish(run, inst.bodiesDir, { declaredDirHook: dirs.hookRanDecl, pluginShapedEntryHook: dirs.hookRanPluginShaped });
  } else if (scenario === 'managed') {
    // /etc/claude-code/.claude/skills, the managed (policySettings) skills
    // directory, loaded with no settingSources gate. Only inside a private
    // mount namespace (proofs/private-etc.sh): the real /etc is never
    // written.
    const uidMap = readFileSync('/proc/self/uid_map', 'utf8').trim().split(/\s+/);
    const identity = uidMap[0] === '0' && uidMap[1] === '0' && uidMap[2] === '4294967295';
    if (process.env.P19_PRIVATE_ETC !== '1' || identity) {
      throw new Error('managed: refusing to run outside the private /etc namespace (proofs/private-etc.sh)');
    }
    const dirs = declaredDirs();
    const managedClaude = '/etc/claude-code/.claude';
    mkdirSync(managedClaude, { recursive: true });
    const link = join(managedClaude, 'skills');
    symlinkSync(dirs.A, link);
    log(`symlinked ${link} -> ${dirs.A} (private /etc, before startRun)`);
    const run = startRun({ name, options: { model, debugFile: inst.debugFile, env: inst.env } });
    log(`run dir: ${run.dir}`);
    await liveSequence(run, dirs, () => swapLink(link, dirs.B));
    // Managed is not watched. A body-only edit (description unchanged), no
    // reload: is the new body what an invocation injects?
    writeSkill(dirs.B, 'p19-b1', 'B', '', 'BODY-MARKER-V2. Reply with the single word DONE.');
    log(`edited p19-b1's body only (BODY-MARKER-V2), no reload call`);
    await turn(run, 'T7 invoke /p19-b1 after a body-only edit, no reload call', '/p19-b1');
    // What a reload costs when nothing changed: does each one re-attach a
    // full listing?
    await reloadSkills(run, 'no change 1');
    await turn(run, 'T8 after reloadSkills() with nothing changed', OK);
    await reloadSkills(run, 'no change 2');
    await turn(run, 'T9 after a second reloadSkills() with nothing changed', OK);
    await finish(run, inst.bodiesDir, { declaredDirHook: dirs.hookRanDecl, skillFrontmatterHook: dirs.hookRanSkill, pluginShapedEntryHook: dirs.hookRanPluginShaped });
  } else if (scenario === 'project-config-root-open') {
    // projectConfigRoot as the skill source, projectSettings opened:
    // <projectConfigRoot>/.claude/skills is a symlink to the declared
    // directory. Same CLAUDE.md guard as project-adddir.
    const dirs = declaredDirs();
    const pcr = join(root, 'pcr');
    mkdirSync(join(pcr, '.claude'), { recursive: true });
    const link = join(pcr, '.claude', 'skills');
    symlinkSync(dirs.A, link);
    const run = startRun({
      name,
      options: {
        model,
        debugFile: inst.debugFile,
        env: { ...inst.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' },
        extraArgs: { 'setting-sources': 'project' },
        projectConfigRoot: pcr,
      },
    });
    log(`run dir: ${run.dir}\nprojectConfigRoot: ${pcr} (.claude/skills -> ${dirs.A})`);
    await liveSequence(run, dirs, () => swapLink(link, dirs.B));
    await hooksAndRules(run, 'end');
    await finish(run, inst.bodiesDir, { declaredDirHook: dirs.hookRanDecl, skillFrontmatterHook: dirs.hookRanSkill, pluginShapedEntryHook: dirs.hookRanPluginShaped });
  } else if (scenario === 'project-adddir') {
    // additionalDirectories with projectSettings opened. The add-dir is a
    // wrapper whose .claude/skills is a symlink to the declared directory.
    // projectConfigRoot points at an empty directory, and the proof's cwd
    // gets negative probes, to see whether the project layer still reads
    // cwd. CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 keeps the CLAUDE.md ancestor
    // walk (which reaches $HOME) off: with projectSettings open it would
    // otherwise read CLAUDE.md files above cwd.
    const dirs = declaredDirs();
    const wrap = join(root, 'wrap');
    mkdirSync(join(wrap, '.claude'), { recursive: true });
    const link = join(wrap, '.claude', 'skills');
    symlinkSync(dirs.A, link);
    const emptyRoot = join(root, 'empty-project-root');
    mkdirSync(emptyRoot, { recursive: true });
    // The harness's per-proof working directory (README: work/<name>),
    // written before startRun so the probes exist when the binary starts.
    const cwdClaude = join(homedir(), '.local', 'state', 'tower-claude-code-harness', 'work', name, '.claude');
    const hookRanCwd = join(root, 'HOOK-RAN-cwd');
    try {
      writeSkill(join(cwdClaude, 'skills'), 'p19-cwd-probe', 'CWD');
      writeFileSync(join(cwdClaude, 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(echo P19-SENTINEL-PERM-cwd)'] }, hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `touch ${hookRanCwd}` }] }] } }, null, 2));
      const run = startRun({
        name,
        options: {
          model,
          debugFile: inst.debugFile,
          env: { ...inst.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' },
          extraArgs: { 'setting-sources': 'project' },
          additionalDirectories: [wrap],
          projectConfigRoot: emptyRoot,
        },
      });
      if (join(run.cwd, '.claude') !== cwdClaude) throw new Error(`cwd mismatch: ${run.cwd}`);
      log(`run dir: ${run.dir}\nadd-dir wrapper: ${wrap} (.claude/skills -> ${dirs.A})\nprojectConfigRoot: ${emptyRoot}\ncwd probes in ${cwdClaude}`);
      await liveSequence(run, dirs, () => swapLink(link, dirs.B));
      await finish(run, inst.bodiesDir, { cwdHook: hookRanCwd, declaredDirHook: dirs.hookRanDecl, skillFrontmatterHook: dirs.hookRanSkill, pluginShapedEntryHook: dirs.hookRanPluginShaped });
    } finally {
      rmSync(cwdClaude, { recursive: true, force: true });
    }
  } else if (scenario === 'watch-timing') {
    // Two unmeasured cases on a watched route (user skills dir, open):
    // a body-only edit (no description change) picked up and injected on
    // invocation, and whether the watcher's post-idle switch to 30s polling
    // (chokidar interval, from the binary: active 2s / idle 30s after 60s
    // with no interaction) delays a change sent right after that idle gap.
    const dirs = declaredDirs();
    const run = startRun({ name, options: { model, debugFile: inst.debugFile, env: inst.env, extraArgs: { 'setting-sources': 'user' } } });
    const link = join(run.configDir, 'skills');
    symlinkSync(dirs.A, link);
    log(`run dir: ${run.dir}\nsymlinked ${link} -> ${dirs.A}`);

    await turn(run, 'T1 initial listing', OK);

    // Body-only edit: description unchanged, body carries a new marker.
    writeFileSync(join(dirs.A, 'p19-a1', 'SKILL.md'), skillMd('p19-a1', 'V1', '', 'BODY-MARKER-V2. Reply with the single word DONE.'));
    log(`edited p19-a1's body only (BODY-MARKER-V2), description unchanged; settling ${SETTLE_MS}ms`);
    await sleep(SETTLE_MS);
    await turn(run, 'T2 invoke /p19-a1 after a body-only edit, no reload call', '/p19-a1');

    // Idle past the watcher's 60s-idle threshold, then edit again and send
    // a turn immediately (no settle), to see whether the slower poll delays
    // pickup right after the switch.
    log('idling 65s to cross the watcher\'s 60s-idle threshold (active 2s -> idle 30s polling)');
    await sleep(65000);
    writeFileSync(join(dirs.A, 'p19-a1', 'SKILL.md'), skillMd('p19-a1', 'V3'));
    log('edited p19-a1 MARKER=V1 -> V3 right after the idle threshold; sending the next turn immediately, no settle');
    await turn(run, 'T3 immediately after the post-idle edit, no settle, no reload call', OK);
    await sleep(SETTLE_MS);
    await turn(run, 'T4 after an additional settle, no reload call', OK);

    await finish(run, inst.bodiesDir, {});
  } else if (scenario === 'canusetool-closed' || scenario === 'canusetool-open') {
    // A directory added mid-session through canUseTool's answer: an allow
    // with an addDirectories PermissionUpdate (destination session). It
    // fires only when the model uses a tool on a path outside the working
    // directories, so the first turn asks for a Read of a file in the
    // wrapper.
    const dirs = declaredDirs();
    const wrap = join(root, 'wrap');
    mkdirSync(join(wrap, '.claude'), { recursive: true });
    symlinkSync(dirs.A, join(wrap, '.claude', 'skills'));
    writeFileSync(join(wrap, 'README.txt'), 'p19 wrapper\n');
    const open = scenario === 'canusetool-open';
    const emptyRoot = join(root, 'empty-project-root');
    mkdirSync(emptyRoot, { recursive: true });
    const canUseTool: CanUseTool = async (toolName, input, opts) => {
      log(`  [canUseTool] ${toolName} ${JSON.stringify(input).slice(0, 200)} suggestions=${JSON.stringify(opts.suggestions ?? [])}`);
      if (JSON.stringify(input).includes(wrap)) {
        return { behavior: 'allow', updatedInput: input, updatedPermissions: [{ type: 'addDirectories', directories: [wrap], destination: 'session' }] };
      }
      return { behavior: 'deny', message: 'proof 19: only the wrapper directory is allowed' };
    };
    const run = startRun({
      name,
      options: {
        model,
        debugFile: inst.debugFile,
        env: open ? { ...inst.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' } : inst.env,
        canUseTool,
        ...(open ? { extraArgs: { 'setting-sources': 'project' }, projectConfigRoot: emptyRoot } : {}),
      },
    });
    log(`run dir: ${run.dir}\nwrapper: ${wrap}`);
    await turn(run, 'T1 Read a file in the wrapper (fires canUseTool)', `Use the Read tool to read ${join(wrap, 'README.txt')} and reply with its contents.`);
    // Whether the addDirectories update took: workspaceDirectories.
    await hooksAndRules(run, 'after T1');
    await sleep(SETTLE_MS);
    await turn(run, 'T2 after the directory was added, no reload call', OK);
    await reloadSkills(run, 'after addDirectories');
    await turn(run, 'T3 after reloadSkills()', OK);
    await finish(run, inst.bodiesDir, { declaredDirHook: dirs.hookRanDecl, pluginShapedEntryHook: dirs.hookRanPluginShaped });
  } else if (scenario === 'register-root-open') {
    // register_repo_root (internal control request) under a launch add-dir,
    // projectSettings opened: the directory must be a strict subdirectory
    // of cwd or of a launch --add-dir, so the add-dir is a parent with no
    // .claude of its own and the registered directory is a child wrapper.
    const dirs = declaredDirs();
    const parent = join(root, 'parent');
    const child = join(parent, 'child');
    mkdirSync(join(child, '.claude'), { recursive: true });
    symlinkSync(dirs.A, join(child, '.claude', 'skills'));
    const emptyRoot = join(root, 'empty-project-root');
    mkdirSync(emptyRoot, { recursive: true });
    const run = startRun({
      name,
      options: {
        model,
        debugFile: inst.debugFile,
        env: { ...inst.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' },
        extraArgs: { 'setting-sources': 'project' },
        additionalDirectories: [parent],
        projectConfigRoot: emptyRoot,
      },
    });
    log(`run dir: ${run.dir}\nlaunch add-dir: ${parent}\nregistered: ${child}`);
    await turn(run, 'T1 before register_repo_root', OK);
    log(`register_repo_root: ${JSON.stringify(await raw(run, { subtype: 'register_repo_root', directory: child, reload_skills: true }))}`);
    await turn(run, 'T2 after register_repo_root', OK);
    await hooksAndRules(run, 'after T2');
    writeSkill(dirs.A, 'p19-a2', 'NEW');
    log(`wrote new skill p19-a2 into ${dirs.A}; settling ${SETTLE_MS}ms`);
    await sleep(SETTLE_MS);
    await turn(run, 'T3 after adding p19-a2, no reload call', OK);
    swapLink(join(child, '.claude', 'skills'), dirs.B);
    log(`re-pointed ${join(child, '.claude', 'skills')} to ${dirs.B}; settling ${SETTLE_MS}ms`);
    await sleep(SETTLE_MS);
    await turn(run, 'T4 after re-point, no reload call', OK);
    await turn(run, 'T5 invoke /p19-a1 (only in the old directory), no reload call', '/p19-a1');
    await finish(run, inst.bodiesDir, { declaredDirHook: dirs.hookRanDecl, pluginShapedEntryHook: dirs.hookRanPluginShaped });
  } else if (scenario === 'bare-adddir' || scenario === 'bare-adddir-closed') {
    // --bare with projectSettings opened and one add-dir. The binary's
    // loader, in bare mode, reads only each add-dir's .claude/skills, and
    // only when projectSettings is on (Wr("skills", {explicitlyRequested})).
    const dirs = declaredDirs();
    const wrap = join(root, 'wrap');
    mkdirSync(join(wrap, '.claude'), { recursive: true });
    symlinkSync(dirs.A, join(wrap, '.claude', 'skills'));
    const emptyRoot = join(root, 'empty-project-root');
    mkdirSync(emptyRoot, { recursive: true });
    const run = startRun({
      name,
      options: {
        model,
        debugFile: inst.debugFile,
        env: { ...inst.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' },
        // bare-adddir-closed leaves the harness's settingSources [] alone.
        extraArgs: scenario === 'bare-adddir' ? { 'setting-sources': 'project', bare: null } : { bare: null },
        additionalDirectories: [wrap],
        projectConfigRoot: emptyRoot,
      },
    });
    log(`run dir: ${run.dir}\nadd-dir wrapper: ${wrap}`);
    await turn(run, 'T1 initial listing', OK);
    await reloadSkills(run, 'bare');
    await hooksAndRules(run, 'bare');
    await finish(run, inst.bodiesDir, { declaredDirHook: dirs.hookRanDecl, pluginShapedEntryHook: dirs.hookRanPluginShaped });
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
