import { type StdioOptions, spawn } from 'node:child_process';
import type { SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';

export type ProcessOptions = {
  cwd: string | undefined;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
  detached: boolean;
  windowsHide: boolean;
  stdio: StdioOptions;
};

/** A started child: what the SDK needs of it, and its pid, which is undefined when the start failed. */
export type ChildProcessHandle = SpawnedProcess & { readonly pid?: number | undefined };

/** Starting and signalling child processes: the edge between the participant and the OS. */
export abstract class IProcessSpawner {
  public abstract spawn(command: string, args: string[], options: ProcessOptions): ChildProcessHandle;
  /**
   * Sends `signal` to every process in the group `pid` leads. A group that is
   * already gone is not an error.
   */
  public abstract signalGroup(pid: number, signal: NodeJS.Signals): void;
}

type Kill = (pid: number, signal: NodeJS.Signals) => void;

export class NodeProcessSpawner implements IProcessSpawner {
  private readonly kill: Kill;

  public constructor(kill: Kill = (pid, signal) => process.kill(pid, signal)) {
    this.kill = kill;
  }

  public spawn(command: string, args: string[], options: ProcessOptions): ChildProcessHandle {
    return spawn(command, args, options) as ChildProcessHandle;
  }

  // Linux and macOS only. Windows has no process groups: there a negative pid
  // names no process, which comes back as ESRCH, the same as a group already
  // gone, so nothing is signalled and nothing is reported.
  public signalGroup(pid: number, signal: NodeJS.Signals): void {
    try {
      this.kill(-pid, signal);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw err;
      }
    }
  }
}
