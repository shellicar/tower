import { describe, expect, it } from 'vitest';
import type { RecordEntry } from '../src/ConversationEntries.js';
import { classify, formatDuration } from '../src/ConversationKinds.js';
import { ANSWER, API_ERROR, COMPACT_BOUNDARY, COMPACT_SUMMARY, DATE_ATTACHMENT, INTERRUPT_MARKER, NO_RESPONSE, PROMPT, RECORDED_TOKENS_REMINDER, SUBAGENT_REPORT, TASK_NOTICE, TURN_DURATION } from './entries.js';

function userText(text: string, fields: Record<string, unknown> = {}): RecordEntry {
  return { type: 'user', uuid: 'u1', message: { role: 'user', content: text }, ...fields };
}

describe('classify', () => {
  describe('a prompt or a reply', () => {
    it('has no kind', () => {
      expect(classify(PROMPT)).toEqual({ role: 'user' });
    });

    it('has none for a reply', () => {
      expect(classify(ANSWER)).toEqual({ role: 'assistant' });
    });
  });

  describe('a task-finished notice', () => {
    it('is from the orchestrator', () => {
      expect(classify(TASK_NOTICE)?.from).toEqual({ kind: 'orchestrator' });
    });

    it('takes its fields from the notice', () => {
      expect(classify(TASK_NOTICE)?.fields).toEqual({
        taskId: 'baqmnyz51',
        toolUseId: 'toolu_013sBHj3Jk443vmoJ8tL599k',
        status: 'completed',
        summary: 'Background command "Run background sleep and echo" completed (exit code 0)',
        name: 'Run background sleep and echo',
      });
    });

    it('shows the person its summary', () => {
      expect(classify(TASK_NOTICE)?.userContent).toEqual([{ type: 'text', text: 'Background command "Run background sleep and echo" completed (exit code 0)' }]);
    });

    it('adds the length of an agent that reports one', () => {
      const notice = userText('<task-notification>\n<task-id>a3f8</task-id>\n<status>completed</status>\n<summary>Agent "reviewer" finished</summary>\n<usage><subagent_tokens>41230</subagent_tokens><tool_uses>7</tool_uses><duration_ms>39000</duration_ms></usage>\n</task-notification>', {
        origin: { kind: 'task-notification' },
      });
      expect(classify(notice)?.userContent).toEqual([{ type: 'text', text: 'Agent "reviewer" finished · 39s' }]);
    });

    it('carries the agent figures as fields', () => {
      const notice = userText('<task-notification>\n<summary>Agent "reviewer" finished</summary>\n<usage><subagent_tokens>41230</subagent_tokens><tool_uses>7</tool_uses><duration_ms>39000</duration_ms></usage>\n</task-notification>', { origin: { kind: 'task-notification' } });
      expect(classify(notice)?.fields).toEqual({ summary: 'Agent "reviewer" finished', name: 'reviewer', durationMs: 39000, toolUses: 7, tokens: 41230 });
    });
  });

  describe('a subagent hand-back', () => {
    it('is a subagent-report from an agent', () => {
      expect(classify(SUBAGENT_REPORT)).toEqual({ role: 'user', kind: 'subagent-report', from: { kind: 'agent' }, fields: { agentType: 'general-purpose' } });
    });
  });

  describe('an interrupt marker', () => {
    it('is interrupted during the turn', () => {
      expect(classify(INTERRUPT_MARKER)).toEqual({ role: 'user', kind: 'interrupted', fields: { during: 'turn' }, userContent: [{ type: 'text', text: 'Interrupted' }] });
    });

    it('is interrupted during tool use when it says so', () => {
      expect(classify(userText('[Request interrupted by user for tool use]'))?.fields).toEqual({ during: 'tool-use' });
    });

    it('is a tool-call-note with a reason for a tool call that did not finish', () => {
      expect(classify(userText('[Tool call did not complete: the turn was ended to deliver the message that follows. Nothing refused it; re-run it if still needed.]'))).toMatchObject({ kind: 'tool-call-note', fields: { reason: 'incomplete' } });
    });

    it('is not a marker when a prompt only mentions one', () => {
      expect(classify(userText('Why did I see [Request interrupted by user]?'))).toEqual({ role: 'user' });
    });
  });

  describe('a compaction', () => {
    it('is a compaction replacing everything before it except what was preserved', () => {
      const compactions = new Map([[String(COMPACT_BOUNDARY.uuid), COMPACT_BOUNDARY.compactMetadata as Record<string, unknown>]]);
      expect(classify(COMPACT_SUMMARY, compactions)).toMatchObject({
        role: 'user',
        kind: 'compaction',
        fields: { trigger: 'manual', durationMs: 4996, preTokens: 18557, postTokens: 2756, preservedIds: ['2dde7688-fff7-4af9-ab6b-5220712f1002'] },
        scope: { replaces: 'before', except: ['2dde7688-fff7-4af9-ab6b-5220712f1002'] },
      });
    });

    it('still replaces everything before it when its boundary was not seen', () => {
      expect(classify(COMPACT_SUMMARY)?.scope).toEqual({ replaces: 'before', except: [] });
    });

    it('leaves the boundary a system message', () => {
      expect(classify(COMPACT_BOUNDARY)).toEqual({ role: 'system' });
    });
  });

  describe('a reminder', () => {
    it('is for the model only', () => {
      expect(classify(DATE_ATTACHMENT)?.audience).toEqual({ model: true, user: false });
    });

    it('is named for its attachment, with the date as a field', () => {
      expect(classify(DATE_ATTACHMENT)).toMatchObject({ kind: 'date', fields: { date: '2026-10-01' } });
    });

    it('carries the rendered text as its content', () => {
      expect(classify(DATE_ATTACHMENT)?.content).toEqual([{ type: 'text', text: "<system-reminder>\nToday's date is 2026-10-01.\n</system-reminder>" }]);
    });

    it('takes the role Claude Code recorded for it', () => {
      expect(classify(RECORDED_TOKENS_REMINDER)?.role).toBe('system');
    });

    it('carries the tokens left of the token reminder', () => {
      expect(classify(RECORDED_TOKENS_REMINDER)).toMatchObject({ kind: 'total-tokens-reminder', fields: { tokensLeft: 14981384 } });
    });

    it('names an attachment with no fields of its own by its type', () => {
      expect(classify({ type: 'attachment', uuid: 'a1', attachment: { type: 'skill_listing', content: '- a' }, rendered: [{ content: 'x' }] })).toMatchObject({ kind: 'skill-listing', fields: {} });
    });
  });

  describe('a turn-finished line', () => {
    it('is for the person only', () => {
      expect(classify(TURN_DURATION)?.audience).toEqual({ model: false, user: true });
    });

    it('carries the length and the time it ended', () => {
      expect(classify(TURN_DURATION)?.fields).toEqual({ durationMs: 2000, endedAt: '2026-10-03T14:22:44.187+10:00' });
    });

    it('says the length as its content', () => {
      expect(classify(TURN_DURATION)?.content).toEqual([{ type: 'text', text: 'Worked for 2s' }]);
    });

    it('is a plain system message when it has no length', () => {
      expect(classify({ ...TURN_DURATION, durationMs: undefined })).toEqual({ role: 'system' });
    });
  });

  describe('a synthetic reply', () => {
    it('is no-response for the model only', () => {
      expect(classify(NO_RESPONSE)).toEqual({ role: 'assistant', kind: 'no-response', fields: {}, audience: { model: true, user: false } });
    });

    it('is an api-error for the person only', () => {
      expect(classify(API_ERROR)).toEqual({ role: 'assistant', kind: 'api-error', fields: { error: 'server_error', status: 529 }, audience: { model: false, user: true } });
    });

    it('is a plain reply when the model wrote "No response requested."', () => {
      expect(classify({ ...NO_RESPONSE, message: { model: 'claude-sonnet-5', content: [{ type: 'text', text: 'No response requested.' }] } })).toEqual({ role: 'assistant' });
    });
  });
});

describe('formatDuration', () => {
  it('reads seconds under a minute', () => {
    expect(formatDuration(1200)).toBe('1s');
  });

  it('reads minutes and seconds from a minute on', () => {
    expect(formatDuration(65000)).toBe('1m 5s');
  });
});
