// Cancel scenarios over the interactive CLI: one scenario per invocation.
//
//   node proofs/cancel-cli/run.mts <scenario> [--name <agent>] [--label <x>]
//   node proofs/cancel-cli/run.mts --list
//
// <agent> (default cancel-cli) names the config dir
// (~/.local/state/tower-claude-code-harness/config-dirs/<agent>/), the working
// dir (work/<agent>/) and the tmux socket. One agent runs one scenario at a
// time: --continue picks the latest session for the working dir.
//
// Each run writes runs/cancel-cli-<timestamp>-<scenario>/:
//   cancel-events.jsonl  driver actions, forwarder events (every request, SSE
//                        block starts/stops, client closes, faults), every
//                        transcript line as it lands (5 ms poll), screens
//   strace.txt           the tmux server and everything under it: signals
//                        received (with si_code/si_pid), kill() calls, exits
//   api-bodies/          Claude Code's own OTEL_LOG_RAW_API_BODIES log
//   debug-<n>.log        Claude Code's --debug-file, per launch
//   transcripts/         copies of the session transcripts after the run
//   report.txt           rendered by render.mts
//
// Harness choices (value-level, not Stephen's): the forwarder in the request
// path; --permission-mode default (the CLI's own default here is auto mode,
// which adds classifier calls); --allowedTools for the tool scenarios; the
// pane shell is `bash --noprofile --norc -i` with history off; --debug-file.
//
// Nothing here is participant code or a proposal for it.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Events, type Json, now, TranscriptWatch } from '../cancel/lib.mts';
import { type ClaudeProc, alive, descendants, type Fault, findClaude, Forwarder, type FwdReq, listJsonl, procStat, STATE_ROOT, sleep, Tmux, until } from './rig.mts';
import { render } from './render.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNS = join(HERE, '..', '..', 'runs');
const MODEL = 'claude-sonnet-5';

const WARM = 'Reply with the word READY only.';
const NEXT = 'Reply with the word NEXT only.';
const NO_TOOLS = 'Answer in your reply itself; do not use any tools.';
// The SDK runner's prompts (proofs/cancel/run.mts), with harder arithmetic:
// the CLI's sonnet-5 at its default effort answered the 1-to-300 one without
// thinking.
const P = {
  thinking: `Work out, carefully and step by step, how many integers from 1 to 5000 are divisible by 3, 5 or 7 but by neither 11 nor 13. Reply with the number only. ${NO_TOOLS}`,
  thinking2: `Work out, carefully and step by step, how many integers from 1 to 6000 are divisible by 4, 6 or 9 but by neither 7 nor 17. Reply with the number only. ${NO_TOOLS}`,
  text: `Write the numbers one to sixty in words, one per line, nothing else. ${NO_TOOLS}`,
  // Thinking, then a long reply: the plain text prompt never thought.
  thinkText: `Work out, carefully and step by step, how many integers from 1 to 5000 are divisible by 3, 5 or 7 but by neither 11 nor 13. Then write the numbers one to sixty in words, one per line. ${NO_TOOLS}`,
  // The outputs can't be guessed, so the model has to run them (with `echo
  // DONE` it once replied DONE without calling the tool).
  tool: 'Use the Bash tool to run this exact command, once: `sleep 20; date +%s%N`. Then reply with its output only.',
  // sleep and date run without asking even in default mode (read-only);
  // touch asks.
  perm: 'Use the Bash tool to run this exact command, once: `touch d3-probe.txt; date +%s%N`. Then reply with its output only.',
  // The CLI blocks `sleep 25; ...` as a tool_use_error ("Blocked: sleep 25
  // followed by ..."); sleep 20 runs.
  parallel: 'In one single message, make two Bash tool calls in parallel: `sleep 1; date +%s%N` and `sleep 18; date +%s%N`. Then reply with both outputs.',
  subagent: 'Use the Agent tool with subagent_type general-purpose, and ask it to run the Bash command `sleep 18; date +%s%N` and report the output. Then reply with what it reported.',
};
const TOOL_ALLOW = ['--allowedTools', 'Bash(sleep:*)', 'Bash(date:*)'];

class RecEvents extends Events {
  readonly mem: (Json & { src: string; kind: string; ms: number })[] = [];
  override write(src: string, kind: string, detail: Json = {}): void {
    super.write(src, kind, detail);
    this.mem.push({ ...detail, src, kind, ms: now() });
  }
}

interface Launch {
  n: number;
  pane: string;
  panePid: number;
  proc: ClaudeProc;
}

class Ctx {
  readonly name: string;
  readonly dir: string;
  readonly ev: RecEvents;
  readonly configDir: string;
  readonly cwd: string;
  readonly fwd: Forwarder;
  readonly tmux: Tmux;
  readonly tw: TranscriptWatch;
  launches = 0;
  constructor(name: string, dir: string) {
    this.name = name;
    this.dir = dir;
    mkdirSync(join(dir, 'raw'), { recursive: true });
    this.ev = new RecEvents(dir, join(dir, 'raw'));
    this.configDir = join(STATE_ROOT, 'config-dirs', name);
    this.cwd = join(STATE_ROOT, 'work', name);
    mkdirSync(this.configDir, { recursive: true });
    mkdirSync(this.cwd, { recursive: true });
    this.fwd = new Forwarder(process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com', this.ev);
    this.tmux = new Tmux(name, this.ev);
    this.tw = new TranscriptWatch(this.ev);
  }
  act(kind: string, detail: Json = {}): void {
    this.ev.write('drv', kind, detail);
  }
  // First interactive launch in a fresh config dir shows onboarding (theme,
  // login method) unless this is set; the login itself is the shared one.
  ensureOnboarded(): void {
    const p = join(this.configDir, '.claude.json');
    const j = existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Json) : {};
    if (j.hasCompletedOnboarding !== true) {
      j.hasCompletedOnboarding = true;
      if (j.theme === undefined) {
        j.theme = 'dark';
      }
      writeFileSync(p, JSON.stringify(j, null, 2));
      this.act('onboarding-flag-set');
    }
  }
  async start(): Promise<void> {
    this.ensureOnboarded();
    await this.fwd.start();
    mkdirSync(join(this.configDir, 'projects'), { recursive: true });
    this.tw.prime(join(this.configDir, 'projects'));
    this.tw.start();
    await this.tmux.start(join(this.dir, 'strace.txt'), this.cwd);
  }
  screen(l: Launch | { pane: string }, label: string): string {
    const s = this.tmux.capture(l.pane);
    const lines = s.split('\n').filter((x) => x.trim() !== '');
    this.ev.write('screen', label, { pane: l.pane, lines: lines.slice(-40) });
    return s;
  }
  async launch(args: string[], env: Record<string, string> = {}, waitReady = true): Promise<Launch> {
    this.launches += 1;
    const n = this.launches;
    const { pane, panePid } = this.tmux.window(`c${n}`, this.cwd);
    const envs = {
      CLAUDE_CONFIG_DIR: this.configDir,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: '',
      OTEL_LOG_RAW_API_BODIES: `file:${join(this.dir, 'api-bodies')}`,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${this.fwd.port}`,
      ...env,
    };
    const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
    const line = `${Object.entries(envs)
      .map(([k, v]) => `${k}=${q(v)}`)
      .join(' ')} claude --setting-sources '' --model ${MODEL} --permission-mode default --debug-file ${q(join(this.dir, `debug-${n}.log`))} ${args.map(q).join(' ')}\necho "CLAUDE_EXIT=$?"\n`;
    const script = join(this.dir, `launch-${n}.sh`);
    writeFileSync(script, line);
    await until('pane shell', () => /(pane|bash-[0-9.]+)\$ *$/m.test(this.tmux.capture(pane)), 5000, 20);
    this.act('launch', { n, pane, panePid, args, env: Object.keys(env), script: basename(script) });
    this.tmux.type(pane, `source ${script}`);
    this.tmux.key(pane, 'Enter');
    const proc = await until('claude process', () => findClaude(panePid), 10000, 2);
    this.act('claude-started', { n, ...proc, version: basename(proc.exe) });
    const l: Launch = { n, pane, panePid, proc };
    if (waitReady) {
      await this.ready(l);
    }
    return l;
  }
  async ready(l: Launch): Promise<void> {
    await until(
      'prompt ready',
      () => {
        const s = this.tmux.capture(l.pane);
        if (s.includes('Yes, I trust this folder')) {
          if (s.includes('❯ Yes')) {
            this.tmux.key(l.pane, 'Enter');
          } else {
            this.tmux.key(l.pane, 'Down');
          }
          return false;
        }
        return /\? for shortcuts|shift\+tab to cycle|for shortcuts/.test(s) || undefined;
      },
      30000,
      50,
    );
    await sleep(500);
    const st = procStat(l.proc.pid);
    this.act('ready', { n: l.n, pgrp: st?.pgrp, tpgid: st?.tpgid, session: st?.session });
    this.screen(l, `ready-${l.n}`);
  }
  mark(): number {
    return this.fwd.reqs.length;
  }
  mainAfter(base: number): FwdReq | undefined {
    return this.fwd.reqs.slice(base).find((r) => r.main);
  }
  lastMainAfter(base: number): FwdReq | undefined {
    return this.fwd.reqs
      .slice(base)
      .filter((r) => r.main)
      .at(-1);
  }
  // The text in the input box: from the last line starting `❯ ` to the rule
  // under it.
  input(l: Launch): string {
    const lines = this.tmux.capture(l.pane).split('\n');
    let at = -1;
    lines.forEach((x, i) => {
      if (/^❯(\s|\u00a0|$)/.test(x)) {
        at = i;
      }
    });
    if (at < 0) {
      return '';
    }
    const out: string[] = [lines[at].slice(2)];
    for (let i = at + 1; i < lines.length && !lines[i].startsWith('─'); i++) {
      out.push(lines[i]);
    }
    return out.join('\n').trim();
  }
  // After an Esc the CLI can put the interrupted prompt back in the input
  // box. That is recorded, then cleared, so the next message is only itself.
  async clearInput(l: Launch): Promise<void> {
    const before = this.input(l);
    // The empty box shows a placeholder hint.
    if (!before || /^Try "/.test(before)) {
      return;
    }
    this.act('input-prefilled', { n: l.n, text: before });
    this.tmux.key(l.pane, 'C-u');
    await sleep(200);
    for (let i = 0; i < 5 && this.input(l); i++) {
      this.tmux.key(l.pane, 'End');
      this.tmux.key(l.pane, '-N', String(this.input(l).length + 20), 'BSpace');
      await sleep(200);
    }
    this.act('input-cleared', { n: l.n, left: this.input(l) });
  }
  async say(l: Launch, text: string): Promise<{ base: number; evIdx: number }> {
    await this.clearInput(l);
    const base = this.mark();
    const evIdx = this.ev.mem.length;
    this.tmux.type(l.pane, text);
    await sleep(150);
    this.act('say', { n: l.n, text });
    this.tmux.key(l.pane, 'Enter');
    this.act('enter', { n: l.n });
    return { base, evIdx };
  }
  transcriptSince(evIdx: number): Json[] {
    return this.ev.mem
      .slice(evIdx)
      .filter((e) => e.src === 'transcript' && e.kind === 'line')
      .map((e) => e.entry as Json);
  }
  // A turn is over when Claude Code writes its turn_duration entry.
  async turnEnd(l: Launch, s: { evIdx: number }, timeoutMs = 120000): Promise<void> {
    await until('turn end', () => this.transcriptSince(s.evIdx).some((e) => e.type === 'system' && e.subtype === 'turn_duration') || !alive(l.proc) || undefined, timeoutMs, 20);
    await this.quiet(1500);
    this.act('turn-end', { n: l.n });
    this.screen(l, `turn-end-${l.n}`);
  }
  // No transcript line and no forwarder event for ms.
  async quiet(ms: number, timeoutMs = 60000): Promise<void> {
    await until(
      'quiet',
      () => {
        const last = this.ev.mem.filter((e) => e.src === 'transcript' || e.src === 'fwd').at(-1);
        return !last || now() - last.ms > ms || undefined;
      },
      timeoutMs,
      20,
    );
  }
  async thinking(base: number, afterMs = 700): Promise<FwdReq> {
    const r = await until('thinking block', () => {
      const m = this.mainAfter(base);
      return m?.blocks.some((b) => b?.type === 'thinking') ? m : undefined;
    }, 60000);
    await sleep(afterMs);
    const text = r.blocks.some((b) => b?.type === 'text' || b?.type === 'tool_use');
    this.act('at-thinking', { req: r.n, afterMs, laterBlockStarted: text, thinkingStopped: r.blocks.find((b) => b?.type === 'thinking')?.stopMs !== undefined });
    return r;
  }
  async midText(base: number, deltas = 15): Promise<FwdReq> {
    const r = await until('text deltas', () => {
      const m = this.lastMainAfter(base);
      return m?.blocks.some((b) => b?.type === 'text' && b.deltas >= deltas) ? m : undefined;
    }, 90000);
    this.act('at-mid-text', { req: r.n, blocks: r.blocks.map((b) => ({ type: b?.type, deltas: b?.deltas, stopped: b?.stopMs !== undefined })) });
    return r;
  }
  async toolRunning(l: Launch, comm = 'sleep', afterMs = 2000, count = 1): Promise<void> {
    await until(`${comm} running`, () => descendants(l.proc.pid).filter((p) => procStat(p)?.comm === comm).length >= count || undefined, 90000, 20);
    this.act('tool-running', { comm, pids: descendants(l.proc.pid).filter((p) => procStat(p)?.comm === comm) });
    await sleep(afterMs);
  }
  esc(l: Launch): void {
    this.act('esc', { n: l.n });
    this.tmux.key(l.pane, 'Escape');
  }
  signal(l: Launch, sig: NodeJS.Signals): void {
    if (!alive(l.proc)) {
      throw new Error(`claude ${l.proc.pid} is not the process started (or gone)`);
    }
    this.act('signal', { n: l.n, pid: l.proc.pid, sig });
    process.kill(l.proc.pid, sig);
  }
  killPane(l: Launch): void {
    this.act('kill-pane', { n: l.n, pane: l.pane, claudePid: l.proc.pid, panePid: l.panePid });
    this.tmux.t('kill-pane', '-t', l.pane);
  }
  async gone(l: Launch, timeoutMs = 15000): Promise<boolean> {
    try {
      await until('claude exit', () => !alive(l.proc) || undefined, timeoutMs, 2);
      this.act('claude-gone', { n: l.n, pid: l.proc.pid });
      return true;
    } catch {
      this.act('claude-still-alive', { n: l.n, pid: l.proc.pid, afterMs: timeoutMs });
      return false;
    }
  }
  async exit(l: Launch): Promise<void> {
    if (!alive(l.proc)) {
      return;
    }
    await this.quiet(1000);
    this.tmux.type(l.pane, '/exit');
    await sleep(300);
    this.act('exit-command', { n: l.n });
    this.tmux.key(l.pane, 'Enter');
    if (!(await this.gone(l, 20000))) {
      this.signal(l, 'SIGTERM');
      await this.gone(l, 10000);
    }
    await sleep(300);
    this.screen(l, `exited-${l.n}`);
  }
  sessionId(): string | undefined {
    const f = this.ev.mem.find((e) => e.src === 'transcript' && e.kind === 'file' && !String(e.file).includes('/subagents/'));
    return f ? basename(String(f.file), '.jsonl') : undefined;
  }
  setFault(f: Fault): void {
    this.act('fault-set', { kind: f.kind, times: f.times, status: f.kind === 'status' ? f.status : undefined });
    this.fwd.fault = f;
  }
  async finish(): Promise<void> {
    await this.quiet(1000, 10000).catch(() => {});
    this.tw.stop();
    await this.tmux.stop();
    await this.fwd.stop();
    const tdir = join(this.dir, 'transcripts');
    mkdirSync(tdir, { recursive: true });
    const projects = join(this.configDir, 'projects');
    const touched = new Set(this.ev.mem.filter((e) => e.src === 'transcript' && e.kind === 'file').map((e) => String(e.file)));
    for (const f of listJsonl(projects)) {
      const rel = relative(projects, f);
      if ([...touched].some((t) => rel.endsWith(t) || t.endsWith(rel) || rel === t)) {
        const out = join(tdir, rel.replace(/\//g, '__'));
        copyFileSync(f, out);
      }
    }
    this.act('finished');
  }
}

type Scenario = (c: Ctx) => Promise<void>;

async function warm(c: Ctx, l: Launch): Promise<void> {
  await c.turnEnd(l, await c.say(l, WARM));
}

async function next(c: Ctx, l: Launch, text = NEXT): Promise<void> {
  await c.turnEnd(l, await c.say(l, text));
}

async function resumeAndSend(c: Ctx, how: 'continue' | 'resume', opts: { idleMs?: number; tools?: boolean } = {}): Promise<Launch> {
  const sid = c.sessionId();
  const args = how === 'continue' ? ['--continue'] : ['--resume', sid ?? 'unknown'];
  const l = await c.launch(opts.tools ? [...args, ...TOOL_ALLOW] : args);
  c.act('resume-loaded', { how, sid });
  await c.quiet(opts.idleMs ?? 3000);
  c.screen(l, 'after-resume-idle');
  await next(c, l);
  await c.exit(l);
  return l;
}

type Stop = 'esc' | NodeJS.Signals | 'kill-pane';

async function stopWith(c: Ctx, l: Launch, how: Stop): Promise<boolean> {
  if (how === 'esc') {
    c.esc(l);
    // A key typed soon after Esc is read with it as one escape sequence
    // (Esc then `R` arrived as Alt-R once, and the Esc did nothing).
    await sleep(1500);
    await c.quiet(2000);
    c.screen(l, 'after-esc');
    return true;
  }
  if (how === 'kill-pane') {
    c.killPane(l);
  } else {
    c.signal(l, how);
  }
  const g = await c.gone(l, 8000);
  c.screen(l, 'after-kill');
  return g;
}

// After a kill: resume (continue or resume id) and send. After an Esc, or a
// signal the process survived: send in the same process.
async function afterStop(c: Ctx, l: Launch, how: Stop, resume: 'continue' | 'resume', tools = false): Promise<void> {
  if (how === 'esc' || alive(l.proc)) {
    if (how !== 'esc') {
      c.act('survived', { sig: how });
    }
    await next(c, l);
    await c.exit(l);
    return;
  }
  await resumeAndSend(c, resume, { tools });
}

const SIGS: Stop[] = ['SIGTERM', 'SIGHUP', 'SIGINT', 'SIGKILL', 'kill-pane'];

const SCENARIOS: Record<string, Scenario> = {};

// A: interrupt with Esc, then send again in the same process.
SCENARIOS['A-thinking'] = async (c) => {
  const l = await c.launch([]);
  await warm(c, l);
  const s = await c.say(l, P.thinking);
  await c.thinking(s.base);
  await stopWith(c, l, 'esc');
  await next(c, l);
  await c.exit(l);
};
SCENARIOS['A-text'] = async (c) => {
  const l = await c.launch([]);
  await warm(c, l);
  const s = await c.say(l, P.text);
  await c.midText(s.base);
  await stopWith(c, l, 'esc');
  await next(c, l);
  await c.exit(l);
};
SCENARIOS['A-tool'] = async (c) => {
  const l = await c.launch(TOOL_ALLOW);
  await warm(c, l);
  await c.say(l, P.tool);
  await c.toolRunning(l);
  await stopWith(c, l, 'esc');
  await next(c, l);
  await c.exit(l);
};

// B: kill during thinking, resume, send.
for (const how of SIGS) {
  for (const resume of ['continue', 'resume'] as const) {
    SCENARIOS[`B-${how}-${resume}`] = async (c) => {
      const l = await c.launch([]);
      await warm(c, l);
      const s = await c.say(l, P.thinking);
      await c.thinking(s.base);
      await stopWith(c, l, how);
      await afterStop(c, l, how, resume);
    };
  }
}

// C: kill during a tool run, and mid-reply.
for (const how of SIGS) {
  SCENARIOS[`C-tool-${how}`] = async (c) => {
    const l = await c.launch(TOOL_ALLOW);
    await warm(c, l);
    await c.say(l, P.tool);
    await c.toolRunning(l);
    await stopWith(c, l, how);
    await afterStop(c, l, how, 'continue', true);
  };
  SCENARIOS[`C-text-${how}`] = async (c) => {
    const l = await c.launch([]);
    await warm(c, l);
    const s = await c.say(l, P.text);
    await c.midText(s.base);
    await stopWith(c, l, how);
    await afterStop(c, l, how, 'continue');
  };
}

// D1: before the first byte: the forwarder holds the request.
for (const how of ['esc', 'SIGTERM'] as const) {
  SCENARIOS[`D1-${how}`] = async (c) => {
    const l = await c.launch([]);
    await warm(c, l);
    c.setFault({ kind: 'hold', times: 1 });
    const s = await c.say(l, P.thinking);
    await until('held request', () => c.mainAfter(s.base), 30000);
    await sleep(1000);
    await stopWith(c, l, how);
    c.fwd.releaseHeld();
    await afterStop(c, l, how, 'continue');
  };
}

// D2: while the model writes a tool call (after its tool_use block starts,
// before it stops). --effort low as the way to get a tool call without
// thinking before it, where the model obliges.
for (const how of ['esc', 'SIGTERM'] as const) {
  for (const effort of ['high', 'low'] as const) {
    SCENARIOS[`D2-${how}-${effort}`] = async (c) => {
      const l = await c.launch([...TOOL_ALLOW, '--effort', effort]);
      await warm(c, l);
      const s = await c.say(l, P.tool);
      const r = await until('tool_use block', () => {
        const m = c.lastMainAfter(s.base);
        return m?.blocks.some((b) => b?.type === 'tool_use' && b.deltas >= 1) ? m : undefined;
      }, 60000);
      c.act('at-tool-use-streaming', { req: r.n, blocks: r.blocks.map((b) => ({ type: b?.type, deltas: b?.deltas, stopped: b?.stopMs !== undefined })) });
      await stopWith(c, l, how);
      await afterStop(c, l, how, 'continue', true);
    };
  }
}

// D3: while the CLI's permission prompt is up (no allowedTools).
for (const how of ['esc', 'SIGTERM'] as const) {
  SCENARIOS[`D3-${how}`] = async (c) => {
    const l = await c.launch([]);
    await warm(c, l);
    await c.say(l, P.perm);
    await until('permission prompt', () => /Do you want|proceed\?|Yes, and don/.test(c.tmux.capture(l.pane)) || undefined, 60000, 50);
    c.screen(l, 'permission-prompt');
    await sleep(1000);
    await stopWith(c, l, how);
    await afterStop(c, l, how, 'continue');
  };
}

// D4: parallel tool calls, one finished and one still running.
for (const how of ['esc', 'SIGTERM'] as const) {
  SCENARIOS[`D4-${how}`] = async (c) => {
    const l = await c.launch(TOOL_ALLOW);
    await warm(c, l);
    const s = await c.say(l, P.parallel);
    await until('one tool_result written', () => c.transcriptSince(s.evIdx).some((e) => JSON.stringify(e.content ?? '').includes('tool_result')) || undefined, 90000, 20);
    await sleep(1000);
    c.act('at-parallel', { sleeps: descendants(l.proc.pid).filter((p) => procStat(p)?.comm === 'sleep') });
    await stopWith(c, l, how);
    await afterStop(c, l, how, 'continue', true);
  };
}

// D5: while a subagent runs its tool.
for (const how of ['esc', 'SIGTERM'] as const) {
  SCENARIOS[`D5-${how}`] = async (c) => {
    const l = await c.launch(TOOL_ALLOW);
    await warm(c, l);
    await c.say(l, P.subagent);
    await c.toolRunning(l, 'sleep', 3000);
    await stopWith(c, l, how);
    await afterStop(c, l, how, 'continue', true);
  };
}

// D6: after the reply, while a Stop hook runs (a --settings Stop hook that
// sleeps; --settings is flag settings, which --setting-sources '' leaves on).
const STOP_HOOK = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'sleep 20' }] }] } });
for (const how of ['esc', 'SIGTERM'] as const) {
  SCENARIOS[`D6-${how}`] = async (c) => {
    const l = await c.launch(['--settings', STOP_HOOK]);
    await warm(c, l).catch(() => {});
    const s = await c.say(l, NEXT.replace('NEXT', 'HOOKED'));
    await until('reply done', () => {
      const m = c.lastMainAfter(s.base);
      return m?.endMs !== undefined && m.stopReason === 'end_turn' ? m : undefined;
    }, 60000);
    await c.toolRunning(l, 'sleep', 2000);
    await stopWith(c, l, how);
    await afterStop(c, l, how, 'continue');
  };
}

// D8: a kill straight after Enter, before the prompt is written. SIGTERM
// leaves Claude Code time to write it anyway, so SIGKILL too.
for (const sig of ['SIGTERM', 'SIGKILL'] as const) {
  for (const delay of [0, 30]) {
    SCENARIOS[`D8-${sig === 'SIGTERM' ? '' : 'SIGKILL-'}${delay}ms`] = async (c) => {
      const l = await c.launch([]);
      await warm(c, l);
      await c.say(l, P.thinking);
      if (delay) {
        await sleep(delay);
      }
      await stopWith(c, l, sig);
      await afterStop(c, l, sig, 'continue');
    };
  }
}

// D9: a kill during a resume (before its prompt is ready), then resume again.
SCENARIOS.D9 = async (c) => {
  const l = await c.launch([]);
  await warm(c, l);
  const s = await c.say(l, P.thinking);
  await c.thinking(s.base);
  await stopWith(c, l, 'SIGTERM');
  const l2 = await c.launch(['--continue'], {}, false);
  await sleep(400);
  c.screen(l2, 'resume-starting');
  await stopWith(c, l2, 'SIGTERM');
  await resumeAndSend(c, 'continue');
};

// D10: during auto-compaction. CLAUDE_AUTOCOMPACT_PCT_OVERRIDE is read in
// 2.1.283 as a test override of the threshold (the binary names it
// testPctOverride); whether it makes compaction fire here is what's tried.
for (const how of ['esc', 'SIGTERM'] as const) {
  SCENARIOS[`D10-${how}`] = async (c) => {
    const l = await c.launch([], { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '1' });
    const s = await c.say(l, WARM);
    const r = await until('compaction request', () => c.fwd.reqs.slice(s.base).find((x) => /summar/i.test(x.lastUser ?? '')), 120000, 20);
    c.act('at-compaction', { req: r.n, lastUser: r.lastUser });
    await sleep(1500);
    await stopWith(c, l, how);
    await afterStop(c, l, how, 'continue');
  };
}

// D10, second route: the API's prompt-too-long error, injected by the
// forwarder, which is what the CLI's reactive compaction answers (its debug
// log: "autocompact: routing through reactive"). Two turns first, so there
// is something to compact.
const TOO_LONG: Fault = { kind: 'status', status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 215000 tokens > 200000 maximum' } }, times: 1 };
for (const how of ['esc', 'SIGTERM'] as const) {
  SCENARIOS[`D10r-${how}`] = async (c) => {
    const l = await c.launch([]);
    await warm(c, l);
    await c.turnEnd(l, await c.say(l, P.text));
    c.setFault({ ...TOO_LONG });
    const s = await c.say(l, NEXT.replace('NEXT', 'AFTER'));
    const r = await until('compaction request', () => c.fwd.reqs.slice(s.base).find((x) => x.summary), 120000, 20);
    c.act('at-compaction', { req: r.n, main: r.main });
    await sleep(1500);
    c.screen(l, 'compacting');
    await stopWith(c, l, how);
    await afterStop(c, l, how, 'continue');
  };
}

// E1: resume without sending: does the resume alone write anything?
SCENARIOS.E1 = async (c) => {
  const l = await c.launch([]);
  await warm(c, l);
  const s = await c.say(l, P.thinking);
  await c.thinking(s.base);
  await stopWith(c, l, 'SIGTERM');
  const l2 = await c.launch(['--continue']);
  await c.quiet(8000);
  c.screen(l2, 'resumed-idle');
  await c.exit(l2);
  await resumeAndSend(c, 'continue');
};

// E2: two interrupts in a row, then a successful reply.
SCENARIOS.E2 = async (c) => {
  const l = await c.launch([]);
  await warm(c, l);
  let s = await c.say(l, P.thinking);
  await c.thinking(s.base);
  await stopWith(c, l, 'esc');
  s = await c.say(l, P.thinking2);
  await c.thinking(s.base);
  await stopWith(c, l, 'esc');
  await next(c, l);
  await c.exit(l);
};

// E3: typing a message while it works.
SCENARIOS['E3-thinking'] = async (c) => {
  const l = await c.launch([]);
  await warm(c, l);
  const s = await c.say(l, P.thinking);
  await c.thinking(s.base);
  const s2 = await c.say(l, NEXT);
  await c.turnEnd(l, s2, 120000).catch(() => {});
  await c.quiet(3000);
  await c.exit(l);
};
SCENARIOS['E3-tool'] = async (c) => {
  const l = await c.launch(TOOL_ALLOW);
  await warm(c, l);
  const s = await c.say(l, P.tool);
  await c.toolRunning(l);
  await c.say(l, NEXT);
  await c.quiet(5000, 120000);
  await until('turn end', () => c.transcriptSince(s.evIdx).filter((e) => e.subtype === 'turn_duration').length >= 1 || undefined, 120000, 50).catch(() => {});
  await c.quiet(3000);
  await c.exit(l);
};

// F1: the output limit (CLAUDE_CODE_MAX_OUTPUT_TOKENS lowered).
SCENARIOS.F1 = async (c) => {
  const l = await c.launch([], { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '300' });
  await warm(c, l);
  const s = await c.say(l, P.text.replace('sixty', 'two hundred'));
  await c.turnEnd(l, s, 180000);
  await next(c, l);
  await c.exit(l);
};

// F2: an API error from the forwarder, in place of the reply.
const F2: Record<string, Fault> = {
  overloaded: { kind: 'status', status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded (injected by the cancel-cli forwarder)' } }, times: 50 },
  server: { kind: 'status', status: 500, body: { type: 'error', error: { type: 'api_error', message: 'Internal server error (injected by the cancel-cli forwarder)' } }, times: 50 },
  ratelimit: { kind: 'status', status: 429, body: { type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited (injected by the cancel-cli forwarder)' } }, headers: { 'retry-after': '1' }, times: 50 },
};
for (const [k, f] of Object.entries(F2)) {
  SCENARIOS[`F2-${k}`] = async (c) => {
    const l = await c.launch([], { CLAUDE_CODE_MAX_RETRIES: '2' });
    await warm(c, l);
    c.setFault({ ...f });
    const s = await c.say(l, P.thinking);
    await until('error shown or turn end', () => c.transcriptSince(s.evIdx).some((e) => e.isApiErrorMessage === true || e.subtype === 'turn_duration') || undefined, 180000, 50).catch(() => {});
    await c.quiet(3000);
    c.screen(l, 'after-error');
    c.fwd.fault = undefined;
    await next(c, l);
    await c.exit(l);
  };
}

// F3: the connection dropped mid-stream (during thinking, and mid-text).
SCENARIOS['F3-thinking'] = async (c) => {
  const l = await c.launch([], { CLAUDE_CODE_MAX_RETRIES: '2' });
  await warm(c, l);
  let started = 0;
  c.setFault({ kind: 'cut', times: 1, after: (r) => {
    const b = r.blocks.find((x) => x?.type === 'thinking');
    if (b && !started) {
      started = now();
    }
    return started > 0 && now() - started > 700;
  } });
  const s = await c.say(l, P.thinking);
  await until('turn end or error', () => c.transcriptSince(s.evIdx).some((e) => e.isApiErrorMessage === true || e.subtype === 'turn_duration') || undefined, 180000, 50).catch(() => {});
  await c.quiet(3000);
  c.screen(l, 'after-cut');
  await next(c, l);
  await c.exit(l);
};
SCENARIOS['F3-text'] = async (c) => {
  const l = await c.launch([], { CLAUDE_CODE_MAX_RETRIES: '2' });
  await warm(c, l);
  c.setFault({ kind: 'cut', times: 1, after: (r) => r.blocks.some((b) => b?.type === 'text' && b.deltas >= 15) });
  const s = await c.say(l, P.text);
  await until('turn end or error', () => c.transcriptSince(s.evIdx).some((e) => e.isApiErrorMessage === true || e.subtype === 'turn_duration') || undefined, 180000, 50).catch(() => {});
  await c.quiet(3000);
  c.screen(l, 'after-cut');
  await next(c, l);
  await c.exit(l);
};

// F3, every attempt cut mid-text, so the retries run out.
SCENARIOS['F3-text-every'] = async (c) => {
  const l = await c.launch([], { CLAUDE_CODE_MAX_RETRIES: '2' });
  await warm(c, l);
  c.setFault({ kind: 'cut', times: 10, after: (r) => r.blocks.some((b) => b?.type === 'text' && b.deltas >= 15) });
  const s = await c.say(l, P.text);
  await until('turn end or error', () => c.transcriptSince(s.evIdx).some((e) => e.isApiErrorMessage === true || e.subtype === 'turn_duration') || undefined, 180000, 50).catch(() => {});
  await c.quiet(3000);
  c.screen(l, 'after-cuts');
  c.fwd.fault = undefined;
  await next(c, l);
  await c.exit(l);
};

// G: an Esc, then the process ends while idle (SIGTERM), then a resume and
// a send: what a resume makes of what the Esc left as the file's last
// entries.
SCENARIOS['G-esc-thinking-then-kill'] = async (c) => {
  const l = await c.launch([]);
  await warm(c, l);
  const s = await c.say(l, P.thinking);
  await c.thinking(s.base);
  await stopWith(c, l, 'esc');
  await stopWith(c, l, 'SIGTERM');
  await resumeAndSend(c, 'continue');
};
SCENARIOS['G-esc-text-then-kill'] = async (c) => {
  const l = await c.launch([]);
  await warm(c, l);
  const s = await c.say(l, P.text);
  await c.midText(s.base);
  await stopWith(c, l, 'esc');
  await stopWith(c, l, 'SIGTERM');
  await resumeAndSend(c, 'continue');
};

// A and C with a thinking block before the reply's text.
SCENARIOS['A-thinktext'] = async (c) => {
  const l = await c.launch([]);
  await warm(c, l);
  const s = await c.say(l, P.thinkText);
  await c.midText(s.base);
  await stopWith(c, l, 'esc');
  await next(c, l);
  await c.exit(l);
};
SCENARIOS['C-thinktext-SIGTERM'] = async (c) => {
  const l = await c.launch([]);
  await warm(c, l);
  const s = await c.say(l, P.thinkText);
  await c.midText(s.base);
  await stopWith(c, l, 'SIGTERM');
  await afterStop(c, l, 'SIGTERM', 'continue');
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--list')) {
    console.log(Object.keys(SCENARIOS).join('\n'));
    return;
  }
  const id = args[0];
  const opt = (k: string): string | undefined => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const name = opt('--name') ?? 'cancel-cli';
  const scenario = SCENARIOS[id ?? ''];
  if (!scenario) {
    throw new Error(`unknown scenario ${id}; --list lists them`);
  }
  const ts = new Date().toISOString().replace(/[-:.]/g, '').replace('T', 'T');
  const dir = join(RUNS, `cancel-cli-${ts}-${id}${opt('--label') ? `-${opt('--label')}` : ''}`);
  mkdirSync(dir, { recursive: true });
  const c = new Ctx(name, dir);
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ scenario: id, name, configDir: c.configDir, cwd: c.cwd, model: MODEL, upstream: c.fwd.upstream.origin, started: new Date().toISOString() }, null, 2));
  console.log(`run dir: ${dir}`);
  let failed: unknown;
  try {
    await c.start();
    await scenario(c);
  } catch (e) {
    failed = e;
    c.act('error', { error: String(e instanceof Error ? e.stack : e) });
    console.error(e);
  } finally {
    await c.finish();
  }
  render(dir);
  console.log(`report: ${join(dir, 'report.txt')}`);
  if (failed) {
    process.exitCode = 1;
  }
}

await main();
