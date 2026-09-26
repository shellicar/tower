// Proof 22: plain-named skills through the user level, fresh and resumed.
//
// The goal (Stephen, unchanged from proof 19): "to declare skills directories
// in config", without the plugin prefix ("thats ugly"): declared in config,
// plain names, live (set, repointed, new or edited skills picked up),
// process-level, only skills.
//
// Proof 19 found plain names come from <CLAUDE_CONFIG_DIR>/skills once the
// `user` setting source is open. Proof 17b found a Claude Code resumed through
// a session store runs with CLAUDE_CONFIG_DIR set to a fresh
// /tmp/claude-resume-<random>/ that the SDK builds (sdk.mjs 0.3.282, `GG`):
// the store's transcript, the agent dir's .claude.json and .config.json, and
// its settings.json with enabledPlugins, extraKnownMarketplaces,
// additionalMarketplaces and env.CLAUDE_CONFIG_DIR stripped (`zG`). No
// skills/, CLAUDE.md, rules/, agents/ or commands/. The SDK deletes that
// directory (`Kg`, rm recursive force) once its Claude Code exits.
//
// Opening the `user` source is done here, in the proof, never in the harness:
// extraArgs {'setting-sources': 'user'}. The SDK passes --setting-sources=
// (empty, the harness's []) and then this flag; the last one wins
// (claude/<n>/argv.json). run.json still records settingSources: [].
//
// Every scenario sets syncClaudeAiSkills: false through `settings` (proof 19:
// it stops Claude Code copying the account's claude.ai skills into
// <CLAUDE_CONFIG_DIR>/skills/synced).
//
// Ground truth is the transcript's skill_listing, never what the model says.
// A resumed Claude Code's transcript already holds the seed serve's listing,
// and removals are never announced (proof 19), so for a resumed serve the
// evidence is also: a skill added between the serves (it can only appear as
// a delta if the resumed process loaded it), a bare-name invocation of a
// seed skill (the transcript says whether it ran), the debug log's loader
// lines, and reloadSkills() at the very end (Claude Code's own list).
//
//   node proofs/skills-user-level.mts <model> <scenario> [variant]
//
// Scenarios (each uses its own agent name, reset first through
// `pnpm reset-config-dir`):
//   pair-nohook       seed serve (fresh), then a resume through the store, no
//                     spawn hook; the declared skills linked into the agent
//                     dir only (question 1)
//   pair-closed       pair-nohook with the user source left closed (the
//                     harness's []): the baseline for the file-access trace
//   pair-hook         the same, with a spawn hook that links the declared
//                     skills into whatever CLAUDE_CONFIG_DIR it is given
//                     (question 2)
//   live              one resumed and one fresh Claude Code running at once;
//                     declared skills set, added, edited, removed, repointed
//                     (question 3). variant: per-dir (the participant updates
//                     every config dir the hook linked into) or dir-link (a
//                     resume dir's skills/ is a link to the agent dir's
//                     skills/, and only the agent dir is updated)
//   link-shape        a pair over a declared dir holding a plain skill, a
//                     plugin-shaped folder with no SKILL.md and a skill folder
//                     that also has .claude-plugin/plugin.json (question 4a).
//                     variant: whole-dir, every-dir or skill-md
//
// Fixtures are kept, never deleted: ~/.local/state/tower-claude-code-harness/
// p22/<stamp>-<scenario>/ (declared dirs, hook-ran logs, the session store,
// debug logs and request bodies). Debug logs, request bodies, the store and
// the resumed transcripts are copied, redacted, into the scenario's own
// directory under runs/.

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SDKMessage, SDKUserMessage, SessionKey, SessionStore, SessionStoreEntry, SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { type HarnessOptions, startRun } from '../src/harness.mts';
import { redact, stamp } from '../src/record.mts';

const [model, scenario, variantArg] = process.argv.slice(2);
const SCENARIOS: Record<string, string[]> = {
  'pair-nohook': [''],
  'pair-closed': [''],
  'pair-hook': [''],
  live: ['per-dir', 'dir-link'],
  'link-shape': ['whole-dir', 'every-dir', 'skill-md'],
};
const variant = variantArg ?? '';
if (!model || !scenario || !(scenario in SCENARIOS) || !(SCENARIOS[scenario] ?? []).includes(variant)) {
  process.stderr.write(`usage: node proofs/skills-user-level.mts <model> <scenario> [variant]\n${Object.entries(SCENARIOS)
    .map(([s, v]) => `  ${s}${v[0] ? ` <${v.join('|')}>` : ''}`)
    .join('\n')}\n`);
  process.exit(2);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, '..');
const STATE_ROOT = join(homedir(), '.local', 'state', 'tower-claude-code-harness');
const label = `${scenario}${variant ? `-${variant}` : ''}`;
const AGENT = `p22-${label}`;
const START = stamp().replace(/[:.]/g, '');
const FIX = join(STATE_ROOT, 'p22', `${START}-${label}`);
const OUT = join(PACKAGE_ROOT, 'runs', `${START}-p22-${label}`);
mkdirSync(FIX, { recursive: true });
mkdirSync(OUT, { recursive: true });
const SETTLE_MS = 8000;
const OK = "Reply with the single word OK. Don't use any tools.";

const summary: Record<string, unknown> = { scenario, variant, agent: AGENT, fixtures: FIX, out: OUT, model, runs: [] as unknown[] };

function log(line: string): void {
  const l = `${stamp()} ${line}\n`;
  process.stdout.write(l);
  appendFileSync(join(OUT, 'proof-stdout.txt'), redact(l).text);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Fixtures

function skillMd(name: string, marker: string): string {
  return `---\nname: ${name}\ndescription: Dummy skill for tower proof 22. MARKER=${marker}\n---\n\nP22-BODY-${name}. When invoked, reply with the single word DONE-${name}. Don't use any tools.\n`;
}

function writeSkill(dir: string, name: string, marker: string): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'SKILL.md'), skillMd(name, marker));
}

// Things opening the user source might load from the agent's config dir.
// Each carries a marker searched for in the request bodies; the
// settings.json hook appends the CLAUDE_CONFIG_DIR of the Claude Code that
// ran it.
const HOOK_LOG_CFG = join(FIX, 'HOOK-RAN-config-dir-settings.log');
function configDirSentinels(configDir: string): void {
  mkdirSync(join(configDir, 'agents'), { recursive: true });
  writeFileSync(join(configDir, 'agents', 'p22-sentinel-agent-cfg.md'), '---\nname: p22-sentinel-agent-cfg\ndescription: P22-SENTINEL-AGENT-cfg\n---\n\nP22-SENTINEL-AGENT-BODY-cfg\n');
  mkdirSync(join(configDir, 'commands'), { recursive: true });
  writeFileSync(join(configDir, 'commands', 'p22-sentinel-cmd-cfg.md'), '---\ndescription: P22-SENTINEL-CMD-cfg\n---\n\nP22-SENTINEL-CMD-BODY-cfg\n');
  mkdirSync(join(configDir, 'rules'), { recursive: true });
  writeFileSync(join(configDir, 'rules', 'p22.md'), 'P22-SENTINEL-RULE-cfg\n');
  mkdirSync(join(configDir, 'output-styles'), { recursive: true });
  writeFileSync(join(configDir, 'output-styles', 'p22-style.md'), '---\nname: p22-style\ndescription: P22-SENTINEL-STYLE-cfg\n---\n\nP22-SENTINEL-STYLE-BODY-cfg\n');
  writeFileSync(join(configDir, 'CLAUDE.md'), 'P22-SENTINEL-CLAUDEMD-cfg\n');
  writeFileSync(
    join(configDir, 'settings.json'),
    `${JSON.stringify(
      {
        permissions: { allow: ['Bash(echo P22-SENTINEL-PERM-cfg)'] },
        hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `echo "cfg=$CLAUDE_CONFIG_DIR" >> ${HOOK_LOG_CFG}` }] }] },
      },
      null,
      2,
    )}\n`,
  );
}

// A declared dir for question 4a: a plain skill, a plugin-shaped folder with
// no SKILL.md at its root, and a skill folder that is also plugin-shaped.
// Their plugin hooks append which config dir ran them.
const HOOK_LOG_PLUGIN = join(FIX, 'HOOK-RAN-plugin.log');
function pluginShaped(dir: string, name: string, withSkillMd: boolean): void {
  const root = join(dir, name);
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), `${JSON.stringify({ name }, null, 2)}\n`);
  mkdirSync(join(root, 'hooks'), { recursive: true });
  writeFileSync(
    join(root, 'hooks', 'hooks.json'),
    `${JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `echo "${name} cfg=$CLAUDE_CONFIG_DIR" >> ${HOOK_LOG_PLUGIN}` }] }] } }, null, 2)}\n`,
  );
  writeFileSync(join(root, '.mcp.json'), `${JSON.stringify({ mcpServers: { [`${name}-mcp`]: { command: 'true' } } }, null, 2)}\n`);
  mkdirSync(join(root, 'agents'), { recursive: true });
  writeFileSync(join(root, 'agents', `${name}-agent.md`), `---\nname: ${name}-agent\ndescription: P22-SENTINEL-AGENT-${name}\n---\n\nbody\n`);
  writeSkill(join(root, 'skills'), `${name}-inner`, 'INNER');
  if (withSkillMd) {
    writeFileSync(join(root, 'SKILL.md'), skillMd(name, 'HYBRID'));
  }
}

// ---------------------------------------------------------------------------
// Links. How the participant keeps links in step with its config is
// undecided; what is below is the easiest thing that answers the questions.

type Filter = 'skill-md' | 'every-dir';

// TODO: undecided. Which entries of a declared dir get linked. `skill-md`
// links only folders with a SKILL.md at their root; `every-dir` links every
// directory. Neither keeps out a skill folder that also has
// .claude-plugin/plugin.json (the binary's H5e/e2t adopt any linked entry
// holding .claude-plugin); a third filter could skip those. Measured in
// link-shape.
function desiredLinks(declared: string[], filter: Filter): Map<string, string> {
  const want = new Map<string, string>();
  for (const d of declared) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (filter === 'skill-md' && !existsSync(join(d, e.name, 'SKILL.md'))) continue;
      // TODO: undecided. Two declared dirs with the same skill name: the
      // first declared wins here.
      if (!want.has(e.name)) want.set(e.name, join(d, e.name));
    }
  }
  return want;
}

// Makes <skillsDir> a real directory holding exactly the wanted per-skill
// links. Idempotent. Never touches an entry that is not a symlink (such as a
// synced/ folder Claude Code wrote itself); those are logged.
function syncLinks(skillsDir: string, want: Map<string, string>, why: string): void {
  if (existsSync(skillsDir) && lstatSync(skillsDir).isSymbolicLink()) {
    throw new Error(`${skillsDir} is a symlink, expected a directory`);
  }
  mkdirSync(skillsDir, { recursive: true });
  const changes: string[] = [];
  for (const e of readdirSync(skillsDir)) {
    const p = join(skillsDir, e);
    if (!lstatSync(p).isSymbolicLink()) {
      changes.push(`kept non-link ${e}`);
      continue;
    }
    if (want.get(e) !== readlinkSync(p)) {
      unlinkSync(p);
      changes.push(`-${e}`);
    }
  }
  for (const [name, target] of want) {
    const p = join(skillsDir, name);
    if (!existsSync(p) && !isLink(p)) {
      symlinkSync(target, p);
      changes.push(`+${name}`);
    }
  }
  log(`  links [${why}] ${skillsDir}: ${changes.length ? changes.join(' ') : 'no change'}`);
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function listSkillsDir(configDir: string): Record<string, string> {
  const d = join(configDir, 'skills');
  const out: Record<string, string> = {};
  if (!existsSync(d)) return { '(skills/)': 'absent' };
  if (isLink(d)) out['(skills/ itself)'] = `-> ${readlinkSync(d)}`;
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    out[e] = isLink(p) ? `-> ${readlinkSync(p)}` : lstatSync(p).isDirectory() ? 'dir' : 'file';
  }
  return out;
}

// ---------------------------------------------------------------------------
// The participant's link state. `declared` stands in for the participant's
// config. `mode` is how links reach a Claude Code:
//   agent-only  the agent dir only, by hand before a serve (no hook)
//   per-dir     a spawn hook links into whatever CLAUDE_CONFIG_DIR it is
//               given; a change is applied to every dir the hook has linked
//   dir-link    the agent dir gets per-skill links; a resume dir's skills/
//               is one link to the agent dir's skills/, so a change is
//               applied to the agent dir only
//   whole-dir   skills/ is one link to the single declared dir, in every
//               config dir the hook is given
//
// TODO: undecided. How the participant keeps links in step with its config
// (a registry of live config dirs, one indirection through the agent dir, a
// whole-dir link, or something else). The registry below is never pruned:
// a resume dir the SDK has deleted stays in it and is skipped when missing.
type Mode = 'agent-only' | 'per-dir' | 'dir-link' | 'whole-dir';

class Links {
  declared: string[] = [];
  readonly registry = new Set<string>();
  readonly agentDir: string;
  readonly mode: Mode;
  readonly filter: Filter;
  constructor(agentDir: string, mode: Mode, filter: Filter) {
    this.agentDir = agentDir;
    this.mode = mode;
    this.filter = filter;
  }

  // Link one config dir as the mode says.
  linkInto(configDir: string, why: string): void {
    const skills = join(configDir, 'skills');
    if (this.mode === 'whole-dir') {
      const target = this.declared[0];
      if (isLink(skills)) unlinkSync(skills);
      if (target) {
        symlinkSync(target, skills);
        log(`  links [${why}] ${skills} -> ${target}`);
      } else {
        log(`  links [${why}] ${skills}: nothing declared, no link`);
      }
      return;
    }
    if (this.mode === 'dir-link' && configDir !== this.agentDir) {
      if (!isLink(skills)) {
        symlinkSync(join(this.agentDir, 'skills'), skills);
        log(`  links [${why}] ${skills} -> ${join(this.agentDir, 'skills')}`);
      }
      return;
    }
    syncLinks(skills, desiredLinks(this.declared, this.filter), why);
  }

  // A change to the declared config, applied as the mode says.
  apply(why: string): void {
    if (this.mode === 'per-dir' || this.mode === 'whole-dir') {
      for (const d of this.registry) {
        if (existsSync(d)) this.linkInto(d, why);
        else log(`  links [${why}] ${d}: gone, skipped`);
      }
    } else {
      this.linkInto(this.agentDir, why);
    }
  }

  // spawnClaudeCodeProcess: link, then start what the SDK would have started
  // (the harness's capture wrapper), unchanged. CLAUDE_CONFIG_DIR is not
  // touched: the SDK warns that store mirror frames are dropped if it
  // differs from the one the SDK set.
  spawnHook(tag: string, spawns: { tag: string; configDir: string; at: string; skillsDir: Record<string, string> }[]): (o: SpawnOptions) => SpawnedProcess {
    return (o: SpawnOptions): SpawnedProcess => {
      const configDir = String(o.env.CLAUDE_CONFIG_DIR);
      log(`spawn hook [${tag}]: CLAUDE_CONFIG_DIR given ${configDir}${configDir === this.agentDir ? ' (the agent dir)' : ''}`);
      this.registry.add(configDir);
      this.linkInto(configDir, `spawn ${tag}`);
      const skillsDir = listSkillsDir(configDir);
      log(`spawn hook [${tag}]: ${configDir}/skills now ${JSON.stringify(skillsDir)}`);
      spawns.push({ tag, configDir, at: stamp(), skillsDir });
      const child: ChildProcess = spawn(o.command, o.args, { cwd: o.cwd, env: o.env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'], signal: o.signal });
      // The capture wrapper records stderr itself; drain it here.
      child.stderr?.on('data', () => {});
      return child as unknown as SpawnedProcess;
    };
  }
}

// ---------------------------------------------------------------------------
// The store: one JSONL file per session key (proof 17b's file store, without
// its recorder).

const STORE_DIR = join(FIX, 'store');
function storeFile(key: SessionKey): string {
  return join(STORE_DIR, key.projectKey, `${key.sessionId}${key.subpath ? `/${key.subpath}` : ''}.jsonl`);
}
const store: SessionStore = {
  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    const f = storeFile(key);
    mkdirSync(dirname(f), { recursive: true });
    appendFileSync(f, entries.map((e) => `${JSON.stringify(e)}\n`).join(''));
  },
  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const f = storeFile(key);
    if (!existsSync(f)) return null;
    return readFileSync(f, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as SessionStoreEntry);
  },
};

// ---------------------------------------------------------------------------
// One serve: a harness run with the user source open, the store, the debug
// log and request bodies, and optionally the spawn hook.

type Run = ReturnType<typeof startRun>;
interface Serve {
  tag: string;
  run: Run;
  bodies: string;
  startedAt: string;
  sessionId: Promise<string>;
  messages: SDKMessage[];
  waiters: ((m: SDKMessage) => boolean)[];
  resumeCopies: string[];
  configDirs: string[];
}

const spawns: { tag: string; configDir: string; at: string; skillsDir: Record<string, string> }[] = [];

function startServe(tag: string, links: Links, hook: boolean, resume?: string): Serve {
  const bodies = join(FIX, 'bodies', tag);
  mkdirSync(bodies, { recursive: true });
  const options: HarnessOptions = {
    model: model as string,
    debugFile: join(bodies, 'debug.log'),
    env: { ...process.env, OTEL_LOG_RAW_API_BODIES: `file:${bodies}` },
    ...(scenario === 'pair-closed' ? {} : { extraArgs: { 'setting-sources': 'user' } }),
    settings: { syncClaudeAiSkills: false } as HarnessOptions['settings'],
    sessionStore: store,
    sessionStoreFlush: 'eager',
    ...(hook ? { spawnClaudeCodeProcess: links.spawnHook(tag, spawns) } : {}),
    ...(resume ? { resume } : {}),
  };
  const run = startRun({ name: AGENT, options });
  const startedAt = stamp();
  let sidR: (s: string) => void = () => {};
  const sessionId = new Promise<string>((r) => {
    sidR = r;
  });
  const s: Serve = { tag, run, bodies, startedAt, sessionId, messages: [], waiters: [], resumeCopies: [], configDirs: [] };
  void (async () => {
    for await (const m of run.messages()) {
      s.messages.push(m);
      if (m.type === 'system' && m.subtype === 'init') {
        sidR(m.session_id);
        log(`  [${tag} system/init] session ${m.session_id} skills=${JSON.stringify(m.skills.filter((n) => n.includes('p22')))} plugins=${JSON.stringify(m.plugins)} agents=${JSON.stringify(m.agents)} output_style=${JSON.stringify(m.output_style)}`);
      }
      s.waiters = s.waiters.filter((w) => !w(m));
    }
  })();
  log(`serve ${tag}: run ${run.dir}${resume ? `, resuming ${resume} through the store` : ', new conversation'}${hook ? ', spawn hook on' : ', no spawn hook'}`);
  return s;
}

function turn(s: Serve, what: string, prompt: string): Promise<void> {
  log(`>>> ${s.tag} ${what}: ${JSON.stringify(prompt.slice(0, 60))}`);
  let text = '';
  const done = new Promise<void>((resolve) => {
    s.waiters.push((m) => {
      if (m.type === 'assistant') {
        for (const b of m.message.content) if (b.type === 'text') text += b.text;
        return false;
      }
      if (m.type === 'result') {
        log(`<<< ${s.tag} ${what}: result ${m.subtype}, answer ${JSON.stringify(text.slice(0, 120))}`);
        resolve();
        return true;
      }
      return false;
    });
  });
  const msg: SDKUserMessage = { type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null };
  s.run.send(msg);
  return done;
}

async function reload(s: Serve): Promise<void> {
  try {
    const r = await s.run.query.reloadSkills();
    const names = r.skills.map((x) => x.name);
    log(`reloadSkills() [${s.tag}]: p22 names ${JSON.stringify(names.filter((n) => n.includes('p22')))} (of ${names.length})`);
    (summary[`reload-${s.tag}`] as unknown) = names;
  } catch (err) {
    log(`reloadSkills() [${s.tag}] threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}

type RawQuery = { request(req: Record<string, unknown>): Promise<unknown> };
async function hooksAndRules(s: Serve): Promise<void> {
  const q = s.run.query as unknown as RawQuery;
  const call = async (subtype: string): Promise<string> => {
    try {
      return JSON.stringify(await q.request({ subtype }));
    } catch (err) {
      return `threw ${err instanceof Error ? err.message : String(err)}`;
    }
  };
  log(`get_hooks_listing [${s.tag}]: ${(await call('get_hooks_listing')).slice(0, 2500)}`);
  log(`list_permission_rules [${s.tag}]: ${(await call('list_permission_rules')).slice(0, 1500)}`);
}

// Resume dirs are deleted when their Claude Code exits: copy only this
// session's transcript files (redacted) and a listing of skills/ before
// ending. Other resume dirs in the temp dir (other sessions on this machine)
// are only matched by file name, never copied.
async function copyResumeTranscripts(s: Serve): Promise<void> {
  const sid = await s.sessionId;
  for (const sp of spawns.filter((x) => x.tag === s.tag)) if (!s.configDirs.includes(sp.configDir)) s.configDirs.push(sp.configDir);
  for (const n of existsSync(join(s.run.dir, 'claude')) ? readdirSync(join(s.run.dir, 'claude')) : []) {
    try {
      const a = JSON.parse(readFileSync(join(s.run.dir, 'claude', n, 'argv.json'), 'utf8')) as { argv?: string[]; envNames?: string[] };
      log(`  [${s.tag}] claude/${n}/argv.json argv: ${JSON.stringify(a.argv)}`);
    } catch {
      // not written yet
    }
  }
  const candidates = new Set(s.configDirs.filter((d) => d !== s.run.configDir));
  for (const n of readdirSync(tmpdir())) if (n.startsWith('claude-resume-')) candidates.add(join(tmpdir(), n));
  for (const d of candidates) {
    const mine = findJsonl(join(d, 'projects'), sid);
    if (mine.length === 0) continue;
    for (const f of mine) {
      const to = join(OUT, 'resume-copies', s.tag, relative(d, f));
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, redact(readFileSync(f, 'utf8')).text);
      s.resumeCopies.push(to);
    }
    const listing = listSkillsDir(d);
    const top = readdirSync(d).sort();
    writeFileSync(join(OUT, 'resume-copies', s.tag, 'resume-dir.json'), `${JSON.stringify({ resumeDir: d, at: stamp(), topLevel: top, skills: listing }, null, 2)}\n`);
    log(`  [${s.tag}] copied ${mine.length} transcript(s) from resume dir ${d}; top level ${JSON.stringify(top)}; skills/ ${JSON.stringify(listing)}`);
    if (!s.configDirs.includes(d)) s.configDirs.push(d);
  }
}

async function endServe(s: Serve): Promise<void> {
  await copyResumeTranscripts(s);
  s.run.end();
  try {
    await s.run.done;
  } catch (err) {
    log(`serve ${s.tag}: run.done rejected: ${err instanceof Error ? err.message : String(err)}`);
  }
  // The SDK deletes the resume dir after its Claude Code exits.
  await sleep(2000);
  for (const d of s.configDirs.filter((x) => x !== s.run.configDir)) log(`serve ${s.tag}: resume dir ${d} ${existsSync(d) ? 'STILL EXISTS' : 'deleted by the SDK'}`);
  // Debug log and request bodies, redacted, into the scenario's dir.
  const to = join(OUT, 'bodies', s.tag);
  mkdirSync(to, { recursive: true });
  for (const e of existsSync(s.bodies) ? readdirSync(s.bodies) : []) {
    writeFileSync(join(to, e), redact(readFileSync(join(s.bodies, e), 'utf8')).text);
  }
  (summary.runs as unknown[]).push({ tag: s.tag, runDir: s.run.dir, sessionId: await s.sessionId, startedAt: s.startedAt, configDirs: s.configDirs, resumeCopies: s.resumeCopies });
  log(`serve ${s.tag}: ended; run dir ${s.run.dir}`);
}

// ---------------------------------------------------------------------------
// Scoring

function jsonlLines(file: string): Record<string, unknown>[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

function findJsonl(root: string, sid: string): string[] {
  const out: string[] = [];
  const walk = (p: string): void => {
    if (!existsSync(p)) return;
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const full = join(p, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name === `${sid}.jsonl`) out.push(full);
    }
  };
  walk(root);
  return out;
}

// What one serve's own transcript lines show: lines at or after the serve
// started (a resumed transcript also holds the earlier serves' lines).
async function score(s: Serve, markers: RegExp): Promise<void> {
  const sid = await s.sessionId;
  const files = [...findJsonl(join(s.run.dir, 'config-dir', 'projects'), sid), ...s.resumeCopies.filter((f) => f.endsWith(`${sid}.jsonl`))];
  const storeFiles = findJsonl(STORE_DIR, sid);
  log(`score ${s.tag}: session ${sid}; transcript files ${JSON.stringify(files)}; store ${JSON.stringify(storeFiles)}`);
  const since = s.startedAt;
  for (const [what, list] of [
    ['transcript', files],
    ['store', storeFiles],
  ] as const) {
    for (const f of list) {
      const lines = jsonlLines(f).filter((r) => typeof r.timestamp === 'string' && (r.timestamp as string) >= since.slice(0, 23));
      for (const r of lines) {
        const att = r.attachment as { type?: string; names?: string[]; isInitial?: boolean; content?: string; skillCount?: number } | undefined;
        if (att?.type === 'skill_listing') {
          const p22 = (att.names ?? []).filter((n) => n.includes('p22'));
          const mk = [...(att.content ?? '').matchAll(/MARKER=(\w+)/g)].map((m) => m[1]);
          log(`  [${s.tag} ${what}] ${r.timestamp} skill_listing isInitial=${att.isInitial === true} skillCount=${att.skillCount} p22=${JSON.stringify(p22)} markers=${JSON.stringify(mk)}`);
        }
      }
      if (what === 'transcript') {
        const text = lines.map((r) => JSON.stringify(r)).join('\n');
        const cmds = [...new Set([...text.matchAll(/<command-name>([^<]*)<\/command-name>/g)].map((m) => m[1]))];
        const dones = [...new Set([...text.matchAll(/DONE-p22-[\w-]+/g)].map((m) => m[0]))];
        const bodies = [...new Set([...text.matchAll(/P22-BODY-[\w-]+/g)].map((m) => m[0]))];
        const unknown = [...new Set([...text.matchAll(/(Unknown (?:skill|command)[^"\\]{0,60}|not installed[^"\\]{0,60})/g)].map((m) => m[0]))];
        const types = [...new Set(lines.map((r) => (r.attachment as { type?: string } | undefined)?.type).filter(Boolean))];
        log(`  [${s.tag} transcript] command-names ${JSON.stringify(cmds)}; skill bodies injected ${JSON.stringify(bodies)}; DONE replies ${JSON.stringify(dones)}; unknown/not-installed ${JSON.stringify(unknown)}; attachment types ${JSON.stringify(types)}`);
      }
    }
  }
  const bodiesOut = join(OUT, 'bodies', s.tag);
  const hits = new Map<string, Set<string>>();
  for (const e of existsSync(bodiesOut) ? readdirSync(bodiesOut) : []) {
    if (!e.endsWith('.request.json')) continue;
    const text = readFileSync(join(bodiesOut, e), 'utf8');
    for (const m of text.matchAll(markers)) {
      if (!hits.has(m[0])) hits.set(m[0], new Set());
      hits.get(m[0])?.add(e);
    }
  }
  log(`  [${s.tag} request bodies] markers: ${hits.size === 0 ? 'none' : JSON.stringify(Object.fromEntries([...hits].map(([k, v]) => [k, v.size])))}`);
  const dbg = join(bodiesOut, 'debug.log');
  if (existsSync(dbg)) {
    const wanted = /Loading skills from|Loaded \d+ unique skills|Watching for changes in skill|Detected skill change|skills-dir|directory-loaded plugins|skill-as-plugin|Skipping retention|setting.?sources|reload/i;
    for (const line of readFileSync(dbg, 'utf8').split('\n')) if (wanted.test(line)) log(`  [${s.tag} debug] ${line.slice(0, 300)}`);
  } else {
    log(`  [${s.tag}] no debug.log`);
  }
}

const SENTINELS = /P22-SENTINEL-[A-Z]+(?:-BODY)?-[\w-]+|P22-BODY-[\w-]+|MARKER=\w+/g;

function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (p: string): void => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const full = join(p, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out[relative(dir, full)] = createHash('sha256').update(readFileSync(full)).digest('hex').slice(0, 16);
    }
  };
  walk(dir);
  return out;
}

function hookLogs(): void {
  for (const f of [HOOK_LOG_CFG, HOOK_LOG_PLUGIN]) {
    log(`hook log ${f}: ${existsSync(f) ? JSON.stringify(readFileSync(f, 'utf8').trim().split('\n')) : 'absent (never ran)'}`);
  }
}

function reset(): void {
  const r = spawnSync('pnpm', ['--silent', 'reset-config-dir', AGENT], { cwd: PACKAGE_ROOT, encoding: 'utf8' });
  log(`pnpm reset-config-dir ${AGENT}: exit ${r.status} ${r.stdout.trim()} ${r.stderr.trim()}`);
  if (r.status !== 0) throw new Error('reset refused');
}

function agentDir(): string {
  return join(STATE_ROOT, 'config-dirs', AGENT);
}

// ---------------------------------------------------------------------------
// Scenarios

async function pair(mode: Mode, filter: Filter, hook: boolean, declaredSetup: (A: string) => void, extraInvoke: string[]): Promise<void> {
  reset();
  configDirSentinels(agentDir());
  const A = join(FIX, 'declared-a');
  mkdirSync(A, { recursive: true });
  writeSkill(A, 'p22-seed', 'SEED');
  declaredSetup(A);
  const before = hashTree(A);
  const links = new Links(agentDir(), mode, filter);
  links.declared = [A];
  if (!hook) links.linkInto(agentDir(), 'before the seed serve, by hand');

  // Serve 1: fresh.
  const s1 = startServe('fresh', links, hook);
  await turn(s1, 'T1', OK);
  await turn(s1, 'T2 bare-name invoke', '/p22-seed');
  for (const n of extraInvoke) await turn(s1, `invoke ${n}`, `/${n}`);
  await hooksAndRules(s1);
  const sid = await s1.sessionId;
  await endServe(s1);

  // Between serves: a new skill in the declared dir, linked as the mode says
  // (by hand into the agent dir when there is no hook; the hook does it at
  // spawn otherwise).
  writeSkill(A, 'p22-late', 'LATE');
  log('added p22-late to the declared dir between the serves');
  if (!hook) links.linkInto(agentDir(), 'between serves, by hand');

  // Serve 2: resumed through the store.
  const s2 = startServe('resumed', links, hook, sid);
  await turn(s2, 'T1', OK);
  await turn(s2, 'T2 bare-name invoke of the skill added between serves', '/p22-late');
  await turn(s2, 'T3 bare-name invoke of the seed skill', '/p22-seed');
  for (const n of extraInvoke) await turn(s2, `invoke ${n}`, `/${n}`);
  await hooksAndRules(s2);
  await reload(s2);
  await turn(s2, 'T4 after reloadSkills()', OK);
  await endServe(s2);

  const after = hashTree(A);
  const changed = Object.keys(before).filter((k) => before[k] !== after[k]);
  const added = Object.keys(after).filter((k) => !(k in before));
  log(`declared dir after both serves and the resume dir's deletion: ${Object.keys(before).length} original files, changed or missing ${JSON.stringify(changed)}, added ${JSON.stringify(added)}`);
  summary.declaredBefore = before;
  summary.declaredAfter = after;
  for (const s of [s1, s2]) await score(s, SENTINELS);
  hookLogs();
  log(`agent dir skills/ at the end: ${JSON.stringify(listSkillsDir(agentDir()))}`);
}

async function live(mode: 'per-dir' | 'dir-link'): Promise<void> {
  reset();
  configDirSentinels(agentDir());
  const A = join(FIX, 'declared-a');
  const B = join(FIX, 'declared-b');
  const S = join(FIX, 'declared-seed');
  writeSkill(S, 'p22-seed', 'SEED');
  writeSkill(A, 'p22-a1', 'V1');
  writeSkill(B, 'p22-b1', 'B');
  const links = new Links(agentDir(), mode, 'skill-md');

  // Seed conversation X with one skill, so X's second serve is a resume.
  links.declared = [S];
  const x1 = startServe('x-seed', links, true);
  await turn(x1, 'T1', OK);
  const sid = await x1.sessionId;
  await endServe(x1);

  // Nothing declared, then two Claude Codes at once: X resumed, Y fresh.
  links.declared = [];
  links.apply('declared set to nothing');
  const x2 = startServe('x-resumed', links, true, sid);
  const y1 = startServe('y-fresh', links, true);
  const both = async (what: string, prompt: string): Promise<void> => {
    await Promise.all([turn(x2, what, prompt), turn(y1, what, prompt)]);
  };
  await both('L0 nothing declared', OK);

  links.declared = [A];
  links.apply('set: declared A');
  await sleep(SETTLE_MS);
  await both('L1 after set', OK);

  writeSkill(A, 'p22-a2', 'NEW');
  links.apply('added p22-a2 to A');
  await sleep(SETTLE_MS);
  await both('L2 after add', OK);

  writeFileSync(join(A, 'p22-a1', 'SKILL.md'), skillMd('p22-a1', 'V2'));
  log('edited p22-a1 through its declared folder: MARKER=V1 -> V2');
  await sleep(SETTLE_MS);
  await both('L3 after edit', OK);

  // Removal: the participant's config drops p22-a2 (the folder stays on
  // disk; only its link goes).
  const keep = join(FIX, 'declared-a-without-a2');
  mkdirSync(keep, { recursive: true });
  symlinkSync(join(A, 'p22-a1'), join(keep, 'p22-a1'));
  links.declared = [keep];
  links.apply('removed p22-a2');
  await sleep(SETTLE_MS);
  await both('L4 after remove', OK);
  await both('L4b bare-name invoke of the removed skill', '/p22-a2');

  links.declared = [B];
  links.apply('repointed A -> B');
  await sleep(SETTLE_MS);
  await both('L5 after repoint', OK);
  await both('L5b bare-name invoke of a skill only in A', '/p22-a1');
  await both('L5c bare-name invoke of a skill only in B', '/p22-b1');

  await Promise.all([reload(x2), reload(y1)]);
  await both('L6 after reloadSkills()', OK);
  await Promise.all([endServe(x2), endServe(y1)]);
  for (const s of [x1, x2, y1]) await score(s, SENTINELS);
  hookLogs();
  log(`agent dir skills/ at the end: ${JSON.stringify(listSkillsDir(agentDir()))}`);
  log(`registry: ${JSON.stringify([...links.registry])}`);
}

async function linkShape(v: 'whole-dir' | 'every-dir' | 'skill-md'): Promise<void> {
  const mode: Mode = v === 'whole-dir' ? 'whole-dir' : 'per-dir';
  const filter: Filter = v === 'every-dir' ? 'every-dir' : 'skill-md';
  await pair(
    mode,
    filter,
    true,
    (A) => {
      pluginShaped(A, 'p22-shaped', false);
      pluginShaped(A, 'p22-hybrid', true);
    },
    ['p22-hybrid'],
  );
}

try {
  log(`proof 22 ${label}; agent ${AGENT}; fixtures ${FIX}; out ${OUT}`);
  if (scenario === 'pair-nohook' || scenario === 'pair-closed') await pair('agent-only', 'skill-md', false, () => {}, []);
  else if (scenario === 'pair-hook') await pair('per-dir', 'skill-md', true, () => {}, []);
  else if (scenario === 'live') await live(variant as 'per-dir' | 'dir-link');
  else if (scenario === 'link-shape') await linkShape(variant as 'whole-dir' | 'every-dir' | 'skill-md');
  summary.spawns = spawns;
  // The store, redacted, next to the rest.
  if (existsSync(STORE_DIR)) {
    cpSync(STORE_DIR, join(OUT, 'store'), { recursive: true });
    for (const f of findAll(join(OUT, 'store'))) writeFileSync(f, redact(readFileSync(f, 'utf8')).text);
  }
} catch (err) {
  log(`FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exitCode = 1;
} finally {
  writeFileSync(join(OUT, 'summary.json'), `${redact(JSON.stringify(summary, null, 2)).text}\n`);
  log(`summary: ${join(OUT, 'summary.json')}`);
}

function findAll(root: string): string[] {
  const out: string[] = [];
  const walk = (p: string): void => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const full = join(p, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(root);
  return out;
}
