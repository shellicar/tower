import { dependsOn } from '@shellicar/core-di';
import { PARTICIPANT_TAG } from './ClaudeCodeSpawner.js';
import { ParticipantConfig } from './ParticipantConfig.js';
import { IProcessTable, type TaggedProcess } from './ProcessTable.js';
import { ITimer } from './Timer.js';

// TODO: undecided until the shutdown line is on this branch: the SIGINT and
// SIGTERM waits are meant to be that line's two deadlines, and these are its
// defaults. Even once it is, the scan runs before any control line has been
// read, so it would still get the defaults.
const SIGINT_WAIT_MS = 30_000;
const SIGTERM_WAIT_MS = 10_000;
/** SIGKILL can't be refused; this only gives the kernel time to take the process down before what's left is reported. */
const SIGKILL_WAIT_MS = 1_000;
const POLL_MS = 50;

const ESCALATION: readonly { signal: NodeJS.Signals; waitMs: number }[] = [
  { signal: 'SIGINT', waitMs: SIGINT_WAIT_MS },
  { signal: 'SIGTERM', waitMs: SIGTERM_WAIT_MS },
  { signal: 'SIGKILL', waitMs: SIGKILL_WAIT_MS },
];

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
 * Run once, at start, after the lock is taken: this process tracks what it
 * starts itself, so leftovers can only come from an earlier one.
 */
export class Leftovers {
  @dependsOn(ParticipantConfig) private readonly config!: ParticipantConfig;
  @dependsOn(IProcessTable) private readonly processes!: IProcessTable;
  @dependsOn(ITimer) private readonly timer!: ITimer;

  /**
   * SIGINT, wait, SIGTERM, wait, SIGKILL; each stage reaches every tagged
   * process there at the time, one that appeared since included. Returns
   * what is still there after SIGKILL, which is served past: a process that
   * has received SIGKILL can't run its own code again, so at most a write it
   * was already inside finishes.
   */
  public async stop(log: (line: string) => void): Promise<TaggedProcess[]> {
    const entry = `${PARTICIPANT_TAG}=${this.config.configDir}`;
    const found = this.processes.tagged(entry);
    if (found.length === 0) {
      return [];
    }
    log(`leftovers: ${found.length} process(es) left running on ${this.config.configDir}: ${listed(found)}`);
    const started = this.timer.now();
    for (const { signal, waitMs } of ESCALATION) {
      const targets = this.processes.tagged(entry);
      if (targets.length === 0) {
        break;
      }
      const sent = targets.filter((target) => this.processes.signal(target, signal));
      log(`leftovers: ${signal} to ${sent.map((p) => p.pid).join(', ') || 'none (already gone)'}; waiting up to ${waitMs} ms`);
      if (await this.goneWithin(entry, waitMs)) {
        log(`leftovers: all gone after ${Math.round(this.timer.now() - started)} ms`);
        return [];
      }
    }
    const remaining = this.processes.tagged(entry);
    if (remaining.length > 0) {
      log(`leftovers: still there after SIGKILL, serving anyway: ${listed(remaining)}`);
    }
    return remaining;
  }

  private async goneWithin(entry: string, waitMs: number): Promise<boolean> {
    const deadline = this.timer.now() + waitMs;
    for (;;) {
      if (this.processes.tagged(entry).length === 0) {
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
