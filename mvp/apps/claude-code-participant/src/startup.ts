import { isAbsolute } from 'node:path';
import type { ExitName } from './ExitCodes.js';

// What a parent Claude Code session passes down to the processes it starts.
// A participant launched from inside a Claude Code session would otherwise
// hand them on, and its own Claude Codes would take themselves for that
// session's children. The list was read from Claude Code 2.1.282 (the env it
// builds for child processes, its Bash tool's list, its MCP and hook env, and
// a live session's shell); every name is still in the binary bundled with
// SDK 0.3.283. Generic names a parent also sets (GIT_EDITOR, TRACEPARENT,
// TMPDIR) are left alone: a user's own shell sets those too.
const PARENT_SESSION_VARIABLES: readonly string[] = [
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'AI_AGENT',
  'CLAUDE_PROJECT_DIR',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_INVOKED_SKILLS',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
];

// Claude Code's own configuration variables that change a required value:
// the model, effort, thinking, max tokens, system prompt or permission mode a
// conversation is launched with. Claude Code ranks several above its
// settings (ANTHROPIC_MODEL above the settings' model, CLAUDE_CODE_EFFORT_LEVEL
// above their effort), so one left in the participant's environment would
// silently replace a declared value. They are configuration, not environment,
// so they don't pass through; claudeSettings' `env` can still set any of them
// explicitly. Read from the binary bundled with SDK 0.3.283 (Claude Code
// 2.1.283).
const CLAUDE_CODE_CONFIGURATION_VARIABLES: readonly string[] = [
  // Model: the model itself, what an alias names, and the remap of retired
  // model names.
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP',
  // What a model is taken to support, which decides whether effort and
  // adaptive thinking are sent at all.
  'CLAUDE_CODE_MODEL_CAPABILITIES',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES',
  // Effort.
  'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_ALWAYS_ENABLE_EFFORT',
  // Thinking and its display.
  'CLAUDE_CODE_DISABLE_THINKING',
  'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING',
  'MAX_THINKING_TOKENS',
  'DISABLE_INTERLEAVED_THINKING',
  'CLAUDE_CODE_THINKING_DISPLAY_UPDATES',
  // Max tokens: the participant sets its own.
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  // Extra fields merged into every request body, effort and thinking
  // included.
  'CLAUDE_CODE_EXTRA_BODY',
  // The system prompt: the reduced prompt, and a remote-only replacement.
  'CLAUDE_CODE_SIMPLE',
  'CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT',
  'CLAUDE_CODE_SYSTEM_PROMPT_GB_FEATURE',
  // Permission mode: whether auto mode is offered, the mode a bridge child
  // falls back to, and a team's plan-mode requirement.
  'CLAUDE_CODE_ENABLE_AUTO_MODE',
  'CLAUDE_CODE_BRIDGE_CHILD_AUTO_DEFAULT',
  'CLAUDE_CODE_PLAN_MODE_REQUIRED',
  // TODO: undecided: CLAUDE_CODE_SUBPROCESS_ENV_SCRUB also forces the
  // permission mode to `default`, but it is a security hardening as well
  // (it scrubs the environment of the commands Claude Code runs and isolates
  // them with bubblewrap), so it still passes through. Stripping it would
  // keep the declared mode and switch that hardening off.
];

type StartupExit = Extract<ExitName, 'badEnvironment' | 'configDirLocked' | 'unsupportedPlatform'>;

/** Why the process can't start, and which way it exits for it. */
export class StartupError extends Error {
  public override name = 'StartupError';
  public readonly exit: StartupExit;

  public constructor(exit: StartupExit, message: string) {
    super(message);
    this.exit = exit;
  }
}

/** What the process reads from its environment, once, at start. */
export type Startup = {
  natsUrl: string;
  /** The agent's own Claude Code config dir, reused across runs: the agent's identity, which no two participants may share. */
  configDir: string;
  /** The real home: the login lives under it, and commands run with it. */
  realHome: string;
  /** The environment Claude Code inherits, parent-session and Claude Code configuration variables removed. */
  inheritedEnv: Record<string, string>;
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new StartupError('badEnvironment', `${name} is required`);
  }
  return value;
}

function absolute(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name);
  // A relative path is refused, not resolved: resolved against the directory
  // the process started in, the result would depend on where it happened to
  // start, and passed on as it is, it would resolve against each
  // conversation's own cwd.
  if (!isAbsolute(value)) {
    throw new StartupError('badEnvironment', `${name} must be an absolute path`);
  }
  return value;
}

export function readStartup(env: NodeJS.ProcessEnv): Startup {
  // NATS_URL has no default: an unset one must never land on a live broker.
  const natsUrl = required(env, 'NATS_URL');
  // None of these can arrive later (they aren't control lines), so a process
  // started without one could never serve: it stops at start instead.
  const configDir = absolute(env, 'PARTICIPANT_CONFIG_DIR');
  const realHome = absolute(env, 'HOME');
  const inheritedEnv: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !PARENT_SESSION_VARIABLES.includes(name) && !CLAUDE_CODE_CONFIGURATION_VARIABLES.includes(name)) {
      inheritedEnv[name] = value;
    }
  }
  return { natsUrl, configDir, realHome, inheritedEnv };
}
