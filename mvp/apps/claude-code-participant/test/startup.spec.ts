import { describe, expect, it } from 'vitest';
import { readStartup, StartupError } from '../src/startup.js';

const complete = {
  NATS_URL: 'nats://127.0.0.1:31416',
  PARTICIPANT_CONFIG_DIR: '/agents/alpha/config',
  PARTICIPANT_AGENT: 'alpha',
  HOME: '/home/someone',
  PATH: '/usr/bin',
};

describe('readStartup', () => {
  describe('NATS_URL', () => {
    it('refuses to start without it', () => {
      const { NATS_URL: _, ...env } = complete;
      expect(() => readStartup(env)).toThrow(StartupError);
    });

    it('refuses to start when it is empty', () => {
      expect(() => readStartup({ ...complete, NATS_URL: '' })).toThrow('NATS_URL is required');
    });

    it('is read as given', () => {
      expect(readStartup(complete).natsUrl).toBe('nats://127.0.0.1:31416');
    });
  });

  describe('PARTICIPANT_CONFIG_DIR', () => {
    it('refuses to start without it', () => {
      const { PARTICIPANT_CONFIG_DIR: _, ...env } = complete;
      expect(() => readStartup(env)).toThrow('PARTICIPANT_CONFIG_DIR is required');
    });

    it('refuses a relative path', () => {
      expect(() => readStartup({ ...complete, PARTICIPANT_CONFIG_DIR: 'agents/alpha' })).toThrow('PARTICIPANT_CONFIG_DIR must be an absolute path');
    });

    it('is the config dir', () => {
      expect(readStartup(complete).configDir).toBe('/agents/alpha/config');
    });
  });

  describe('PARTICIPANT_AGENT', () => {
    it('refuses to start without it', () => {
      const { PARTICIPANT_AGENT: _, ...env } = complete;
      expect(() => readStartup(env)).toThrow('PARTICIPANT_AGENT is required');
    });

    it('is the agent', () => {
      expect(readStartup(complete).agent).toBe('alpha');
    });
  });

  describe('HOME', () => {
    it('refuses to start without it', () => {
      const { HOME: _, ...env } = complete;
      expect(() => readStartup(env)).toThrow('HOME is required');
    });

    it('refuses a relative path', () => {
      expect(() => readStartup({ ...complete, HOME: 'someone' })).toThrow('HOME must be an absolute path');
    });

    it('is the real home', () => {
      expect(readStartup(complete).realHome).toBe('/home/someone');
    });
  });

  describe('inherited environment', () => {
    it('drops the parent Claude Code session variables', () => {
      const actual = readStartup({ ...complete, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_CODE_ENTRYPOINT: 'cli', AI_AGENT: 'claude' }).inheritedEnv;
      expect(Object.keys(actual).filter((name) => name.startsWith('CLAUDE') || name === 'AI_AGENT')).toEqual([]);
    });

    it('passes the rest through', () => {
      expect(readStartup({ ...complete, LANG: 'C.UTF-8' }).inheritedEnv.LANG).toBe('C.UTF-8');
    });

    it('drops a model set in the environment', () => {
      expect(readStartup({ ...complete, ANTHROPIC_MODEL: 'claude-haiku-4-5' }).inheritedEnv.ANTHROPIC_MODEL).toBeUndefined();
    });

    it('drops an effort set in the environment', () => {
      expect(readStartup({ ...complete, CLAUDE_CODE_EFFORT_LEVEL: 'medium' }).inheritedEnv.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
    });

    it('drops every Claude Code variable that changes a required value', () => {
      const configuration = {
        ANTHROPIC_DEFAULT_MODEL: 'x',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'x',
        CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP: '1',
        CLAUDE_CODE_MODEL_CAPABILITIES: 'x',
        ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES: 'x',
        CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: '1',
        CLAUDE_CODE_DISABLE_THINKING: '1',
        CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: '1',
        MAX_THINKING_TOKENS: '1024',
        DISABLE_INTERLEAVED_THINKING: '1',
        CLAUDE_CODE_THINKING_DISPLAY_UPDATES: '0',
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: '100',
        CLAUDE_CODE_EXTRA_BODY: '{}',
        CLAUDE_CODE_SIMPLE: '1',
        CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT: '1',
        CLAUDE_CODE_ENABLE_AUTO_MODE: '1',
        CLAUDE_CODE_PLAN_MODE_REQUIRED: '1',
      };
      expect(Object.keys(readStartup({ ...complete, ...configuration }).inheritedEnv).filter((name) => name in configuration)).toEqual([]);
    });

    it('keeps variables that configure something other than a required value', () => {
      expect(readStartup({ ...complete, ANTHROPIC_SMALL_FAST_MODEL: 'claude-haiku-4-5' }).inheritedEnv.ANTHROPIC_SMALL_FAST_MODEL).toBe('claude-haiku-4-5');
    });
  });
});
