import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { dependsOn } from '@shellicar/core-di';
import { IClaudeCode } from './ClaudeCode.js';
import { ClaudeCodeProcess } from './ClaudeCodeProcess.js';
import { ClaudeCodeSpawner } from './ClaudeCodeSpawner.js';
import { Conversation } from './Conversation.js';
import { Conversations } from './Conversations.js';
import { claudeCodeSettings } from './claudeCodeSettings.js';
import { MessageChannel } from './MessageChannel.js';
import { ParticipantConfig } from './ParticipantConfig.js';
import { type LaunchSettings, ParticipantSettings } from './ParticipantSettings.js';
import { ServingGate } from './ServingGate.js';
import { PublishingSessionStore } from './SessionStore.js';

export type LaunchRequest = {
  /** The conversation id, which is also Claude Code's session id. */
  id: string;
  /** Where Claude Code runs. Every conversation names its own. */
  cwd: string;
  /** Sent on every launch, a resume included: Claude Code drops them on resume. */
  additionalDirectories: string[];
  /** Whether Claude Code's own local record of this conversation is resumed. */
  resume: boolean;
};

export class NotConfiguredError extends Error {
  public override name = 'NotConfiguredError';
  public readonly missing: readonly string[];

  public constructor(missing: readonly string[]) {
    super(`not configured: ${missing.join(', ')} not set`);
    this.missing = missing;
  }
}

function systemPrompt(system: LaunchSettings['system']): Options['systemPrompt'] {
  if (system.preset) {
    return system.text === undefined ? { type: 'preset', preset: 'claude_code' } : { type: 'preset', preset: 'claude_code', append: system.text };
  }
  return system.text ?? '';
}

/**
 * Starts Claude Code for a conversation: one query, fed a stream of user
 * messages, with what the control lines hold at that moment. A conversation
 * keeps those values for its life; a later control line reaches only
 * conversations launched after it.
 */
export class ConversationLauncher {
  @dependsOn(ParticipantSettings) private readonly settings!: ParticipantSettings;
  @dependsOn(ParticipantConfig) private readonly config!: ParticipantConfig;
  @dependsOn(IClaudeCode) private readonly claudeCode!: IClaudeCode;
  @dependsOn(ClaudeCodeSpawner) private readonly spawner!: ClaudeCodeSpawner;
  @dependsOn(PublishingSessionStore) private readonly sessionStore!: PublishingSessionStore;
  @dependsOn(ServingGate) private readonly gate!: ServingGate;
  @dependsOn(Conversations) private readonly conversations!: Conversations;

  /**
   * Starts Claude Code once the serving gate opens, with the values the
   * control lines held when the launch was asked for.
   *
   * @throws NotConfiguredError until every required control line has been set.
   */
  public async launch(request: LaunchRequest): Promise<Conversation> {
    const readiness = this.settings.readiness();
    if (!readiness.ready) {
      throw new NotConfiguredError(readiness.missing);
    }
    await this.gate.wait();
    const { settings } = readiness;
    const input = new MessageChannel<SDKUserMessage>();
    const claudeCodeProcess = new ClaudeCodeProcess();
    const messages = this.claudeCode.query(input, this.options(request, settings, claudeCodeProcess));
    // The context is built into a new conversation's first message. A resumed
    // one already carries it in its record.
    const conversation = new Conversation(request.id, input, messages, claudeCodeProcess, request.resume ? undefined : settings.context);
    this.conversations.add(conversation);
    return conversation;
  }

  private options(request: LaunchRequest, settings: LaunchSettings, claudeCodeProcess: ClaudeCodeProcess): Options {
    // The required values go in the settings, as a baseline the override is
    // applied over; a launch option would outrank every setting, the
    // override's included. Model, effort, thinking and max tokens need
    // nothing more.
    const claudeSettings = claudeCodeSettings(settings, settings.claudeSettings);
    return {
      settings: claudeSettings as Options['settings'],
      // Claude Code launched through the SDK starts in `default` whatever the
      // settings' defaultMode says, so the mode also goes as an option: the
      // merged one, so the override's defaultMode still wins.
      // TODO: undecided: as a launch option the mode also beats
      // claudeSettings' permissions.disableAutoMode: with the mode `auto` and
      // disableAutoMode set to "disable", Claude Code still starts in auto.
      // No route was found that gives Claude Code the mode and still lets
      // that setting refuse it.
      permissionMode: claudeSettings.permissions.defaultMode,
      // Nothing answers a permission prompt: whatever the mode, rules and
      // hooks don't allow is denied, and Claude Code is told why.
      permissionPrompts: 'none',
      // An interrupt (a cancel) stops the turn and its foreground subagents
      // and leaves background tasks running. Shutdown stops those one by one.
      perTaskStopAffordance: true,
      // TODO: undecided: Claude Code's settings can't carry effort `max`, per
      // model in modelSettings included (both drop it), so
      // a declared `max` goes as a launch option, and then it beats the
      // override's effortLevel and modelSettings. Nothing lower than the
      // settings can carry it.
      ...(settings.model.effort === 'max' ? { effort: 'max' as const } : {}),
      // The display has no settings key: without the flag Claude Code asks
      // for a display that returns no summary. Whether thinking is on at all
      // comes from the settings' alwaysThinkingEnabled.
      extraArgs: { 'thinking-display': settings.model.thinkingDisplay },
      systemPrompt: systemPrompt(settings.system),
      // No settings files and no CLAUDE.md: everything Claude Code runs with
      // is declared over the control lines.
      settingSources: [],
      cwd: request.cwd,
      additionalDirectories: [...request.additionalDirectories],
      // The inherited environment has Claude Code's configuration variables
      // stripped (startup.ts): several rank above the settings and would
      // replace a required value.
      env: {
        ...this.config.inheritedEnv,
        CLAUDE_CONFIG_DIR: this.config.configDir,
        // Max tokens has no settings key of its own. The override can still
        // set it through its `env`, which Claude Code ranks above this.
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(settings.model.maxTokens),
      },
      ...(request.resume ? { resume: request.id } : { sessionId: request.id }),
      sessionStore: this.sessionStore,
      sessionStoreFlush: 'eager',
      spawnClaudeCodeProcess: (options) => {
        const child = this.spawner.spawn(options);
        claudeCodeProcess.started(child);
        return child;
      },
    };
  }
}
