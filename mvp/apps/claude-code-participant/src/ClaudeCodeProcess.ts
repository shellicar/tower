import type { ChildProcessHandle } from './ProcessSpawner.js';

/**
 * A conversation's Claude Code process, from the moment the SDK starts it
 * (the spawn hook) until it exits. It exists before the process does, because
 * the SDK decides when to call the hook.
 */
export class ClaudeCodeProcess {
  private child: ChildProcessHandle | undefined;
  private hasExited = false;
  private readonly exit = Promise.withResolvers<void>();
  /** Settles once Claude Code has exited. Never settles if the SDK never started it. */
  public readonly exited: Promise<void> = this.exit.promise;

  public started(child: ChildProcessHandle): void {
    this.child = child;
    // A start that failed has no pid and no exit to wait for.
    if (child.pid === undefined || child.exitCode !== null || (child.signalCode ?? null) !== null) {
      this.markExited();
      return;
    }
    child.once('exit', () => this.markExited());
  }

  /**
   * Claude Code's pid while it runs, which is also its process group's id
   * (it's started in a group of its own). Undefined before it starts and once
   * it has exited, so a pid the OS has since reused is never signalled.
   */
  public get runningPid(): number | undefined {
    return this.hasExited ? undefined : this.child?.pid;
  }

  private markExited(): void {
    this.hasExited = true;
    this.exit.resolve();
  }
}
