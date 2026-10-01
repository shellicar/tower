import { dependsOn } from '@shellicar/core-di';
import { PARTICIPANT_TAG } from './ClaudeCodeSpawner.js';
import { ParticipantConfig } from './ParticipantConfig.js';
import { IProcessTable, ProcessListUnreadable, type TaggedProcess } from './ProcessTable.js';
import { ITimer } from './Timer.js';

const SIGINT_WAIT_MS = 5_000;
const SIGTERM_WAIT_MS = 5_000;
/** SIGKILL can't be refused; this only gives the kernel time to take the process down before what's left is reported. */
const SIGKILL_WAIT_MS = 1_000;
const POLL_MS = 50;
/** Strict reads until shutdown begins: until then, a process list that can't be read fails the start. */
function strictUntil(shutdown: AbortSignal): { strict: boolean } {
  return { strict: !shutdown.aborted };
}

const ESCALATION: readonly { signal: NodeJS.Signals; waitMs: number }[] = [
  { signal: 'SIGINT', waitMs: SIGINT_WAIT_MS },
  { signal: 'SIGTERM', waitMs: SIGTERM_WAIT_MS },
  { signal: 'SIGKILL', waitMs: SIGKILL_WAIT_MS },
];

export type LeftoverStop = {
  /** Set when shutdown began before the scan finished: the scan stopped where it was. */
  interrupted: boolean;
  /** What was still there when the scan ended. */
  remaining: TaggedProcess[];
};

function listed(processes: readonly TaggedProcess[]): string {
  return processes.map((p) => `${p.pid} (${p.commandLine === '' ? 'no command line' : p.commandLine})`).join(', ');
}

/**
 * Stops whatever an earlier run on this config dir left running, before this
 * one serves: a leftover Claude Code still writing to a conversation's
 * record while a new one serves it forks that record, and Claude Code's next
 * resume silently drops a branch.
 *
 * Every process carrying the tag is stopped, Claude Codes and the commands
 * they started alike: Claude Code runs each command in a session of its own,
 * so a command outlives a Claude Code killed without stopping it, and once
 * its parent is gone only the tag ties it to this config dir.
 *
 * Run once, at start, after the lock is taken.
 */
export class Leftovers {
  @dependsOn(ParticipantConfig) private readonly config!: ParticipantConfig;
  @dependsOn(IProcessTable) private readonly processes!: IProcessTable;
  @dependsOn(ITimer) private readonly timer!: ITimer;

  /**
   * SIGINT, wait, SIGTERM, wait, SIGKILL; each stage reaches every tagged
   * process there at the time, one that appeared since included.
   *
   * Until shutdown begins, the scan reads strictly: a process list that
   * can't be read throws ProcessListUnreadable, which fails the start. Once
   * shutdown has begun the start is cancelled, so such a failure, even one
   * from a read already under way, ends the scan as interrupted instead.
   *
   * @param shutdown aborted when shutdown begins, which stops the scan where it is.
   */
  public async stop(log: (line: string) => void, shutdown: AbortSignal): Promise<LeftoverStop> {
    const entry = `${PARTICIPANT_TAG}=${this.config.configDir}`;
    try {
      return await this.scan(entry, log, shutdown);
    } catch (err) {
      if (err instanceof ProcessListUnreadable && shutdown.aborted) {
        return this.interrupted(entry, log);
      }
      throw err;
    }
  }

  private async scan(entry: string, log: (line: string) => void, shutdown: AbortSignal): Promise<LeftoverStop> {
    if (shutdown.aborted) {
      return this.interrupted(entry, log);
    }
    const found = this.processes.tagged(entry, strictUntil(shutdown));
    if (found.length === 0) {
      return { interrupted: false, remaining: [] };
    }
    log(`leftovers: ${found.length} process(es) left running on ${this.config.configDir}: ${listed(found)}`);
    const started = this.timer.now();
    for (const { signal, waitMs } of ESCALATION) {
      if (shutdown.aborted) {
        return this.interrupted(entry, log);
      }
      const targets = this.processes.tagged(entry, strictUntil(shutdown));
      if (targets.length === 0) {
        break;
      }
      const sent = targets.filter((target) => this.processes.signal(target, signal, strictUntil(shutdown)));
      log(`leftovers: ${signal} to ${sent.map((p) => p.pid).join(', ') || 'none (already gone)'}; waiting up to ${waitMs} ms`);
      if (await this.goneWithin(entry, waitMs, shutdown)) {
        log(`leftovers: all gone after ${Math.round(this.timer.now() - started)} ms`);
        return { interrupted: false, remaining: [] };
      }
    }
    if (shutdown.aborted) {
      return this.interrupted(entry, log);
    }
    const remaining = this.processes.tagged(entry, strictUntil(shutdown));
    if (remaining.length > 0) {
      log(`leftovers: still there after SIGKILL, serving anyway: ${listed(remaining)}`);
    }
    return { interrupted: false, remaining };
  }

  /** Shutdown has begun, so this read is lenient: an unreadable list reads as nothing left. */
  private interrupted(entry: string, log: (line: string) => void): LeftoverStop {
    const remaining = this.processes.tagged(entry);
    log(`leftovers: scan stopped for shutdown${remaining.length > 0 ? `, leaving ${listed(remaining)}` : ''}`);
    return { interrupted: true, remaining };
  }

  private async goneWithin(entry: string, waitMs: number, shutdown: AbortSignal): Promise<boolean> {
    const deadline = this.timer.now() + waitMs;
    for (;;) {
      // Checked before the read: once shutdown has begun, the start is
      // cancelled, whatever the list says.
      if (shutdown.aborted) {
        return false;
      }
      if (this.processes.tagged(entry, strictUntil(shutdown)).length === 0) {
        return true;
      }
      const left = deadline - this.timer.now();
      if (left <= 0) {
        return false;
      }
      await this.timer.sleep(Math.min(POLL_MS, left));
    }
  }
}
