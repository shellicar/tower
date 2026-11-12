import type { EffortLevel, PermissionMode, Settings } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeSettings, LaunchSettings } from './ParticipantSettings.js';

/**
 * The effort levels Claude Code's settings can carry. `max` isn't one: its
 * settings schema drops it, so `max` can only reach Claude Code as a launch
 * option.
 */
export const SETTINGS_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const satisfies readonly NonNullable<Settings['effortLevel']>[];
const settingsEffortCovered: [Exclude<NonNullable<Settings['effortLevel']>, (typeof SETTINGS_EFFORT_LEVELS)[number]>] extends [never] ? true : false = true;
void settingsEffortCovered;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSettingsEffort(effort: EffortLevel): effort is (typeof SETTINGS_EFFORT_LEVELS)[number] {
  return (SETTINGS_EFFORT_LEVELS as readonly string[]).includes(effort);
}

export type LaunchClaudeSettings = Settings & { permissions: Settings['permissions'] & { defaultMode: PermissionMode } };

/**
 * The settings Claude Code is launched with. The required values are the
 * baseline, and `claudeSettings`, the explicit override, is applied over
 * them, so it wins wherever both set something. Claude Code then resolves
 * the rest itself: a per-model effort in `modelSettings` beats the top-level
 * `effortLevel`, and `env` beats the environment Claude Code starts with.
 * The permission mode lives in the same `permissions` object as allow and
 * deny rules, so the override's `permissions` is merged into the baseline's
 * rather than replacing it.
 */
export function claudeCodeSettings(required: LaunchSettings, fallback: ClaudeSettings | undefined): LaunchClaudeSettings {
  const { model } = required;
  const baseline: LaunchClaudeSettings = {
    model: model.name,
    ...(isSettingsEffort(model.effort) ? { effortLevel: model.effort } : {}),
    // Claude Code reads this as: false, thinking off; true, thinking on
    // (adaptive where the model has it), shown as the declared display.
    alwaysThinkingEnabled: model.thinking !== 'disabled',
    // The account's claude.ai connectors arrive through the login; they are
    // off unless the override turns them back on.
    disableClaudeAiConnectors: true,
    permissions: { defaultMode: required.permissionMode },
  };
  if (fallback === undefined) {
    return baseline;
  }
  const permissions = isObject(fallback.permissions) ? { ...baseline.permissions, ...fallback.permissions } : baseline.permissions;
  return { ...baseline, ...fallback, permissions } as LaunchClaudeSettings;
}
