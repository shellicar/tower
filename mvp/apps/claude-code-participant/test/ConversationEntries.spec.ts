import { describe, expect, it } from 'vitest';
import { classify, contentBlocksOf, isPrompt, type RecordEntry, roleOf } from '../src/ConversationEntries.js';
import { AI_TITLE, ANSWER, API_ERROR, COMPACT_BOUNDARY, COMPACT_SUMMARY, DATE_ATTACHMENT, ENVIRONMENT_ATTACHMENT, HAND_BACK, IMAGE_TOOL_RESULT, INTERRUPT_MARKER, NO_RESPONSE_REQUESTED, PARTIAL_REPLY, PROMPT, QUEUE_OPERATION, TASK_NOTICE, THINKING, TOKENS_REMINDER, TOOL_USE, TURN_FINISHED } from './entries.js';

function classified(entry: RecordEntry, preserved: Record<string, string[]> = {}) {
  return classify(entry, { preservedBy: (uuid) => preserved[uuid] });
}

function userText(text: unknown, fields: Record<string, unknown> = {}) {
  return { type: 'user', uuid: 'u1', message: { role: 'user', content: text }, ...fields };
}

describe('roleOf', () => {
  it('publishes a prompt as user', () => {
    expect(roleOf(PROMPT)).toBe('user');
  });

  it('publishes a thinking piece as assistant', () => {
    expect(roleOf(THINKING)).toBe('assistant');
  });

  it('publishes a tool call as assistant', () => {
    expect(roleOf(TOOL_USE)).toBe('assistant');
  });

  it('publishes a text piece as assistant', () => {
    expect(roleOf(ANSWER)).toBe('assistant');
  });

  it('publishes a reply cut short by an interrupt as assistant', () => {
    expect(roleOf(PARTIAL_REPLY)).toBe('assistant');
  });

  it('publishes a tool result as user', () => {
    expect(roleOf(IMAGE_TOOL_RESULT)).toBe('user');
  });

  it("publishes an interrupted tool call's result as user", () => {
    expect(roleOf(userText([{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: '[Request interrupted by user for tool use]' }]))).toBe('user');
  });

  it('publishes a system entry as system', () => {
    expect(roleOf({ type: 'system', subtype: 'compact_boundary', uuid: 's1', content: 'Conversation compacted' })).toBe('system');
  });

  it('publishes an interrupt marker as user', () => {
    expect(roleOf(INTERRUPT_MARKER)).toBe('user');
  });

  it('leaves out other isMeta text', () => {
    expect(roleOf(userText('Continue from where you left off.', { isMeta: true }))).toBeUndefined();
  });

  it('leaves out an attachment with no rendered form', () => {
    expect(roleOf(TOKENS_REMINDER)).toBeUndefined();
  });

  it('leaves out bookkeeping with no uuid', () => {
    expect(roleOf(QUEUE_OPERATION)).toBeUndefined();
  });

  it('leaves out bookkeeping of another kind', () => {
    expect(roleOf(AI_TITLE)).toBeUndefined();
  });

  it("leaves out a subagent's sidechain", () => {
    expect(roleOf({ ...ANSWER, isSidechain: true })).toBeUndefined();
  });

  it('publishes a prompt that only starts like a marker further in', () => {
    expect(roleOf(userText('Why did I see [Request interrupted by user]?'))).toBe('user');
  });
});

describe('classify', () => {
  describe('a prompt', () => {
    it('has no extras', () => {
      expect(classified(PROMPT)).toEqual({ role: 'user' });
    });
  });

  describe('a reminder', () => {
    it('is published as its rendered text, in the rendered role', () => {
      expect(classified(DATE_ATTACHMENT)).toMatchObject({ role: 'system', content: [{ type: 'text', text: "<system-reminder>\nToday's date is 2026-10-01.\n</system-reminder>" }] });
    });

    it('is seen by the model and not the person', () => {
      expect(classified(ENVIRONMENT_ATTACHMENT)?.extras).toEqual({ audience: { model: true, user: false }, at: '2026-10-02T16:43:26.877Z' });
    });
  });

  describe('a task-finished notice', () => {
    it('is from the orchestrator', () => {
      expect(classified(TASK_NOTICE)?.from).toEqual({ kind: 'orchestrator' });
    });

    it('is shown to the person as its summary line', () => {
      expect(classified(TASK_NOTICE)?.extras?.userContent).toEqual([{ type: 'text', text: 'Background command "Run background sleep and echo" completed (exit code 0)' }]);
    });

    it('adds the duration to the summary line when the notice has one', () => {
      const withUsage = { ...TASK_NOTICE, message: { role: 'user', content: '<task-notification><summary>Agent "reviewer" finished</summary><usage><duration_ms>39000</duration_ms></usage></task-notification>' } };
      expect(classified(withUsage)?.extras?.userContent).toEqual([{ type: 'text', text: 'Agent "reviewer" finished · 39s' }]);
    });

    it('is not a prompt, so it does not take the say’s from', () => {
      expect(isPrompt(TASK_NOTICE)).toBe(false);
    });
  });

  describe('a subagent hand-back', () => {
    it('is user text from an agent, seen by both', () => {
      expect(classified(HAND_BACK)).toEqual({ role: 'user', from: { kind: 'agent' }, extras: { audience: { model: true, user: true }, at: '2026-10-03T04:22:40.731Z' } });
    });
  });

  describe('an interrupt marker', () => {
    it('is shown to the person as an interruption', () => {
      expect(classified(INTERRUPT_MARKER)?.extras?.userContent).toEqual([{ type: 'text', text: 'Interrupted · What should Claude do instead?' }]);
    });

    it('keeps the stored text for the model', () => {
      expect(classified(INTERRUPT_MARKER)?.content).toBeUndefined();
    });

    it('is seen by the model only when it marks a skipped tool call', () => {
      expect(classified(userText('[Tool call skipped: the turn ended to deliver the message that follows before this call ran. Nothing refused it; re-run it if still needed.]'))?.extras?.audience).toEqual({ model: true, user: false });
    });
  });

  describe('a compaction', () => {
    it('publishes the boundary to the person only', () => {
      expect(classified(COMPACT_BOUNDARY)?.extras?.audience).toEqual({ model: false, user: true });
    });

    it('publishes the summary with a scope that keeps what the boundary kept', () => {
      expect(classified(COMPACT_SUMMARY, { [COMPACT_BOUNDARY.uuid as string]: ['2dde7688-fff7-4af9-ab6b-5220712f1002'] })?.extras?.scope).toEqual({ replaces: 'before', except: ['2dde7688-fff7-4af9-ab6b-5220712f1002'] });
    });

    it('publishes the summary with nothing kept when its boundary is unknown', () => {
      expect(classified(COMPACT_SUMMARY)?.extras?.scope).toEqual({ replaces: 'before', except: [] });
    });

    it('is not a prompt', () => {
      expect(isPrompt(COMPACT_SUMMARY)).toBe(false);
    });
  });

  describe('the turn-finished line', () => {
    it('is user-only text with the turn’s duration, and its end time as `at`', () => {
      expect(classified(TURN_FINISHED)).toEqual({
        role: 'system',
        content: [{ type: 'text', text: 'Worked for 2s' }],
        extras: { audience: { model: false, user: true }, at: '2026-10-03T04:22:44.187Z' },
      });
    });

    it('writes no clock reading into the text', () => {
      expect(classified({ ...TURN_FINISHED, timestamp: '2026-10-02T04:22:44.187Z' })?.content).toEqual([{ type: 'text', text: 'Worked for 2s' }]);
    });

    it('reads a duration in minutes', () => {
      expect(classified({ ...TURN_FINISHED, durationMs: 65000 })?.content).toEqual([{ type: 'text', text: 'Worked for 1m 5s' }]);
    });

    it('says only that the turn worked when the entry has no duration', () => {
      expect(classified({ ...TURN_FINISHED, durationMs: undefined })?.content).toEqual([{ type: 'text', text: 'Worked' }]);
    });
  });

  describe('the entry’s own time', () => {
    it('is published in UTC whatever offset the entry wrote', () => {
      expect(classified({ ...TURN_FINISHED, timestamp: '2026-10-03T14:22:44.187+10:00' })?.extras?.at).toBe('2026-10-03T04:22:44.187Z');
    });

    it('is left out when the entry’s timestamp does not parse', () => {
      expect(classified({ ...TURN_FINISHED, timestamp: 'yesterday' })?.extras).not.toHaveProperty('at');
    });
  });

  describe('a synthetic reply', () => {
    it('keeps "No response requested." as assistant, seen by the model only', () => {
      expect(classified(NO_RESPONSE_REQUESTED)).toMatchObject({ role: 'assistant', extras: { audience: { model: true, user: false } } });
    });

    it('publishes an API error as system, seen by the person only', () => {
      expect(classified(API_ERROR)).toMatchObject({ role: 'system', extras: { audience: { model: false, user: true } } });
    });
  });
});

describe('isPrompt', () => {
  it('is true for a prompt', () => {
    expect(isPrompt(PROMPT)).toBe(true);
  });

  it('is false for a tool result', () => {
    expect(isPrompt(IMAGE_TOOL_RESULT)).toBe(false);
  });

  it('is false for a reply', () => {
    expect(isPrompt(ANSWER)).toBe(false);
  });
});

describe('contentBlocksOf', () => {
  it("is a message's content blocks", () => {
    expect(contentBlocksOf(ANSWER)).toEqual([{ type: 'text', text: "It's red." }]);
  });

  it('makes string content one text block', () => {
    expect(contentBlocksOf(userText('hello'))).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it("makes a system entry's content one text block", () => {
    expect(contentBlocksOf({ type: 'system', uuid: 's1', content: 'Conversation compacted' })).toEqual([{ type: 'text', text: 'Conversation compacted' }]);
  });

  it('is empty for a system entry with no content', () => {
    expect(contentBlocksOf({ type: 'system', subtype: 'turn_duration', uuid: 's1', durationMs: 1200 })).toEqual([]);
  });
});
