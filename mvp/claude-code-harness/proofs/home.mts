// Proof 26: keep Claude Code's own machinery out of the user's home, and how.
//
// Stephen, 28 Sep: "it's basically comparing, do we try to prevent the
// unwanted $HOME machinery, or override $HOME and then try to fix the things
// that we *do* want to inherit the users $HOME"; "its not about preventing
// claude himself from snooping in my $HOME / but the SDK does things that are
// potentially unwanted".
//
// Each option runs proof 22's pair (a fresh serve, then a resume of it
// through a session store), with proof 22's spawn hook linking the declared
// skills into whatever CLAUDE_CONFIG_DIR the SDK gives it, and the `user`
// source opened the way proof 22 did (extraArgs {'setting-sources': 'user'};
// run.json still records []), unless the option says closed.
//
// Per serve: a no-tool turn, then an idle wait so the housekeeping has time
// to run (proof 22 saw none in serves under about 7 s), then the tool turns:
// a plain-named skill, one Bash command of probes, Read and Write of a probe
// path under `~`, the MCP probe server's tool. The trace (strace, outside
// this process) is read by proofs/home-trace.mts with this run's phases.json.
//
//   node proofs/home.mts <model> <option>
//
// Options: see OPTIONS below. The harness is used as it is: HOME goes in
// through options.env; anything the harness sets itself
// (CLAUDE_SECURESTORAGE_CONFIG_DIR) is changed in the spawn hook, which is
// proof code, not harness code.
//
// Fixtures are kept, never deleted: ~/.local/state/tower-claude-code-harness/
// p26/<stamp>-<option>/ (declared skills, the private HOME if any, the store,
// logs). Outputs: runs/<stamp>-p26-<option>/.

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SDKMessage, SDKUserMessage, SessionKey, SessionStore, SessionStoreEntry, SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { type HarnessOptions, startRun } from '../src/harness.mts';
import { redact, stamp } from '../src/record.mts';

const REAL_HOME = homedir();
// A repo for the git identity probe: this worktree.
const REPO = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '');
const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, '..');
const STATE_ROOT = join(REAL_HOME, '.local', 'state', 'tower-claude-code-harness');

// ---------------------------------------------------------------------------
// The options.

interface Opt {
  what: string;
  // Open the `user` setting source (proof 22's way).
  userOpen: boolean;
  // A private HOME for Claude Code (FIX/home), or the real one.
  privateHome: boolean;
  // CLAUDE_SECURESTORAGE_CONFIG_DIR as the spawn hook leaves it: the
  // harness's "" (unchanged), or an absolute path to the real ~/.claude.
  secure: 'harness-empty' | 'absolute-real';
  // CLAUDE_CODE_SHELL_PREFIX pointing at proofs/home-shell-prefix.sh, which
  // runs each command with HOME set back to the real home.
  shellPrefix: boolean;
  // In the private HOME, symlinks to these real dotfiles (relative to home).
  dotLinks: string[];
  // Extra env for Claude Code (switches under test).
  env: Record<string, string>;
  // Extra flag settings (switches under test).
  settings: Record<string, unknown>;
  // bwrap mount masks: each real path gets a fixture dir mounted over it.
  masks: string[];
  // bwrap read-only binds of real paths onto themselves: the test's own
  // guard, so a delete or write the housekeeping attempts there fails with
  // EROFS (and shows in the trace) instead of changing Stephen's files.
  guards: string[];
  // The MCP server's own env in its config (to put the real HOME back).
  mcpHome: 'inherit' | 'real';
}

const base: Opt = { what: '', userOpen: true, privateHome: false, secure: 'harness-empty', shellPrefix: false, dotLinks: [], env: {}, settings: {}, masks: [], guards: [], mcpHome: 'inherit' };

// What the real-HOME runs with the user source open guard: the paths proof 22
// and this proof's reference run saw Claude Code list, prune or read for
// cleanup. ~/.claude itself is not guarded: the login's credentials file and
// its refresh lock live there, and a refresh that could not be written back
// would leave Stephen's stored refresh token stale.
const GUARDS = ['.claude/bridge-spawn', '.claude/state', '.claude.json', '.cache/claude', '.cache/claude-cli-nodejs', '.local/share/claude', '.local/state/claude'].map((r) => join(REAL_HOME, r));
// What the mask option mounts private directories over.
const MASKS = ['.claude/bridge-spawn', '.claude/state', '.cache/claude', '.cache/claude-cli-nodejs', '.local/share/claude', '.local/state/claude'].map((r) => join(REAL_HOME, r));

// TODO: undecided (Stephen). Which dotfiles a private HOME links back is a
// decision; the list below is the brief's examples and nothing more.
const DOTFILES = ['.gitconfig', '.config/gh', '.ssh', '.npmrc'];

const OPTIONS: Record<string, Opt> = {
  'real-closed': { ...base, what: 'reference: the harness baseline, real HOME, user source closed', userOpen: false },
  'real-open': { ...base, what: 'option 1 baseline: real HOME, user source open, nothing switched off (guarded read-only)', guards: GUARDS },
  // Switches read from the 2.1.282 binary (proof 26's research): the updater
  // paths are gated by DISABLE_AUTOUPDATER and placed by XDG_*; the MCP log
  // cache is env-paths' XDG_CACHE_HOME; Claude Code's temp root is
  // CLAUDE_CODE_TMPDIR (documented); cc-socks is under XDG_RUNTIME_DIR
  // (inferred). {FIX} is this run's fixture dir.
  'real-open-env': { ...base, what: 'option 1, switches: real HOME, user source open, DISABLE_AUTOUPDATER, XDG_CACHE_HOME, XDG_STATE_HOME, XDG_DATA_HOME, CLAUDE_CODE_TMPDIR, XDG_RUNTIME_DIR moved to private dirs (guarded read-only)', guards: GUARDS, env: { DISABLE_AUTOUPDATER: '1', XDG_CACHE_HOME: '{FIX}/xdg/cache', XDG_STATE_HOME: '{FIX}/xdg/state', XDG_DATA_HOME: '{FIX}/xdg/data', CLAUDE_CODE_TMPDIR: '{FIX}/xdg/tmp', XDG_RUNTIME_DIR: '{FIX}/xdg/runtime' } },
  // cleanupPeriodDays 0 makes the settings-driven cutoff null (binary); the
  // docs say 0 fails validation. Passed as a flag setting.
  'real-open-cleanup0': { ...base, what: 'option 1, switch: real HOME, user source open, cleanupPeriodDays 0 as a flag setting (guarded read-only)', guards: GUARDS, settings: { cleanupPeriodDays: 0 } },
  'real-open-all': { ...base, what: 'option 1, every switch found: real-open-env plus cleanupPeriodDays 0 (guarded read-only)', guards: GUARDS, env: { DISABLE_AUTOUPDATER: '1', XDG_CACHE_HOME: '{FIX}/xdg/cache', XDG_STATE_HOME: '{FIX}/xdg/state', XDG_DATA_HOME: '{FIX}/xdg/data', CLAUDE_CODE_TMPDIR: '{FIX}/xdg/tmp', XDG_RUNTIME_DIR: '{FIX}/xdg/runtime' }, settings: { cleanupPeriodDays: 0 } },
  'real-open-mask': { ...base, what: 'option 1, avoid: real HOME, user source open, private directories mounted (bwrap) over the housekeeping paths', guards: GUARDS, masks: MASKS },
  'private-bare': { ...base, what: 'option 2: private HOME, login by absolute CLAUDE_SECURESTORAGE_CONFIG_DIR, nothing put back for commands', privateHome: true, secure: 'absolute-real' },
  'private-empty-secure': { ...base, what: 'option 2 control: private HOME with the harness\'s empty CLAUDE_SECURESTORAGE_CONFIG_DIR (login expected to be missing)', privateHome: true },
  'private-prefix': { ...base, what: 'option 2: private HOME, absolute secure storage, CLAUDE_CODE_SHELL_PREFIX restores HOME for commands, MCP config env restores HOME', privateHome: true, secure: 'absolute-real', shellPrefix: true, mcpHome: 'real' },
  'private-prefix-only': { ...base, what: 'option 2: private HOME, absolute secure storage, CLAUDE_CODE_SHELL_PREFIX only (the MCP config leaves HOME alone)', privateHome: true, secure: 'absolute-real', shellPrefix: true },
  'private-full': { ...base, what: 'option 2: private-prefix-only plus CLAUDE_CODE_TMPDIR and XDG_RUNTIME_DIR moved to private dirs (HOME does not move them)', privateHome: true, secure: 'absolute-real', shellPrefix: true, env: { CLAUDE_CODE_TMPDIR: '{FIX}/xdg/tmp', XDG_RUNTIME_DIR: '{FIX}/xdg/runtime' } },
  'private-links': { ...base, what: 'option 2: private HOME, absolute secure storage, symlinks to real dotfiles in the private HOME', privateHome: true, secure: 'absolute-real', dotLinks: DOTFILES },
};

const [model, optName] = process.argv.slice(2);
const opt = optName ? OPTIONS[optName] : undefined;
if (!model || !optName || !opt) {
  process.stderr.write(`usage: node proofs/home.mts <model> <option>\n${Object.entries(OPTIONS)
    .map(([k, v]) => `  ${k.padEnd(24)} ${v.what}`)
    .join('\n')}\n`);
  process.exit(2);
}

const AGENT = `p26-${optName}`;
const START = stamp().replace(/[:.]/g, '');
const FIX = join(STATE_ROOT, 'p26', `${START}-${optName}`);
const OUT = join(PACKAGE_ROOT, 'runs', `${START}-p26-${optName}`);
// TODO: undecided (Stephen). A private HOME's lifetime and place: built here
// fresh per proof run and kept (easiest, and no rm). A participant could
// instead keep one per agent and reuse it, like CLAUDE_CONFIG_DIR.
const HOME_DIR = join(FIX, 'home');
const PROBE_REL = join('.local', 'state', 'tower-claude-code-harness', 'p26-probe');
const IDLE_MS = 30_000;
const OK = "Reply with the single word OK. Don't use any tools.";
mkdirSync(FIX, { recursive: true });
mkdirSync(OUT, { recursive: true });

const summary: Record<string, unknown> = { option: optName, opt, agent: AGENT, fixtures: FIX, out: OUT, model, serves: [] as unknown[] };
const phases: { name: string; at: number; iso: string }[] = [];

function log(line: string): void {
  const l = `${stamp()} ${line}\n`;
  process.stdout.write(l);
  appendFileSync(join(OUT, 'proof-stdout.txt'), redact(l).text);
}
function phase(name: string): void {
  phases.push({ name, at: Date.now() / 1000, iso: stamp() });
  writeFileSync(join(OUT, 'phases.json'), `${JSON.stringify(phases, null, 2)}\n`);
  log(`--- phase ${name}`);
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Fixtures.

function skillMd(name: string, marker: string): string {
  return `---\nname: ${name}\ndescription: Dummy skill for tower proof 26. MARKER=${marker}\n---\n\nP26-BODY-${name}. When invoked, reply with the single word DONE-${name}. Don't use any tools.\n`;
}

// Old entries where the housekeeping prunes, planted in a directory the run
// owns (the private HOME, or a mask): gone afterwards means the cleanup ran
// and landed there. Never planted in the real home.
function plantOld(root: string): string[] {
  const old = new Date(Date.now() - 3 * 24 * 3600 * 1000);
  const planted = [join(root, '.claude', 'bridge-spawn', 'p26-old-entry'), join(root, '.claude', 'state', 'served-calls', 'p26-old.jsonl'), join(root, '.claude', 'state', 'settings-review.json')];
  for (const p of planted) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, p.endsWith('.json') ? '{}\n' : 'p26\n');
    utimesSync(p, old, old);
  }
  return planted;
}

function probeFiles(): void {
  // The same relative path in both homes, with different markers; which one
  // the Read tool returns says which home `~` meant. The real one sits in the
  // harness's own state folder.
  for (const [root, marker] of [
    [REAL_HOME, 'P26-REAL-HOME'],
    [HOME_DIR, 'P26-PRIVATE-HOME'],
  ] as const) {
    if (root === HOME_DIR && !opt?.privateHome) continue;
    mkdirSync(join(root, PROBE_REL), { recursive: true });
    writeFileSync(join(root, PROBE_REL, 'which.txt'), `${marker}\n`);
  }
}

// The agent dir's settings.json (read with the user source open): a hook
// that logs the HOME it ran with.
const HOOK_LOG = join(FIX, 'hook.log');
function agentSettings(configDir: string): void {
  writeFileSync(join(configDir, 'settings.json'), `${JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `echo "cfg=$CLAUDE_CONFIG_DIR HOME=$HOME" >> ${HOOK_LOG}` }] }] } }, null, 2)}\n`);
}

function privateHome(): void {
  mkdirSync(HOME_DIR, { recursive: true });
  for (const rel of opt?.dotLinks ?? []) {
    const p = join(HOME_DIR, rel);
    mkdirSync(dirname(p), { recursive: true });
    symlinkSync(join(REAL_HOME, rel), p);
    log(`private HOME link ${p} -> ${join(REAL_HOME, rel)}`);
  }
}

// ---------------------------------------------------------------------------
// Skills links (proof 22's per-dir mode with the SKILL.md filter).

const DECLARED = join(FIX, 'declared');
function linkSkills(configDir: string, why: string): void {
  const skills = join(configDir, 'skills');
  mkdirSync(skills, { recursive: true });
  const made: string[] = [];
  for (const name of readdirSync(DECLARED)) {
    if (!existsSync(join(DECLARED, name, 'SKILL.md'))) continue;
    const p = join(skills, name);
    if (!isLink(p)) {
      symlinkSync(join(DECLARED, name), p);
      made.push(name);
    }
  }
  log(`  links [${why}] ${skills}: +${JSON.stringify(made)}`);
}
function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The spawn hook: link skills, apply the option's env, and start what the SDK
// would have started (the harness's capture wrapper), inside bwrap when the
// option masks paths.

const spawns: unknown[] = [];
function spawnHook(tag: string): (o: SpawnOptions) => SpawnedProcess {
  return (o: SpawnOptions): SpawnedProcess => {
    const configDir = String(o.env.CLAUDE_CONFIG_DIR);
    linkSkills(configDir, `spawn ${tag}`);
    const env = { ...o.env };
    if (opt?.secure === 'absolute-real') env.CLAUDE_SECURESTORAGE_CONFIG_DIR = join(REAL_HOME, '.claude');
    let command = o.command;
    let args = o.args;
    if (opt && (opt.masks.length > 0 || opt.guards.length > 0)) {
      const b = ['--dev-bind', '/', '/'];
      for (const real of opt.guards) b.push('--ro-bind-try', real, real);
      for (const real of opt.masks) b.push('--bind', maskDir(real), real);
      args = [...b, '--', command, ...args];
      command = 'bwrap';
    }
    const record = {
      tag,
      at: stamp(),
      configDir,
      command,
      args: args.filter((a) => !a.startsWith('{')).slice(0, 60),
      env: {
        HOME: env.HOME,
        CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR,
        CLAUDE_SECURESTORAGE_CONFIG_DIR: env.CLAUDE_SECURESTORAGE_CONFIG_DIR,
        CLAUDE_CODE_SHELL_PREFIX: env.CLAUDE_CODE_SHELL_PREFIX,
        ...Object.fromEntries(Object.keys(opt?.env ?? {}).map((k) => [k, env[k]])),
        XDG: Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('XDG_'))),
        TMPDIR: env.TMPDIR,
      },
    };
    spawns.push(record);
    log(`spawn hook [${tag}]: ${JSON.stringify(record)}`);
    const child: ChildProcess = spawn(command, args, { cwd: o.cwd, env: env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'], signal: o.signal });
    child.stderr?.on('data', (d: Buffer) => appendFileSync(join(OUT, `spawn-${tag}-stderr.txt`), redact(d.toString()).text));
    return child as unknown as SpawnedProcess;
  };
}
function maskDir(real: string): string {
  return join(FIX, 'masks', relative(REAL_HOME, real));
}

// ---------------------------------------------------------------------------
// The store (proof 22's file store).

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
// A serve.

type Run = ReturnType<typeof startRun>;
interface Serve {
  tag: string;
  run: Run;
  bodies: string;
  startedAt: string;
  sessionId: Promise<string>;
  waiters: ((m: SDKMessage) => boolean)[];
  answers: Record<string, string>;
  resumeDirs: string[];
}

const MCP_LOG = join(FIX, 'mcp.log');
const PREFIX = join(HERE, 'home-shell-prefix.sh');

function startServe(tag: string, resume?: string): Serve {
  if (!opt) throw new Error('no option');
  const bodies = join(FIX, 'bodies', tag);
  mkdirSync(bodies, { recursive: true });
  const optEnv = Object.fromEntries(Object.entries(opt.env).map(([k, v]) => [k, v.replace('{FIX}', FIX)]));
  for (const v of Object.values(optEnv)) if (v.startsWith(FIX)) mkdirSync(v, { recursive: true, mode: 0o700 });
  const env: Record<string, string | undefined> = { ...process.env, OTEL_LOG_RAW_API_BODIES: `file:${bodies}`, P26_TAG: tag, ...optEnv };
  if (opt.privateHome) env.HOME = HOME_DIR;
  if (opt.shellPrefix) {
    env.CLAUDE_CODE_SHELL_PREFIX = PREFIX;
    env.P26_REAL_HOME = REAL_HOME;
    env.P26_PREFIX_LOG = join(FIX, 'prefix.log');
  }
  const options: HarnessOptions = {
    model: model as string,
    debugFile: join(bodies, 'debug.log'),
    env,
    ...(opt.userOpen ? { extraArgs: { 'setting-sources': 'user' } } : {}),
    settings: { syncClaudeAiSkills: false, ...opt.settings } as HarnessOptions['settings'],
    sessionStore: store,
    sessionStoreFlush: 'eager',
    spawnClaudeCodeProcess: spawnHook(tag),
    mcpServers: {
      'p26-home': {
        type: 'stdio',
        command: process.execPath,
        args: [join(HERE, 'home-mcp.mjs'), MCP_LOG],
        env: { P26_TAG: tag, P26_REPO: REPO, ...(opt.mcpHome === 'real' ? { HOME: REAL_HOME } : {}) },
      },
    },
    canUseTool: async (toolName, input) => {
      log(`  canUseTool [${tag}] ${toolName} ${JSON.stringify(input).slice(0, 300)}`);
      return { behavior: 'allow', updatedInput: input };
    },
    ...(resume ? { resume } : {}),
  };
  const run = startRun({ name: AGENT, options });
  let sidR: (s: string) => void = () => {};
  const sessionId = new Promise<string>((r) => {
    sidR = r;
  });
  const s: Serve = { tag, run, bodies, startedAt: stamp(), sessionId, waiters: [], answers: {}, resumeDirs: [] };
  void (async () => {
    for await (const m of run.messages()) {
      if (m.type === 'system' && m.subtype === 'init') {
        sidR(m.session_id);
        log(`  [${tag} system/init] session ${m.session_id} skills=${JSON.stringify(m.skills.filter((n) => n.includes('p26')))} mcp=${JSON.stringify(m.mcp_servers)} apiKeySource=${JSON.stringify((m as { apiKeySource?: string }).apiKeySource)}`);
      }
      s.waiters = s.waiters.filter((w) => !w(m));
    }
  })();
  log(`serve ${tag}: run ${run.dir}${resume ? `, resuming ${resume} through the store` : ', new conversation'}`);
  return s;
}

function turn(s: Serve, what: string, prompt: string): Promise<string> {
  phase(`${s.tag}:${what}`);
  log(`>>> ${s.tag} ${what}: ${JSON.stringify(prompt.slice(0, 200))}`);
  let text = '';
  const tools: string[] = [];
  return new Promise<string>((resolve) => {
    s.waiters.push((m) => {
      if (m.type === 'assistant') {
        for (const b of m.message.content) {
          if (b.type === 'text') text += b.text;
          if (b.type === 'tool_use') tools.push(b.name);
        }
        return false;
      }
      if (m.type === 'user' && Array.isArray(m.message.content)) {
        for (const b of m.message.content as { type: string; content?: unknown }[]) {
          if (b.type === 'tool_result') log(`  [${s.tag} ${what}] tool_result ${redact(JSON.stringify(b.content)).text.slice(0, 1500)}`);
        }
        return false;
      }
      if (m.type === 'result') {
        log(`<<< ${s.tag} ${what}: result ${m.subtype}${m.subtype === 'success' ? '' : ` ${JSON.stringify((m as { errors?: unknown }).errors)}`} tools ${JSON.stringify(tools)} answer ${JSON.stringify(text.slice(0, 1500))}`);
        s.answers[what] = text;
        resolve(text);
        return true;
      }
      return false;
    });
    const msg: SDKUserMessage = { type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null };
    s.run.send(msg);
  });
}

// The Bash probes. Nothing secret is printed: gh's exit status only, npm's
// userconfig path and whether that file exists, git's origin file and name.
const BASH_PROBE = [
  'echo "HOME=$HOME"',
  'echo "tilde=$(cd ~ && pwd)"',
  // Stephen's identity comes through include/includeIf for repo paths, so
  // it is asked inside a repo (this worktree, read only); origins only.
  `git -C ${REPO} config --show-origin --get-regexp '^(user\\.|includeif\\.|include\\.)' | cut -f1 | sort | uniq -c`,
  `git -C ${REPO} var GIT_AUTHOR_IDENT >/dev/null 2>&1; echo "git-ident-in-repo-exit=$?"`,
  'gh auth status >/dev/null 2>&1; echo "gh-auth-status-exit=$?"',
  'u=$(npm config get userconfig 2>/dev/null); echo "npm-userconfig=$u"; test -f "$u" && echo "npm-userconfig-exists=yes" || echo "npm-userconfig-exists=no"',
  'ssh -G github.com 2>/dev/null | grep -i "^identityfile" | head -3',
  'echo "PATH-has-fnm=$(echo "$PATH" | grep -c fnm)"; command -v node || echo "node: not found"',
  // What an option's switches leak into commands: path variables only.
  'env | grep -E "^(XDG_[A-Z_]+|CLAUDE_CODE_TMPDIR|TMPDIR|DISABLE_AUTOUPDATER)=" | sort',
].join('; ');

function bashTurn(s: Serve): Promise<string> {
  return turn(s, 'bash probe', `Run exactly this one command with the Bash tool, unchanged, then reply with its full output verbatim and nothing else:\n\n${BASH_PROBE}`);
}

async function toolTurns(s: Serve): Promise<void> {
  await turn(s, 'skill', '/p26-seed');
  await bashTurn(s);
  await turn(s, 'read probe', `Use the Read tool on the path ~/${PROBE_REL}/which.txt exactly as written (with the ~). Reply with the file's contents and nothing else.`);
  await turn(s, 'write probe', `Use the Write tool to create the file ~/${PROBE_REL}/written-${s.tag}.txt (exactly that path, with the ~) holding the single line P26-WRITTEN. Then reply with the absolute path the tool reported, and nothing else.`);
  await turn(s, 'mcp probe', 'Call the home_probe tool from the p26-home MCP server once, then reply with its result verbatim and nothing else.');
}

// Resume dirs are deleted when their Claude Code exits: list their top level
// by name (never reading .credentials.json) before ending.
function listResumeDirs(s: Serve): void {
  for (const n of readdirSync(tmpdir())) {
    if (!n.startsWith('claude-resume-')) continue;
    const d = join(tmpdir(), n);
    // Only this run's: the hook linked our skills into it.
    if (!existsSync(join(d, 'skills', 'p26-seed'))) continue;
    const top = readdirSync(d).sort();
    s.resumeDirs.push(d);
    log(`  [${s.tag}] resume dir ${d} top level ${JSON.stringify(top)}; .credentials.json ${top.includes('.credentials.json') ? 'PRESENT (not read)' : 'absent'}`);
  }
}

async function endServe(s: Serve): Promise<void> {
  listResumeDirs(s);
  phase(`${s.tag}:end`);
  s.run.end();
  try {
    await s.run.done;
  } catch (err) {
    log(`serve ${s.tag}: run.done rejected: ${err instanceof Error ? err.message : String(err)}`);
  }
  await sleep(2000);
  const to = join(OUT, 'bodies', s.tag);
  mkdirSync(to, { recursive: true });
  for (const e of existsSync(s.bodies) ? readdirSync(s.bodies) : []) writeFileSync(join(to, e), redact(readFileSync(join(s.bodies, e), 'utf8')).text);
  (summary.serves as unknown[]).push({ tag: s.tag, runDir: s.run.dir, sessionId: await s.sessionId, answers: s.answers, resumeDirs: s.resumeDirs });
  log(`serve ${s.tag}: ended; run dir ${s.run.dir}`);
}

// Every .credentials.json by name (never opened) under the run's own dirs.
function credentialCopies(): void {
  const found: string[] = [];
  const walk = (p: string, depth: number): void => {
    if (depth > 6 || !existsSync(p)) return;
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const full = join(p, e.name);
      if (e.name === '.credentials.json') found.push(full);
      else if (e.isDirectory() && !e.isSymbolicLink()) walk(full, depth + 1);
    }
  };
  walk(FIX, 0);
  walk(join(STATE_ROOT, 'config-dirs', AGENT), 0);
  log(`.credentials.json by name under the fixtures and the agent dir: ${JSON.stringify(found)}`);
  summary.credentialCopies = found;
}

function listTree(root: string): string[] {
  const out: string[] = [];
  const walk = (p: string): void => {
    if (!existsSync(p)) return;
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const full = join(p, e.name);
      if (e.name === '.credentials.json') out.push(`${relative(root, full)} (not read)`);
      else if (e.isSymbolicLink()) out.push(`${relative(root, full)} -> ${readlinkSync(full)}`);
      else if (e.isDirectory()) walk(full);
      else out.push(relative(root, full));
    }
  };
  walk(root);
  return out;
}

function reset(): void {
  const r = spawnSync('pnpm', ['--silent', 'reset-config-dir', AGENT], { cwd: PACKAGE_ROOT, encoding: 'utf8' });
  log(`pnpm reset-config-dir ${AGENT}: exit ${r.status} ${r.stdout.trim()} ${r.stderr.trim()}`);
  if (r.status !== 0) throw new Error('reset refused');
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!opt) return;
  log(`proof 26 ${optName}: ${opt.what}; agent ${AGENT}; fixtures ${FIX}; out ${OUT}`);
  log(`inherited env paths: ${JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(XDG_|TMPDIR$|CLAUDE_TMPDIR$|HOME$)/.test(k))))}`);
  reset();
  const agentDir = join(STATE_ROOT, 'config-dirs', AGENT);
  agentSettings(agentDir);
  mkdirSync(join(DECLARED, 'p26-seed'), { recursive: true });
  writeFileSync(join(DECLARED, 'p26-seed', 'SKILL.md'), skillMd('p26-seed', 'SEED'));
  if (opt.privateHome) {
    privateHome();
    summary.plantedPrivate = plantOld(HOME_DIR);
  }
  for (const real of opt.masks) {
    const m = maskDir(real);
    mkdirSync(m, { recursive: true });
  }
  if (opt.masks.length > 0) summary.plantedMasks = plantOld(join(FIX, 'masks'));
  probeFiles();
  summary.fixturesBefore = listTree(FIX);

  const s1 = startServe('fresh');
  await turn(s1, 'T1 no tools', OK);
  phase('fresh:idle');
  await sleep(IDLE_MS);
  await toolTurns(s1);
  const sid = await s1.sessionId;
  await endServe(s1);

  const s2 = startServe('resumed', sid);
  await turn(s2, 'T1 no tools', OK);
  phase('resumed:idle');
  await sleep(IDLE_MS);
  await turn(s2, 'skill', '/p26-seed');
  await bashTurn(s2);
  await endServe(s2);

  phase('after');
  summary.fixturesAfter = listTree(FIX);
  summary.spawns = spawns;
  const planted = [...((summary.plantedPrivate as string[]) ?? []), ...((summary.plantedMasks as string[]) ?? [])];
  for (const p of planted) log(`planted old entry ${p}: ${existsSync(p) ? 'still there' : 'DELETED'}`);
  log(`hook log: ${existsSync(HOOK_LOG) ? JSON.stringify(readFileSync(HOOK_LOG, 'utf8').trim().split('\n')) : 'absent'}`);
  log(`prefix log: ${existsSync(join(FIX, 'prefix.log')) ? JSON.stringify(readFileSync(join(FIX, 'prefix.log'), 'utf8').trim().split('\n')) : 'absent'}`);
  log(`mcp log: ${existsSync(MCP_LOG) ? JSON.stringify(readFileSync(MCP_LOG, 'utf8').trim().split('\n')) : 'absent'}`);
  for (const root of [REAL_HOME, HOME_DIR]) {
    const d = join(root, PROBE_REL);
    if (existsSync(d)) log(`probe dir ${d}: ${JSON.stringify(readdirSync(d))}`);
  }
  if (opt.privateHome) log(`private HOME after: ${JSON.stringify(listTree(HOME_DIR))}`);
  credentialCopies();
  if (existsSync(STORE_DIR)) cpSync(STORE_DIR, join(OUT, 'store'), { recursive: true });
}

try {
  await main();
} catch (err) {
  log(`FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exitCode = 1;
} finally {
  writeFileSync(join(OUT, 'summary.json'), `${redact(JSON.stringify(summary, null, 2)).text}\n`);
  log(`summary: ${join(OUT, 'summary.json')}`);
}
