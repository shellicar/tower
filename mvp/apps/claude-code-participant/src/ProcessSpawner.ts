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

/** Starting a child process: the edge between the participant and the OS. */
export abstract class IProcessSpawner {
  public abstract spawn(command: string, args: string[], options: ProcessOptions): SpawnedProcess;
}

export class NodeProcessSpawner implements IProcessSpawner {
  public spawn(command: string, args: string[], options: ProcessOptions): SpawnedProcess {
    return spawn(command, args, options) as SpawnedProcess;
  }
}
