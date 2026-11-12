import { describe, expect, it } from 'vitest';
import { contentBlocksOf, isPrompt, kindOf, roleOf } from '../src/ConversationEntries.js';
import { AI_TITLE, ANSWER, DATE_ATTACHMENT, HANDBACK, IMAGE_TOOL_RESULT, INTERRUPT_MARKER, PARTIAL_REPLY, PROMPT, QUEUE_OPERATION, TASK_NOTIFICATION, THINKING, TOOL_USE } from './entries.js';

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

  it('does not publish an interrupt marker yet', () => {
    expect(roleOf(INTERRUPT_MARKER)).toBeUndefined();
  });

  it('does not publish a marker written as a plain string yet', () => {
    expect(roleOf(userText('[Request interrupted by user for tool use]'))).toBeUndefined();
  });

  it('does not publish a reminder yet', () => {
    expect(roleOf(userText('Continue from where you left off.', { isMeta: true }))).toBeUndefined();
  });

  it("publishes a background agent's handed-back report as user", () => {
    expect(roleOf(HANDBACK)).toBe('user');
  });

  it('does not publish a compaction summary yet', () => {
    expect(roleOf(userText('This session is being continued from a previous conversation.', { isCompactSummary: true }))).toBeUndefined();
  });

  it('does not publish an attachment yet', () => {
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

describe('kindOf', () => {
  it('is prompt for text that came in through the SDK', () => {
    expect(kindOf(PROMPT)).toBe('prompt');
  });

  it('is prompt for text Claude Code stamped with a human origin', () => {
    expect(kindOf(userText('hello', { origin: { kind: 'human' } }))).toBe('prompt');
  });

  it('is reply for a piece the model wrote', () => {
    expect(kindOf(THINKING)).toBe('reply');
  });

  it('is toolResult for a tool result', () => {
    expect(kindOf(IMAGE_TOOL_RESULT)).toBe('toolResult');
  });

  it('is claudeCodeText for an assistant entry Claude Code wrote itself', () => {
    expect(kindOf({ type: 'assistant', uuid: 'a1', message: { id: 'msg-synthetic', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'API Error: 500' }] } })).toBe('claudeCodeText');
  });

  it('is backgroundTask for the notice of a finished background task', () => {
    expect(kindOf(TASK_NOTIFICATION)).toBe('backgroundTask');
  });

  it("is backgroundAgentReport for a background agent's handed-back report", () => {
    expect(kindOf(HANDBACK)).toBe('backgroundAgentReport');
  });

  describe('a task notification', () => {
    const notice = (origin: Record<string, unknown>) => userText('<task-notification>', { origin: { kind: 'task-notification', ...origin } });

    it.each([
      ['scheduled-trigger', 'scheduledTrigger'],
      ['peer-send-message', 'peerSendMessage'],
      ['projects-relay', 'projectsRelay'],
      ['session-inbox', 'sessionInbox'],
    ])('with subkind %s is %s', (subkind, kind) => {
      expect(kindOf(notice({ subkind }))).toBe(kind);
    });

    it.each([
      ['goal-checkin', 'goalCheckin'],
      ['worker-checkin', 'workerCheckin'],
      ['artifact-changed', 'artifactEvent'],
      ['artifact-auto-react', 'artifactEvent'],
      ['artifact-watch-lifecycle', 'artifactEvent'],
    ])('with source %s is %s', (source, kind) => {
      expect(kindOf(notice({ source }))).toBe(kind);
    });

    it('is named by its subkind even when a session task produced it', () => {
      expect(kindOf(notice({ subkind: 'session-inbox', producer: 'session-task' }))).toBe('sessionInbox');
    });

    it('is named by its source even when a session task produced it', () => {
      expect(kindOf(notice({ source: 'goal-checkin', producer: 'session-task' }))).toBe('goalCheckin');
    });

    it('is unknownOrigin with no subkind, source or producer it recognises', () => {
      expect(kindOf(notice({}))).toBe('unknownOrigin');
    });
  });

  it.each([
    ['peer', 'peer'],
    ['channel', 'channel'],
    ['coordinator', 'coordinator'],
    ['plugin', 'plugin'],
    ['auto-continuation', 'autoContinuation'],
    ['observer', 'observer'],
    ['observer-activity', 'observerActivity'],
    ['slack-ping', 'slackPing'],
    ['unclassified', 'unclassified'],
  ])('is, for text Claude Code stamped with origin kind %s, %s', (originKind, kind) => {
    expect(kindOf(userText('hello', { origin: { kind: originKind } }))).toBe(kind);
  });

  it('is unknownOrigin for an origin kind it does not recognise', () => {
    expect(kindOf(userText('hello', { origin: { kind: 'carrier-pigeon' } }))).toBe('unknownOrigin');
  });

  it('is system for a system entry', () => {
    expect(kindOf({ type: 'system', subtype: 'informational', uuid: 's1', content: 'Tool finished' })).toBe('system');
  });

  it('is undefined for bookkeeping tower never gets', () => {
    expect(kindOf(QUEUE_OPERATION)).toBeUndefined();
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
