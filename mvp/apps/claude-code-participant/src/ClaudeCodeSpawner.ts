import { join } from 'node:path';
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { dependsOn } from '@shellicar/core-di';
import { ParticipantConfig } from './ParticipantConfig.js';
import { type ChildProcessHandle, IProcessSpawner } from './ProcessSpawner.js';

/**
 * The tag every Claude Code carries, set to the config dir, so a later run on
 * that config dir can find its leftovers. The commands a Claude Code starts
 * inherit it, which is what still ties one to the config dir once the Claude
 * Code that started it is gone.
 */
export const PARTICIPANT_TAG = 'TOWER_PARTICIPANT';

/** The real home, for the shell prefix to hand back to commands. */
export const REAL_HOME_VARIABLE = 'TOWER_REAL_HOME';

/**
 * Starts each Claude Code for the SDK (its `spawnClaudeCodeProcess` hook).
 * What only Claude Code should see is set here rather than in the query's
 * env, which the SDK also reads and, on some routes, overrides.
 */
export class ClaudeCodeSpawner {
  @dependsOn(IProcessSpawner) private readonly processes!: IProcessSpawner;
  @dependsOn(ParticipantConfig) private readonly config!: ParticipantConfig;

  public spawn(options: SpawnOptions): ChildProcessHandle {
    const env: Record<string, string | undefined> = {
      ...options.env,
      [PARTICIPANT_TAG]: this.config.configDir,
      // Claude Code's own housekeeping, caches and logs land in a private
      // home, never the real one.
      HOME: this.config.privateHome,
      // The login stays in the real ~/.claude. The SDK sets its own value on
      // the resume route, so it has to be set here, after the SDK.
      CLAUDE_SECURESTORAGE_CONFIG_DIR: join(this.config.realHome, '.claude'),
      // Bash, hooks and stdio MCP servers run with the real HOME.
      CLAUDE_CODE_SHELL_PREFIX: this.config.shellPrefix,
      [REAL_HOME_VARIABLE]: this.config.realHome,
    };
    // setpriv makes the kernel send Claude Code SIGINT if the participant
    // dies, so a killed participant's Claude Codes stop instead of running on
    // unsupervised. setpriv execs Claude Code, so the pid is Claude Code's.
    const { setpriv } = this.config;
    const command = setpriv ?? options.command;
    const args = setpriv === null ? options.args : ['--pdeathsig', 'SIGINT', '--', options.command, ...options.args];
    return this.processes.spawn(command, args, {
      cwd: options.cwd,
      env,
      signal: options.signal,
      // Its own process group (and a hidden console on Windows), so a
      // terminal's Ctrl-C reaches only the participant, which decides what
      // each Claude Code gets.
      detached: true,
      windowsHide: true,
      // Claude Code's stderr goes to the participant's own.
      stdio: ['pipe', 'pipe', 'inherit'],
    });
  }
}
