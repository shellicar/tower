import { dependsOn } from '@shellicar/core-di';
import { PARTICIPANT_TAG } from './ClaudeCodeSpawner.js';
import { ParticipantConfig } from './ParticipantConfig.js';
import { IProcessTable, type TaggedProcess } from './ProcessTable.js';
import { ITimer } from './Timer.js';

const SIGINT_WAIT_MS = 5_000;
const SIGTERM_WAIT_MS = 5_000;
/** SIGKILL can't be refused; this only gives the kernel time to take the process down before what's left is reported. */
const SIGKILL_WAIT_MS = 1_000;
const POLL_MS = 50;

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
   * @param shutdown aborted when shutdown begins, which stops the scan where it is.
   */
  public async stop(log: (line: string) => void, shutdown: AbortSignal): Promise<LeftoverStop> {
    const entry = `${PARTICIPANT_TAG}=${this.config.configDir}`;
    const found = this.processes.tagged(entry);
    if (found.length === 0) {
      return { interrupted: false, remaining: [] };
    }
    log(`leftovers: ${found.length} process(es) left running on ${this.config.configDir}: ${listed(found)}`);
    const started = this.timer.now();
    for (const { signal, waitMs } of ESCALATION) {
      if (shutdown.aborted) {
        return this.interrupted(entry, log);
      }
      const targets = this.processes.tagged(entry);
      if (targets.length === 0) {
        break;
      }
      const sent = targets.filter((target) => this.processes.signal(target, signal));
      log(`leftovers: ${signal} to ${sent.map((p) => p.pid).join(', ') || 'none (already gone)'}; waiting up to ${waitMs} ms`);
      if (await this.goneWithin(entry, waitMs, shutdown)) {
        log(`leftovers: all gone after ${Math.round(this.timer.now() - started)} ms`);
        return { interrupted: false, remaining: [] };
      }
    }
    if (shutdown.aborted) {
      return this.interrupted(entry, log);
    }
    const remaining = this.processes.tagged(entry);
    if (remaining.length > 0) {
      log(`leftovers: still there after SIGKILL, serving anyway: ${listed(remaining)}`);
    }
    return { interrupted: false, remaining };
  }

  private interrupted(entry: string, log: (line: string) => void): LeftoverStop {
    const remaining = this.processes.tagged(entry);
    log(`leftovers: scan stopped for shutdown${remaining.length > 0 ? `, leaving ${listed(remaining)}` : ''}`);
    return { interrupted: true, remaining };
  }

  private async goneWithin(entry: string, waitMs: number, shutdown: AbortSignal): Promise<boolean> {
    const deadline = this.timer.now() + waitMs;
    for (;;) {
      if (this.processes.tagged(entry).length === 0) {
        return true;
      }
      const left = deadline - this.timer.now();
      if (left <= 0 || shutdown.aborted) {
        return false;
      }
      await this.timer.sleep(Math.min(POLL_MS, left));
    }
  }
}
