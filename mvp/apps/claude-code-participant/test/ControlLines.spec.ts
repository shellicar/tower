import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ControlLines, runControlLines } from '../src/ControlLines.js';
import { CONFIGURED, testServices } from './support.js';

const FULL_MODEL = { name: 'claude-sonnet-5', maxTokens: 32000, thinking: 'adaptive', thinkingDisplay: 'summarized', effort: 'medium' };

type ReadBack = { settings: Record<string, unknown> };

describe('control lines', () => {
  describe('transport', () => {
    it('answers a line that is not JSON', () => {
      expect(testServices().control('{nope')).toEqual([{ error: 'unparseable' }]);
    });

    it('answers a line with no known key', () => {
      expect(testServices().control({ spawn: {} })).toEqual([{ error: 'unsupported' }]);
    });

    it('answers an empty object', () => {
      expect(testServices().control({})).toEqual([{ error: 'unsupported' }]);
    });

    it('answers JSON that is not an object', () => {
      expect(testServices().control('[1]')).toEqual([{ error: 'unsupported' }]);
    });

    it('answers a blank line', () => {
      expect(testServices().control('   ')).toEqual([{ error: 'unparseable' }]);
    });

    it('rejects a line carrying more than one key', () => {
      expect(testServices().control({ model: {}, system: { preset: true } })).toEqual([{ error: 'a control line carries exactly one key; this one carries model, system' }]);
    });

    it('applies nothing from a line carrying more than one key', () => {
      const [, reply] = testServices().control({ permissionMode: 'auto', context: 'x' }, { settings: {} });
      expect((reply as ReadBack).settings.permissionMode).toBeNull();
    });

    it('writes one reply line per line read, blank lines included', async () => {
      const { provider } = testServices();
      const input = new PassThrough();
      const written: string[] = [];
      const output = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          written.push(chunk.toString());
          callback();
        },
      });
      input.end('{"permissionMode":"auto"}\n\n{nope\n');
      await runControlLines(input, output, provider.resolve(ControlLines));
      expect(written.join('')).toBe('{"permissionMode":"auto"}\n{"error":"unparseable"}\n{"error":"unparseable"}\n');
    });
  });

  describe('model', () => {
    it('echoes the whole cell', () => {
      expect(testServices().control({ model: FULL_MODEL })).toEqual([{ model: FULL_MODEL }]);
    });

    it('merges into what is held', () => {
      const [, reply] = testServices().control({ model: FULL_MODEL }, { model: { effort: 'low' } });
      expect(reply).toEqual({ model: { ...FULL_MODEL, effort: 'low' } });
    });

    it('clears a field sent as null', () => {
      const [, reply] = testServices().control({ model: FULL_MODEL }, { model: { effort: null } });
      expect(reply).toEqual({ model: { name: 'claude-sonnet-5', maxTokens: 32000, thinking: 'adaptive', thinkingDisplay: 'summarized' } });
    });

    it('rejects an unknown field', () => {
      expect(testServices().control({ model: { budgetTokens: 1 } })).toEqual([{ error: 'invalid model: Unrecognized key: "budgetTokens"' }]);
    });

    it('leaves the cell as it was when a line is rejected', () => {
      const [, , reply] = testServices().control({ model: { name: 'claude-sonnet-5' } }, { model: { name: 'x', maxTokens: 0 } }, { settings: {} });
      expect((reply as ReadBack).settings.model).toEqual({ name: 'claude-sonnet-5' });
    });

    it('rejects maxTokens below one', () => {
      expect(testServices().control({ model: { maxTokens: 0 } })).toEqual([{ error: 'invalid model: maxTokens: Too small: expected number to be >=1' }]);
    });

    it('rejects maxTokens that is not a whole number', () => {
      expect(testServices().control({ model: { maxTokens: 1.5 } })).toEqual([{ error: 'invalid model: maxTokens: Invalid input: expected int, received number' }]);
    });

    it('rejects a thinking type it does not know', () => {
      expect(testServices().control({ model: { thinking: 'enabled' } })).toEqual([{ error: 'invalid model: thinking: Invalid option: expected one of "adaptive"|"disabled"' }]);
    });

    it('rejects an effort it does not know', () => {
      expect(testServices().control({ model: { effort: 'extreme' } })).toEqual([{ error: 'invalid model: effort: Invalid option: expected one of "low"|"medium"|"high"|"xhigh"|"max"' }]);
    });

    it('rejects a line that is not an object', () => {
      expect(testServices().control({ model: 'claude-sonnet-5' })).toEqual([{ error: 'invalid model: Invalid input: expected object, received string' }]);
    });
  });

  describe('system', () => {
    it('is set', () => {
      expect(testServices().control({ system: { preset: false, text: 'You are terse.' } })).toEqual([{ system: 'set' }]);
    });

    it('requires preset', () => {
      expect(testServices().control({ system: { text: 'You are terse.' } })).toEqual([{ error: 'invalid system: preset: Invalid input: expected boolean, received undefined' }]);
    });

    it('rejects an unknown field', () => {
      expect(testServices().control({ system: { preset: true, name: 'claude_code' } })).toEqual([{ error: 'invalid system: Unrecognized key: "name"' }]);
    });

    it('is cleared by null', () => {
      const [, , reply] = testServices().control({ system: { preset: true } }, { system: null }, { settings: {} });
      expect((reply as ReadBack).settings.system).toBeNull();
    });
  });

  describe('permissionMode', () => {
    it('echoes the mode', () => {
      expect(testServices().control({ permissionMode: 'plan' })).toEqual([{ permissionMode: 'plan' }]);
    });

    it('rejects a mode it does not know', () => {
      expect(testServices().control({ permissionMode: 'yolo' })).toEqual([{ error: 'invalid permissionMode: Invalid option: expected one of "default"|"acceptEdits"|"bypassPermissions"|"plan"|"dontAsk"|"auto"' }]);
    });
  });

  describe('context', () => {
    it('is set', () => {
      expect(testServices().control({ context: 'The fleet is small.' })).toEqual([{ context: 'set' }]);
    });

    it('rejects anything but a string', () => {
      expect(testServices().control({ context: 3 })).toEqual([{ error: 'invalid context: Invalid input: expected string, received number' }]);
    });
  });

  describe('claudeSettings', () => {
    it('is set', () => {
      expect(testServices().control({ claudeSettings: { advisorModel: 'claude-opus-5-5' } })).toEqual([{ claudeSettings: 'set' }]);
    });

    it('passes keys it does not model through unchanged', () => {
      const sent = { advisorModel: 'm', permissions: { allow: ['Read'], deny: [] }, statusLine: null, env: { A: '1' } };
      const [, reply] = testServices().control({ claudeSettings: sent }, { settings: {} });
      expect((reply as ReadBack).settings.claudeSettings).toEqual(sent);
    });

    it('replaces the whole value, arrays included', () => {
      const [, , reply] = testServices().control({ claudeSettings: { permissions: { allow: ['Read', 'Bash'] }, advisorModel: 'm' } }, { claudeSettings: { permissions: { allow: ['Read'] } } }, { settings: {} });
      expect((reply as ReadBack).settings.claudeSettings).toEqual({ permissions: { allow: ['Read'] } });
    });

    it('is cleared by null', () => {
      const [, , reply] = testServices().control({ claudeSettings: { advisorModel: 'm' } }, { claudeSettings: null }, { settings: {} });
      expect((reply as ReadBack).settings.claudeSettings).toBeNull();
    });

    it('rejects permissions that are not an object', () => {
      expect(testServices().control({ claudeSettings: { permissions: ['Bash'] } })).toEqual([{ error: 'invalid claudeSettings: permissions: Invalid input: expected object, received array' }]);
    });

    it('rejects a line that is not an object', () => {
      expect(testServices().control({ claudeSettings: 'x' })).toEqual([{ error: 'invalid claudeSettings: Invalid input: expected object, received string' }]);
    });

    it('rejects a model that is not a string', () => {
      expect(testServices().control({ claudeSettings: { model: 5 } })).toEqual([{ error: 'invalid claudeSettings: model: Invalid input: expected string, received number' }]);
    });

    it('rejects an effortLevel the settings cannot carry', () => {
      expect(testServices().control({ claudeSettings: { effortLevel: 'max' } })).toEqual([{ error: 'invalid claudeSettings: effortLevel: Invalid option: expected one of "low"|"medium"|"high"|"xhigh"' }]);
    });

    it('rejects an alwaysThinkingEnabled that is not a boolean', () => {
      expect(testServices().control({ claudeSettings: { alwaysThinkingEnabled: 'no' } })).toEqual([{ error: 'invalid claudeSettings: alwaysThinkingEnabled: Invalid input: expected boolean, received string' }]);
    });

    it('rejects a defaultMode it does not know', () => {
      expect(testServices().control({ claudeSettings: { permissions: { defaultMode: 'yolo' } } })).toEqual([{ error: 'invalid claudeSettings: permissions.defaultMode: Invalid option: expected one of "default"|"acceptEdits"|"bypassPermissions"|"plan"|"dontAsk"|"auto"' }]);
    });
  });

  describe('settings', () => {
    it('rejects a key in its body', () => {
      expect(testServices().control({ settings: { include: ['system'] } })).toEqual([{ error: 'invalid settings: Unrecognized key: "include"' }]);
    });

    it('lists every required value before anything is set', () => {
      const [reply] = testServices().control({ settings: {} });
      expect((reply as ReadBack).settings.missing).toEqual(['model.name', 'model.maxTokens', 'model.thinking', 'model.thinkingDisplay', 'model.effort', 'system', 'permissionMode']);
    });

    it('lists nothing missing once configured', () => {
      const replies = testServices().control(...CONFIGURED, { settings: {} });
      expect((replies.at(-1) as ReadBack).settings.missing).toEqual([]);
    });

    it('reads back what the control lines hold and the fixed config', () => {
      const replies = testServices().control(...CONFIGURED, { context: 'ctx' }, { claudeSettings: { advisorModel: 'm' } }, { settings: {} });
      expect(replies.at(-1)).toEqual({
        settings: {
          model: FULL_MODEL,
          system: { preset: true },
          permissionMode: 'auto',
          context: 'ctx',
          claudeSettings: { advisorModel: 'm' },
          missing: [],
          agent: 'alpha',
          configDir: '/agents/alpha/config',
          privateHome: '/tmp/tower-participant-home-abc123',
          setpriv: '/usr/bin/setpriv',
        },
      });
    });
  });
});
