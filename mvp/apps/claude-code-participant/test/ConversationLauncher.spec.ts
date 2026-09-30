import { describe, expect, it } from 'vitest';
import { ClaudeCodeSpawner } from '../src/ClaudeCodeSpawner.js';
import { contextBlock } from '../src/Conversation.js';
import { ConversationLauncher, type LaunchRequest, NotConfiguredError } from '../src/ConversationLauncher.js';
import { ServingGate } from '../src/ServingGate.js';
import { PublishingSessionStore } from '../src/SessionStore.js';
import { CONFIGURED, testConfig, testServices } from './support.js';

const ID = '0f8b7c1e-2a4d-4e6f-9b1a-3c5d7e9f1a2b';
const FRESH: LaunchRequest = { id: ID, cwd: '/work/project', additionalDirectories: ['/work/shared'], resume: false };
const RESUME: LaunchRequest = { ...FRESH, resume: true };

async function launched(lines: unknown[], request: LaunchRequest = FRESH) {
  const services = testServices();
  services.control(...lines);
  const conversation = await services.provider.resolve(ConversationLauncher).launch(request);
  const launch = services.claudeCode.launches[0];
  if (launch === undefined) {
    throw new Error('nothing was launched');
  }
  return { ...services, conversation, launch, options: launch.options };
}

/** The settings object Claude Code would be launched with. */
async function settingsOf(lines: unknown[]): Promise<Record<string, unknown>> {
  return (await launched(lines)).options.settings as Record<string, unknown>;
}

describe('ConversationLauncher', () => {
  describe('while the serving gate is shut', () => {
    /** Asks for a launch with the gate shut, and lets everything already queued run. */
    async function askedWhileShut() {
      const services = testServices(testConfig(), { gateShut: true });
      services.control(...CONFIGURED);
      const launching = services.provider.resolve(ConversationLauncher).launch(FRESH);
      await new Promise((resolve) => setImmediate(resolve));
      return { ...services, launching };
    }

    it('starts no Claude Code', async () => {
      const { claudeCode } = await askedWhileShut();
      expect(claudeCode.launches).toEqual([]);
    });

    it('starts Claude Code once the gate opens', async () => {
      const { claudeCode, provider, launching } = await askedWhileShut();
      provider.resolve(ServingGate).open();
      await launching;
      expect(claudeCode.launches).toHaveLength(1);
    });

    it('launches with the values held when the launch was asked for', async () => {
      const { claudeCode, provider, launching, control } = await askedWhileShut();
      control({ model: { name: 'claude-opus-5-5' } });
      provider.resolve(ServingGate).open();
      await launching;
      expect((claudeCode.launches[0]?.options.settings as Record<string, unknown> | undefined)?.model).toBe('claude-sonnet-5');
    });

    it('still refuses at once when it is not configured', async () => {
      const services = testServices(testConfig(), { gateShut: true });
      await expect(services.provider.resolve(ConversationLauncher).launch(FRESH)).rejects.toThrow(NotConfiguredError);
    });
  });

  describe('before it is configured', () => {
    it('refuses to launch', async () => {
      const services = testServices();
      await expect(services.provider.resolve(ConversationLauncher).launch(FRESH)).rejects.toThrow(NotConfiguredError);
    });

    it('names what is missing', async () => {
      const services = testServices();
      services.control(...CONFIGURED.slice(0, 2));
      await expect(services.provider.resolve(ConversationLauncher).launch(FRESH)).rejects.toThrow('not configured: permissionMode not set');
    });

    it('starts no Claude Code', async () => {
      const services = testServices();
      try {
        await services.provider.resolve(ConversationLauncher).launch(FRESH);
      } catch {
        // expected
      }
      expect(services.claudeCode.launches).toEqual([]);
    });
  });

  describe('isolation', () => {
    it('loads no settings files', async () => {
      expect((await launched(CONFIGURED)).options.settingSources).toEqual([]);
    });

    it('runs Claude Code with the agent config dir', async () => {
      expect((await launched(CONFIGURED)).options.env?.CLAUDE_CONFIG_DIR).toBe('/agents/alpha/config');
    });

    it('passes the inherited environment through', async () => {
      expect((await launched(CONFIGURED)).options.env?.LANG).toBe('C.UTF-8');
    });

    it('leaves the login dir to the spawn hook', async () => {
      expect((await launched(CONFIGURED)).options.env?.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();
    });
  });

  describe('the model line, as the settings baseline', () => {
    it('sets the model in the settings', async () => {
      expect((await settingsOf(CONFIGURED)).model).toBe('claude-sonnet-5');
    });

    it('passes no model option, which would outrank the settings', async () => {
      expect((await launched(CONFIGURED)).options.model).toBeUndefined();
    });

    it('sets the effort in the settings', async () => {
      expect((await settingsOf(CONFIGURED)).effortLevel).toBe('medium');
    });

    it('passes no effort option, which would outrank the settings', async () => {
      expect((await launched(CONFIGURED)).options.effort).toBeUndefined();
    });

    it('turns thinking on in the settings', async () => {
      expect((await settingsOf(CONFIGURED)).alwaysThinkingEnabled).toBe(true);
    });

    it('turns thinking off in the settings', async () => {
      expect((await settingsOf([...CONFIGURED, { model: { thinking: 'disabled' } }])).alwaysThinkingEnabled).toBe(false);
    });

    it('passes no thinking option, which would outrank the settings', async () => {
      expect((await launched(CONFIGURED)).options.thinking).toBeUndefined();
    });

    it('declares the thinking display, which has no settings key', async () => {
      expect((await launched(CONFIGURED)).options.extraArgs).toEqual({ 'thinking-display': 'summarized' });
    });

    it('declares the thinking display when thinking is off too', async () => {
      expect((await launched([...CONFIGURED, { model: { thinking: 'disabled' } }])).options.extraArgs).toEqual({ 'thinking-display': 'summarized' });
    });

    it('sends max tokens through the environment', async () => {
      expect((await launched(CONFIGURED)).options.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('32000');
    });
  });

  describe('effort max, which the settings cannot carry', () => {
    it('leaves effortLevel out of the settings', async () => {
      expect((await settingsOf([...CONFIGURED, { model: { effort: 'max' } }])).effortLevel).toBeUndefined();
    });

    it('passes max as the effort option', async () => {
      expect((await launched([...CONFIGURED, { model: { effort: 'max' } }])).options.effort).toBe('max');
    });
  });

  describe('the system line', () => {
    it('sends the preset alone', async () => {
      expect((await launched(CONFIGURED)).options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code' });
    });

    it('sends own text after the preset', async () => {
      expect((await launched([...CONFIGURED, { system: { preset: true, text: 'Be terse.' } }])).options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: 'Be terse.' });
    });

    it('sends own text on its own', async () => {
      expect((await launched([...CONFIGURED, { system: { preset: false, text: 'Be terse.' } }])).options.systemPrompt).toBe('Be terse.');
    });
  });

  describe('permission mode', () => {
    it('is in the settings', async () => {
      expect((await settingsOf(CONFIGURED)).permissions).toEqual({ defaultMode: 'auto' });
    });

    it('is passed as its own option too', async () => {
      expect((await launched(CONFIGURED)).options.permissionMode).toBe('auto');
    });

    it('is the one claudeSettings sets, when it sets one', async () => {
      expect((await launched([...CONFIGURED, { claudeSettings: { permissions: { defaultMode: 'plan' } } }])).options.permissionMode).toBe('plan');
    });
  });

  describe('permission prompts', () => {
    it('are answered by nobody', async () => {
      expect((await launched(CONFIGURED)).options.permissionPrompts).toBe('none');
    });
  });

  describe('claudeSettings over the required values', () => {
    it('replaces the model', async () => {
      expect((await settingsOf([...CONFIGURED, { claudeSettings: { model: 'claude-haiku-4-5' } }])).model).toBe('claude-haiku-4-5');
    });

    it('replaces the effort', async () => {
      expect((await settingsOf([...CONFIGURED, { claudeSettings: { effortLevel: 'high' } }])).effortLevel).toBe('high');
    });

    it('passes per-model effort through for Claude Code to resolve', async () => {
      expect((await settingsOf([...CONFIGURED, { claudeSettings: { modelSettings: { 'claude-sonnet-5': { effortLevel: 'high' } } } }])).modelSettings).toEqual({ 'claude-sonnet-5': { effortLevel: 'high' } });
    });

    it('replaces whether thinking is on', async () => {
      expect((await settingsOf([...CONFIGURED, { claudeSettings: { alwaysThinkingEnabled: false } }])).alwaysThinkingEnabled).toBe(false);
    });

    it('passes env through for Claude Code to rank above its environment', async () => {
      expect((await settingsOf([...CONFIGURED, { claudeSettings: { env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '1500' } } }])).env).toEqual({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: '1500' });
    });

    it('keeps the declared permissions it does not set', async () => {
      expect((await settingsOf([...CONFIGURED, { claudeSettings: { permissions: { allow: ['Read'] } } }])).permissions).toEqual({ defaultMode: 'auto', allow: ['Read'] });
    });

    it('turns connectors back on', async () => {
      expect((await settingsOf([...CONFIGURED, { claudeSettings: { disableClaudeAiConnectors: false } }])).disableClaudeAiConnectors).toBe(false);
    });
  });

  describe('settings', () => {
    it('carries the required values as the baseline', async () => {
      expect((await launched(CONFIGURED)).options.settings).toEqual({ model: 'claude-sonnet-5', effortLevel: 'medium', alwaysThinkingEnabled: true, disableClaudeAiConnectors: true, permissions: { defaultMode: 'auto' } });
    });
  });

  describe('a new conversation', () => {
    it('uses the conversation id as the session id', async () => {
      expect((await launched(CONFIGURED)).options.sessionId).toBe(ID);
    });

    it('is not a resume', async () => {
      expect((await launched(CONFIGURED)).options.resume).toBeUndefined();
    });

    it('runs in the requested cwd', async () => {
      expect((await launched(CONFIGURED)).options.cwd).toBe('/work/project');
    });

    it('adds the requested directories', async () => {
      expect((await launched(CONFIGURED)).options.additionalDirectories).toEqual(['/work/shared']);
    });
  });

  describe('a resumed conversation', () => {
    it('resumes the conversation id', async () => {
      expect((await launched(CONFIGURED, RESUME)).options.resume).toBe(ID);
    });

    it('sets no new session id', async () => {
      expect((await launched(CONFIGURED, RESUME)).options.sessionId).toBeUndefined();
    });

    it('adds the requested directories again', async () => {
      expect((await launched(CONFIGURED, RESUME)).options.additionalDirectories).toEqual(['/work/shared']);
    });
  });

  describe('the session store', () => {
    it('is the participant store', async () => {
      const { options, provider } = await launched(CONFIGURED);
      expect(options.sessionStore).toBe(provider.resolve(PublishingSessionStore));
    });

    it('is flushed eagerly', async () => {
      expect((await launched(CONFIGURED)).options.sessionStoreFlush).toBe('eager');
    });
  });

  describe('spawning', () => {
    it('goes through the participant spawner', async () => {
      const { options, processes } = await launched(CONFIGURED);
      options.spawnClaudeCodeProcess?.({ command: '/sdk/claude', args: [], cwd: '/work/project', env: {}, signal: new AbortController().signal });
      expect(processes.spawns[0]?.args).toContain('/sdk/claude');
    });

    it('is the spawner the container holds', async () => {
      const { provider } = await launched(CONFIGURED);
      expect(provider.resolve(ClaudeCodeSpawner)).toBeInstanceOf(ClaudeCodeSpawner);
    });
  });

  describe('values are fixed at launch', () => {
    it('keeps a launched conversation on the model it started with', async () => {
      const services = testServices();
      services.control(...CONFIGURED);
      await services.provider.resolve(ConversationLauncher).launch(FRESH);
      services.control({ model: { name: 'claude-opus-5-5' } });
      expect((services.claudeCode.launches[0]?.options.settings as Record<string, unknown> | undefined)?.model).toBe('claude-sonnet-5');
    });
  });

  describe('context', () => {
    it('is built into the first message of a new conversation', async () => {
      const { conversation, launch } = await launched([...CONFIGURED, { context: 'The fleet is small.' }]);
      conversation.send('hello');
      conversation.close();
      await launch.done;
      expect(launch.sent[0]?.message.content).toEqual([
        { type: 'text', text: '<system-reminder>\nThe fleet is small.\n</system-reminder>\n\n' },
        { type: 'text', text: 'hello' },
      ]);
    });

    it('is not repeated on later messages', async () => {
      const { conversation, launch } = await launched([...CONFIGURED, { context: 'The fleet is small.' }]);
      conversation.send('one');
      conversation.send('two');
      conversation.close();
      await launch.done;
      expect(launch.sent[1]?.message.content).toEqual([{ type: 'text', text: 'two' }]);
    });

    it('is not added to a resumed conversation', async () => {
      const { conversation, launch } = await launched([...CONFIGURED, { context: 'The fleet is small.' }], RESUME);
      conversation.send('hello');
      conversation.close();
      await launch.done;
      expect(launch.sent[0]?.message.content).toEqual([{ type: 'text', text: 'hello' }]);
    });

    it('is left out when none is set', async () => {
      const { conversation, launch } = await launched(CONFIGURED);
      conversation.send('hello');
      conversation.close();
      await launch.done;
      expect(launch.sent[0]?.message.content).toEqual([{ type: 'text', text: 'hello' }]);
    });

    it('is wrapped as a system reminder', async () => {
      expect(contextBlock('x')).toBe('<system-reminder>\nx\n</system-reminder>\n\n');
    });
  });

  describe('sending', () => {
    it('refuses a message after the input is closed', async () => {
      const { conversation } = await launched(CONFIGURED);
      conversation.close();
      expect(() => conversation.send('late')).toThrow('channel is closed');
    });
  });
});
