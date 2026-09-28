import type { EffortLevel, PermissionMode, ThinkingAdaptive } from '@anthropic-ai/claude-agent-sdk';

// Adaptive or off: the SDK's `enabled` is a fixed thinking budget, which is
// deprecated and gives worse thinking.
export const THINKING_TYPES = ['adaptive', 'disabled'] as const;
export const THINKING_DISPLAYS = ['summarized', 'omitted'] as const;
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly EffortLevel[];
export const PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'] as const satisfies readonly PermissionMode[];

// An SDK update that adds a value fails the type check here, instead of the
// new value being refused without anyone noticing.
type Covers<Union, Listed> = [Exclude<Union, Listed>] extends [never] ? true : false;
const effortCovered: Covers<EffortLevel, (typeof EFFORT_LEVELS)[number]> = true;
const permissionModesCovered: Covers<PermissionMode, (typeof PERMISSION_MODES)[number]> = true;
const displaysCovered: Covers<NonNullable<ThinkingAdaptive['display']>, (typeof THINKING_DISPLAYS)[number]> = true;
void effortCovered;
void permissionModesCovered;
void displaysCovered;

type ThinkingType = (typeof THINKING_TYPES)[number];
type ThinkingDisplay = (typeof THINKING_DISPLAYS)[number];

export type ModelCell = {
  name?: string;
  maxTokens?: number;
  thinking?: ThinkingType;
  thinkingDisplay?: ThinkingDisplay;
  effort?: EffortLevel;
};

export type SystemCell = {
  /** Whether Claude Code's own system prompt (the `claude_code` preset) is sent. */
  preset: boolean;
  /** Own text, sent after the preset or on its own. */
  text?: string;
};

export type ClaudeSettings = Record<string, unknown>;

/** Everything a conversation is launched with, all required values present. */
export type LaunchSettings = {
  model: Required<ModelCell>;
  system: SystemCell;
  permissionMode: PermissionMode;
  context: string | undefined;
  claudeSettings: ClaudeSettings | undefined;
};

export type Readiness = { ready: true; settings: LaunchSettings } | { ready: false; missing: string[] };

/**
 * What the control lines set. Nothing has a default: the process starts with
 * every cell empty and refuses to launch a conversation until the required
 * ones are set.
 */
export class ParticipantSettings {
  public model: ModelCell = {};
  public system: SystemCell | undefined;
  public permissionMode: PermissionMode | undefined;
  public context: string | undefined;
  public claudeSettings: ClaudeSettings | undefined;

  /** The values a conversation launched now would get, or what's missing. */
  public readiness(): Readiness {
    const { name, maxTokens, thinking, thinkingDisplay, effort } = this.model;
    const missing: string[] = [];
    if (name === undefined) {
      missing.push('model.name');
    }
    if (maxTokens === undefined) {
      missing.push('model.maxTokens');
    }
    if (thinking === undefined) {
      missing.push('model.thinking');
    }
    if (thinkingDisplay === undefined) {
      missing.push('model.thinkingDisplay');
    }
    if (effort === undefined) {
      missing.push('model.effort');
    }
    if (this.system === undefined) {
      missing.push('system');
    }
    if (this.permissionMode === undefined) {
      missing.push('permissionMode');
    }
    if (name === undefined || maxTokens === undefined || thinking === undefined || thinkingDisplay === undefined || effort === undefined || this.system === undefined || this.permissionMode === undefined) {
      return { ready: false, missing };
    }
    return {
      ready: true,
      settings: {
        model: { name, maxTokens, thinking, thinkingDisplay, effort },
        system: { ...this.system },
        permissionMode: this.permissionMode,
        context: this.context,
        claudeSettings: this.claudeSettings === undefined ? undefined : structuredClone(this.claudeSettings),
      },
    };
  }
}
