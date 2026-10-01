import { describe, expect, it } from 'vitest';
import { contentBlocksOf, isPrompt, roleOf } from '../src/ConversationEntries.js';
import { AI_TITLE, ANSWER, DATE_ATTACHMENT, IMAGE_TOOL_RESULT, INTERRUPT_MARKER, PARTIAL_REPLY, PROMPT, QUEUE_OPERATION, THINKING, TOOL_USE } from './entries.js';

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

  it('leaves out an interrupt marker', () => {
    expect(roleOf(INTERRUPT_MARKER)).toBeUndefined();
  });

  it('leaves out a marker written as a plain string', () => {
    expect(roleOf(userText('[Request interrupted by user for tool use]'))).toBeUndefined();
  });

  it('leaves out a reminder', () => {
    expect(roleOf(userText('Continue from where you left off.', { isMeta: true }))).toBeUndefined();
  });

  it('leaves out a compaction summary', () => {
    expect(roleOf(userText('This session is being continued from a previous conversation.', { isCompactSummary: true }))).toBeUndefined();
  });

  it('leaves out an attachment', () => {
    expect(roleOf(DATE_ATTACHMENT)).toBeUndefined();
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
