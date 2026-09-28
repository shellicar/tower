import { describe, expect, it } from 'vitest';
import { ClaudeCodeSpawner } from '../src/ClaudeCodeSpawner.js';
import { contextBlock } from '../src/Conversation.js';
import { ConversationLauncher, type LaunchRequest, NotConfiguredError } from '../src/ConversationLauncher.js';
import { PublishingSessionStore } from '../src/SessionStore.js';
import { CONFIGURED, testServices } from './support.js';

const ID = '0f8b7c1e-2a4d-4e6f-9b1a-3c5d7e9f1a2b';
const FRESH: LaunchRequest = { id: ID, cwd: '/work/project', additionalDirectories: ['/work/shared'], resume: false };
const RESUME: LaunchRequest = { ...FRESH, resume: true };

function launched(lines: unknown[], request: LaunchRequest = FRESH) {
  const services = testServices();
  services.control(...lines);
  const conversation = services.provider.resolve(ConversationLauncher).launch(request);
  const launch = services.claudeCode.launches[0];
  if (launch === undefined) {
    throw new Error('nothing was launched');
  }
  return { ...services, conversation, launch, options: launch.options };
}

/** The settings object Claude Code would be launched with. */
function settingsOf(lines: unknown[]): Record<string, unknown> {
  return launched(lines).options.settings as Record<string, unknown>;
}

describe('ConversationLauncher', () => {
  describe('before it is configured', () => {
    it('refuses to launch', () => {
      const services = testServices();
      expect(() => services.provider.resolve(ConversationLauncher).launch(FRESH)).toThrow(NotConfiguredError);
    });

    it('names what is missing', () => {
      const services = testServices();
      services.control(...CONFIGURED.slice(0, 2));
      expect(() => services.provider.resolve(ConversationLauncher).launch(FRESH)).toThrow('not configured: permissionMode not set');
    });

    it('starts no Claude Code', () => {
      const services = testServices();
      try {
        services.provider.resolve(ConversationLauncher).launch(FRESH);
      } catch {
        // expected
      }
      expect(services.claudeCode.launches).toEqual([]);
    });
  });

  describe('isolation', () => {
    it('loads no settings files', () => {
      expect(launched(CONFIGURED).options.settingSources).toEqual([]);
    });

    it('runs Claude Code with the agent config dir', () => {
      expect(launched(CONFIGURED).options.env?.CLAUDE_CONFIG_DIR).toBe('/agents/alpha/config');
    });

    it('passes the inherited environment through', () => {
      expect(launched(CONFIGURED).options.env?.LANG).toBe('C.UTF-8');
    });

    it('leaves the login dir to the spawn hook', () => {
      expect(launched(CONFIGURED).options.env?.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();
    });
  });

  describe('the model line, as the settings baseline', () => {
    it('sets the model in the settings', () => {
      expect(settingsOf(CONFIGURED).model).toBe('claude-sonnet-5');
    });

    it('passes no model option, which would outrank the settings', () => {
      expect(launched(CONFIGURED).options.model).toBeUndefined();
    });

    it('sets the effort in the settings', () => {
      expect(settingsOf(CONFIGURED).effortLevel).toBe('medium');
    });

    it('passes no effort option, which would outrank the settings', () => {
      expect(launched(CONFIGURED).options.effort).toBeUndefined();
    });

    it('turns thinking on in the settings', () => {
      expect(settingsOf(CONFIGURED).alwaysThinkingEnabled).toBe(true);
    });

    it('turns thinking off in the settings', () => {
      expect(settingsOf([...CONFIGURED, { model: { thinking: 'disabled' } }]).alwaysThinkingEnabled).toBe(false);
    });

    it('passes no thinking option, which would outrank the settings', () => {
      expect(launched(CONFIGURED).options.thinking).toBeUndefined();
    });

    it('declares the thinking display, which has no settings key', () => {
      expect(launched(CONFIGURED).options.extraArgs).toEqual({ 'thinking-display': 'summarized' });
    });

    it('declares the thinking display when thinking is off too', () => {
      expect(launched([...CONFIGURED, { model: { thinking: 'disabled' } }]).options.extraArgs).toEqual({ 'thinking-display': 'summarized' });
    });

    it('sends max tokens through the environment', () => {
      expect(launched(CONFIGURED).options.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('32000');
    });
  });

  describe('effort max, which the settings cannot carry', () => {
    it('leaves effortLevel out of the settings', () => {
      expect(settingsOf([...CONFIGURED, { model: { effort: 'max' } }]).effortLevel).toBeUndefined();
    });

    it('passes max as the effort option', () => {
      expect(launched([...CONFIGURED, { model: { effort: 'max' } }]).options.effort).toBe('max');
    });
  });

  describe('the system line', () => {
    it('sends the preset alone', () => {
      expect(launched(CONFIGURED).options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code' });
    });

    it('sends own text after the preset', () => {
      expect(launched([...CONFIGURED, { system: { preset: true, text: 'Be terse.' } }]).options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: 'Be terse.' });
    });

    it('sends own text on its own', () => {
      expect(launched([...CONFIGURED, { system: { preset: false, text: 'Be terse.' } }]).options.systemPrompt).toBe('Be terse.');
    });
  });

  describe('permission mode', () => {
    it('is in the settings', () => {
      expect(settingsOf(CONFIGURED).permissions).toEqual({ defaultMode: 'auto' });
    });

    it('is passed as its own option too', () => {
      expect(launched(CONFIGURED).options.permissionMode).toBe('auto');
    });

    it('is the one claudeSettings sets, when it sets one', () => {
      expect(launched([...CONFIGURED, { claudeSettings: { permissions: { defaultMode: 'plan' } } }]).options.permissionMode).toBe('plan');
    });
  });

  describe('claudeSettings over the required values', () => {
    it('replaces the model', () => {
      expect(settingsOf([...CONFIGURED, { claudeSettings: { model: 'claude-haiku-4-5' } }]).model).toBe('claude-haiku-4-5');
    });

    it('replaces the effort', () => {
      expect(settingsOf([...CONFIGURED, { claudeSettings: { effortLevel: 'high' } }]).effortLevel).toBe('high');
    });

    it('passes per-model effort through for Claude Code to resolve', () => {
      expect(settingsOf([...CONFIGURED, { claudeSettings: { modelSettings: { 'claude-sonnet-5': { effortLevel: 'high' } } } }]).modelSettings).toEqual({ 'claude-sonnet-5': { effortLevel: 'high' } });
    });

    it('replaces whether thinking is on', () => {
      expect(settingsOf([...CONFIGURED, { claudeSettings: { alwaysThinkingEnabled: false } }]).alwaysThinkingEnabled).toBe(false);
    });

    it('passes env through for Claude Code to rank above its environment', () => {
      expect(settingsOf([...CONFIGURED, { claudeSettings: { env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '1500' } } }]).env).toEqual({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: '1500' });
    });

    it('keeps the declared permissions it does not set', () => {
      expect(settingsOf([...CONFIGURED, { claudeSettings: { permissions: { allow: ['Read'] } } }]).permissions).toEqual({ defaultMode: 'auto', allow: ['Read'] });
    });

    it('turns connectors back on', () => {
      expect(settingsOf([...CONFIGURED, { claudeSettings: { disableClaudeAiConnectors: false } }]).disableClaudeAiConnectors).toBe(false);
    });
  });

  describe('settings', () => {
    it('carries the required values as the baseline', () => {
      expect(launched(CONFIGURED).options.settings).toEqual({ model: 'claude-sonnet-5', effortLevel: 'medium', alwaysThinkingEnabled: true, disableClaudeAiConnectors: true, permissions: { defaultMode: 'auto' } });
    });
  });

  describe('a new conversation', () => {
    it('uses the conversation id as the session id', () => {
      expect(launched(CONFIGURED).options.sessionId).toBe(ID);
    });

    it('is not a resume', () => {
      expect(launched(CONFIGURED).options.resume).toBeUndefined();
    });

    it('runs in the requested cwd', () => {
      expect(launched(CONFIGURED).options.cwd).toBe('/work/project');
    });

    it('adds the requested directories', () => {
      expect(launched(CONFIGURED).options.additionalDirectories).toEqual(['/work/shared']);
    });
  });

  describe('a resumed conversation', () => {
    it('resumes the conversation id', () => {
      expect(launched(CONFIGURED, RESUME).options.resume).toBe(ID);
    });

    it('sets no new session id', () => {
      expect(launched(CONFIGURED, RESUME).options.sessionId).toBeUndefined();
    });

    it('adds the requested directories again', () => {
      expect(launched(CONFIGURED, RESUME).options.additionalDirectories).toEqual(['/work/shared']);
    });
  });

  describe('the session store', () => {
    it('is the participant store', () => {
      const { options, provider } = launched(CONFIGURED);
      expect(options.sessionStore).toBe(provider.resolve(PublishingSessionStore));
    });

    it('is flushed eagerly', () => {
      expect(launched(CONFIGURED).options.sessionStoreFlush).toBe('eager');
    });
  });

  describe('spawning', () => {
    it('goes through the participant spawner', () => {
      const { options, processes } = launched(CONFIGURED);
      options.spawnClaudeCodeProcess?.({ command: '/sdk/claude', args: [], cwd: '/work/project', env: {}, signal: new AbortController().signal });
      expect(processes.spawns[0]?.args).toContain('/sdk/claude');
    });

    it('is the spawner the container holds', () => {
      const { provider } = launched(CONFIGURED);
      expect(provider.resolve(ClaudeCodeSpawner)).toBeInstanceOf(ClaudeCodeSpawner);
    });
  });

  describe('values are fixed at launch', () => {
    it('keeps a launched conversation on the model it started with', () => {
      const services = testServices();
      services.control(...CONFIGURED);
      services.provider.resolve(ConversationLauncher).launch(FRESH);
      services.control({ model: { name: 'claude-opus-5-5' } });
      expect((services.claudeCode.launches[0]?.options.settings as Record<string, unknown> | undefined)?.model).toBe('claude-sonnet-5');
    });
  });

  describe('context', () => {
    it('is built into the first message of a new conversation', async () => {
      const { conversation, launch } = launched([...CONFIGURED, { context: 'The fleet is small.' }]);
      conversation.send('hello');
      conversation.close();
      await launch.done;
      expect(launch.sent[0]?.message.content).toEqual([
        { type: 'text', text: '<system-reminder>\nThe fleet is small.\n</system-reminder>\n\n' },
        { type: 'text', text: 'hello' },
      ]);
    });

    it('is not repeated on later messages', async () => {
      const { conversation, launch } = launched([...CONFIGURED, { context: 'The fleet is small.' }]);
      conversation.send('one');
      conversation.send('two');
      conversation.close();
      await launch.done;
      expect(launch.sent[1]?.message.content).toEqual([{ type: 'text', text: 'two' }]);
    });

    it('is not added to a resumed conversation', async () => {
      const { conversation, launch } = launched([...CONFIGURED, { context: 'The fleet is small.' }], RESUME);
      conversation.send('hello');
      conversation.close();
      await launch.done;
      expect(launch.sent[0]?.message.content).toEqual([{ type: 'text', text: 'hello' }]);
    });

    it('is left out when none is set', async () => {
      const { conversation, launch } = launched(CONFIGURED);
      conversation.send('hello');
      conversation.close();
      await launch.done;
      expect(launch.sent[0]?.message.content).toEqual([{ type: 'text', text: 'hello' }]);
    });

    it('is wrapped as a system reminder', () => {
      expect(contextBlock('x')).toBe('<system-reminder>\nx\n</system-reminder>\n\n');
    });
  });

  describe('sending', () => {
    it('refuses a message after the input is closed', () => {
      const { conversation } = launched(CONFIGURED);
      conversation.close();
      expect(() => conversation.send('late')).toThrow('channel is closed');
    });
  });
});
