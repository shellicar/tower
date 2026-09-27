// Integration proof: the driver's handle on one participant process
// (proof 25's participant/driver split). Starts `participant.mts` as its own
// OS process (optionally under a file-access trace), sends it commands, waits
// for its events, and can SIGKILL it (its own pid, start time checked).

import { type ChildProcess, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clean, gone, HERE, iso, type Json, type Known, PACKAGE_ROOT, procStat, signalChecked, sleep } from './lib.mts';
import type { Spec } from './participant.mts';

export interface StartOptions {
  // Run under `strace -f -y -ttt -s 0 -e trace=%file,%process` (no file
  // contents), writing <runDir>/trace.strace.
  strace?: boolean;
  log?: (s: string) => void;
}

export class Participant {
  readonly spec: Spec;
  readonly child: ChildProcess;
  readonly events: Json[] = [];
  readonly waiters: { pred: (e: Json) => boolean; resolve: (e: Json) => void }[] = [];
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly tracePath: string | undefined;
  readonly log: (s: string) => void;
  me: Known | undefined;
  claudes: Known[] = [];
  exitInfo: { code: number | null; signal: NodeJS.Signals | null } | undefined;

  constructor(spec: Spec, o: StartOptions = {}) {
    this.spec = spec;
    this.log = o.log ?? ((s) => process.stdout.write(`${iso()} ${s}\n`));
    mkdirSync(spec.runDir, { recursive: true });
    const specPath = join(spec.runDir, 'spec.in.json');
    writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`);
    const node = [process.execPath, '--disable-warning=ExperimentalWarning', join(HERE, 'participant.mts'), specPath];
    this.tracePath = o.strace ? join(spec.runDir, 'trace.strace') : undefined;
    const [cmd, ...args] = this.tracePath ? ['strace', '-f', '-y', '-ttt', '-s', '0', '-e', 'trace=%file,%process', '-o', this.tracePath, ...node] : node;
    this.child = spawn(cmd as string, args, { cwd: PACKAGE_ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    this.child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      let at = buf.indexOf('\n');
      while (at >= 0) {
        const line = buf.slice(0, at);
        buf = buf.slice(at + 1);
        at = buf.indexOf('\n');
        let e: Json;
        try {
          e = JSON.parse(line) as Json;
        } catch {
          appendFileSync(join(spec.runDir, 'participant.stdout-other.txt'), `${clean(line)}\n`);
          continue;
        }
        this.onEvent(e);
      }
    });
    this.child.stderr?.on('data', (d: Buffer) => appendFileSync(join(spec.runDir, 'participant.stderr.txt'), clean(d.toString('utf8'))));
    this.exited = new Promise((resolve) => {
      this.child.once('exit', (code, signal) => {
        this.exitInfo = { code, signal };
        this.log(`[${spec.agent}] participant exited code ${code} signal ${signal}`);
        resolve({ code, signal });
      });
    });
  }

  private onEvent(e: Json): void {
    this.events.push(e);
    if (e.ev === 'ready') {
      this.me = { pid: Number(e.pid), starttime: String(e.starttime) };
    }
    if (e.ev === 'spawn') {
      this.claudes.push({ pid: Number(e.pid), starttime: String(e.starttime) });
    }
    if (!['published', 'would-publish'].includes(String(e.ev))) {
      this.log(`[${this.spec.agent}] ${String(e.ev)} ${JSON.stringify({ ...e, ev: undefined, ts: undefined, ms: undefined, agent: undefined, pid: e.ev === 'ready' ? e.pid : undefined }).slice(0, 260)}`);
    }
    for (const w of [...this.waiters]) {
      if (w.pred(e)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(e);
      }
    }
  }

  send(cmd: Json): void {
    this.child.stdin?.write(`${JSON.stringify(cmd)}\n`);
  }

  // The first event (already seen or to come) matching `pred`.
  waitFor(pred: (e: Json) => boolean, ms: number, what: string, since = 0): Promise<Json> {
    const seen = this.events.slice(since).find(pred);
    if (seen) {
      return Promise.resolve(seen);
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiters.splice(
          this.waiters.findIndex((w) => w.resolve === done),
          1,
        );
        reject(new Error(`[${this.spec.agent}] timed out after ${ms} ms waiting for ${what}`));
      }, ms);
      const done = (e: Json): void => {
        clearTimeout(t);
        resolve(e);
      };
      this.waiters.push({ pred, resolve: done });
      void this.exited.then(() => {
        const i = this.waiters.findIndex((w) => w.resolve === done);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          clearTimeout(t);
          reject(new Error(`[${this.spec.agent}] exited while waiting for ${what}`));
        }
      });
    });
  }

  async ready(ms = 60_000): Promise<void> {
    await this.waitFor((e) => e.ev === 'ready', ms, 'ready');
  }

  async serve(cmd: Json, ms = 240_000): Promise<Json> {
    const n = this.events.length;
    this.send({ cmd: 'serve', ...cmd });
    return this.waitFor((e) => (e.ev === 'served' || e.ev === 'error') && e.conv === cmd.conv, ms, `served ${String(cmd.conv)}`, n).then((e) => {
      if (e.ev === 'error') {
        throw new Error(`serve ${String(cmd.conv)}: ${String(e.message)}`);
      }
      return e;
    });
  }

  // Say, then wait for that query's result and a quiet spell after it (late
  // appends; reconcile's QUIET_MS).
  async say(conv: string, text: string, o: { ending?: string; step?: number; timeoutMs?: number; quietMs?: number } = {}): Promise<Json> {
    const n = this.events.length;
    this.send({ cmd: 'say', conv, text, ...(o.ending ? { ending: o.ending } : {}), ...(o.step !== undefined ? { step: o.step } : {}) });
    const sent = await this.waitFor((e) => (e.ev === 'sent' || e.ev === 'say-rejected' || e.ev === 'error') && e.conv === conv, 30_000, `sent ${conv}`, n);
    if (sent.ev !== 'sent') {
      throw new Error(`say ${conv}: ${String(sent.ev)} ${String(sent.reason ?? sent.message ?? '')}`);
    }
    const r = await this.waitFor((e) => e.ev === 'result' && e.conv === conv && e.queryId === sent.queryId, o.timeoutMs ?? 240_000, `result ${conv} step ${String(o.step)}`, n);
    await sleep(o.quietMs ?? 2500);
    return r;
  }

  async shutdown(ms = 180_000): Promise<void> {
    this.send({ cmd: 'shutdown' });
    const t = setTimeout(() => this.log(`[${this.spec.agent}] shutdown still running after ${ms} ms`), ms);
    await this.exited;
    clearTimeout(t);
  }

  // SIGKILL this participant (only its own pid, start time checked).
  kill9(): boolean {
    if (!this.me) {
      throw new Error('participant not ready');
    }
    return signalChecked(this.me, 'SIGKILL', this.log);
  }

  async claudesGone(ms = 60_000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (this.claudes.every((k) => gone(k))) {
        return true;
      }
      await sleep(20);
    }
    return false;
  }

  alive(): boolean {
    return this.me !== undefined && procStat(this.me.pid) !== undefined && !gone(this.me);
  }
}
