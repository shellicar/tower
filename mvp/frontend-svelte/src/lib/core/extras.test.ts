import { describe, expect, it } from 'vitest';
import type { ContentBlock, ConversationMessage } from '../types';
import { atOf, blocksText, clockLabel, fieldsOf, formatDuration, kindOf, replacedForModel, rowOf, scopeOf, shownToUser, userBlocks, userContentOf } from './extras';

const text = (value: string): ContentBlock => ({ type: 'text', text: value });

function message(id: string, fields: Partial<ConversationMessage> = {}): ConversationMessage {
  return { id, query: 'q', turn: 't', role: 'user', content: [text(id)], ts: 1, ...fields };
}

/** Every extra field the wrong shape: a number kind, a list for fields, a string audience, userContent, scope and a number at. */
const MISSHAPED = message('x', { role: 'assistant', kind: 7, fields: [1], audience: 'model', userContent: 'not blocks', scope: 'before', at: 1727930560880 });

const NOON = new Date(2026, 9, 3, 12, 0, 0).getTime();
const EVENING = new Date(2026, 9, 3, 19, 1, 0).toISOString();

describe('shownToUser', () => {
  it('is true for plain chat', () => {
    expect(shownToUser(message('m1'))).toBe(true);
  });

  it('is false for a message only the model is sent', () => {
    expect(shownToUser(message('m1', { audience: { model: true, user: false } }))).toBe(false);
  });

  it('is true for a message both are sent', () => {
    expect(shownToUser(message('m1', { audience: { model: true, user: true } }))).toBe(true);
  });

  it('is true for a misshaped audience', () => {
    expect(shownToUser(MISSHAPED)).toBe(true);
  });
});

describe('userBlocks', () => {
  it('is the content when there is no userContent', () => {
    expect(userBlocks(message('m1'))).toEqual([text('m1')]);
  });

  it('is userContent when there is one', () => {
    expect(userBlocks(message('m1', { userContent: [text('shown')] }))).toEqual([text('shown')]);
  });

  it('is the content when userContent is not a list of blocks', () => {
    expect(userBlocks(MISSHAPED)).toEqual([text('x')]);
  });
});

describe('a misshaped field reads as absent', () => {
  it('kind', () => {
    expect(kindOf(MISSHAPED)).toBeUndefined();
  });

  it('fields', () => {
    expect(fieldsOf(MISSHAPED)).toEqual({});
  });

  it('userContent', () => {
    expect(userContentOf(MISSHAPED)).toBeUndefined();
  });

  it('scope', () => {
    expect(scopeOf(MISSHAPED)).toBeUndefined();
  });

  it('at', () => {
    expect(atOf(MISSHAPED)).toBeUndefined();
  });

  it('an at that is not a time', () => {
    expect(atOf(message('m1', { at: 'yesterday' }))).toBeUndefined();
  });

  it('a scope whose except is not a list', () => {
    expect(scopeOf(message('s', { scope: { replaces: 'before', except: 'm1' } }))).toEqual({ except: [] });
  });
});

describe('blocksText', () => {
  it('joins the text blocks and skips the rest', () => {
    expect(blocksText([text('a'), { type: 'image' }, text('b')])).toBe('ab');
  });
});

describe('replacedForModel', () => {
  const summary = message('s', { scope: { replaces: 'before', except: ['m2'] } });

  it('names the messages before the summary, except those it keeps', () => {
    expect([...replacedForModel([message('m1'), message('m2'), message('m3'), summary])]).toEqual(['m1', 'm3']);
  });

  it('leaves the messages after the summary', () => {
    expect([...replacedForModel([summary, message('m4')])]).toEqual([]);
  });

  it('leaves a message the model was never sent', () => {
    expect([...replacedForModel([message('m1', { audience: { model: false, user: true } }), summary])]).toEqual([]);
  });

  it('leaves a system message', () => {
    expect([...replacedForModel([message('boundary', { role: 'system' }), summary])]).toEqual([]);
  });

  it('is empty when nothing has a scope', () => {
    expect([...replacedForModel([message('m1'), message('m2')])]).toEqual([]);
  });

  it('is empty when the scope is misshaped', () => {
    expect([...replacedForModel([message('m1'), MISSHAPED])]).toEqual([]);
  });
});

describe('formatDuration', () => {
  it('reads seconds under a minute', () => {
    expect(formatDuration(2000)).toBe('2s');
  });

  it('reads minutes and seconds from a minute on', () => {
    expect(formatDuration(65000)).toBe('1m 5s');
  });
});

describe('clockLabel', () => {
  it('is just the time on the same day', () => {
    expect(clockLabel(new Date(2026, 9, 3, 19, 1, 0).getTime(), NOON)).toMatch(/^\d{2}[:.]\d{2}\b/);
  });

  it('puts the weekday in front on another day', () => {
    expect(clockLabel(new Date(2026, 9, 1, 19, 1, 0).getTime(), NOON)).toMatch(/^\D+ \d{2}[:.]\d{2}/);
  });

  it('is empty for a moment that is not a date', () => {
    expect(clockLabel('not a date', NOON)).toBe('');
  });
});

describe('rowOf', () => {
  const at = (m: ConversationMessage) => rowOf(m, 'system', NOON);
  const evening = clockLabel(EVENING, NOON);

  describe('turn-finished', () => {
    it('reads how long the turn ran and when it ended', () => {
      expect(at(message('t', { role: 'system', kind: 'turn-finished', fields: { durationMs: 2000, endedAt: EVENING }, audience: { model: false, user: true } }))).toEqual({ variant: 'line', text: `Worked for 2s · done ${evening}` });
    });

    it('falls back to the message’s at for when it ended', () => {
      expect(at(message('t', { role: 'system', kind: 'turn-finished', fields: { durationMs: 2000 }, at: EVENING }))).toEqual({ variant: 'line', text: `Worked for 2s · done ${evening}` });
    });

    it('shows the content when the duration is missing', () => {
      expect(at(message('t', { role: 'system', kind: 'turn-finished', fields: {}, content: [text('Worked for 2s')], at: EVENING }))).toEqual({ variant: 'line', text: `Worked for 2s · done ${evening}` });
    });
  });

  describe('interrupted', () => {
    it('reads Interrupted', () => {
      expect(at(message('i', { kind: 'interrupted', fields: { during: 'turn' } }))).toEqual({ variant: 'line', text: 'Interrupted' });
    });

    it('says when it cut short a tool use', () => {
      expect(at(message('i', { kind: 'interrupted', fields: { during: 'tool-use' } }))).toEqual({ variant: 'line', text: 'Interrupted · during tool use' });
    });
  });

  describe('tool-call-note', () => {
    it('reads the reason', () => {
      expect(at(message('n', { kind: 'tool-call-note', fields: { reason: 'denied' } }))).toEqual({ variant: 'line', text: 'Tool call denied' });
    });

    it('shows userContent for a reason it does not know', () => {
      expect(at(message('n', { kind: 'tool-call-note', fields: { reason: 'vanished' }, userContent: [text('Tool call vanished')] }))).toEqual({ variant: 'line', text: 'Tool call vanished' });
    });
  });

  describe('task-finished', () => {
    it('reads the summary and how long it ran', () => {
      expect(at(message('f', { kind: 'task-finished', fields: { status: 'completed', summary: 'Agent "reviewer" finished', durationMs: 39000 } }))).toEqual({ variant: 'notice', failed: false, text: 'Agent "reviewer" finished · 39s' });
    });

    it('marks a failed one', () => {
      expect(at(message('f', { kind: 'task-finished', fields: { status: 'failed', summary: 'Agent "reviewer" failed' } }))).toEqual({ variant: 'notice', failed: true, text: 'Agent "reviewer" failed' });
    });

    it('shows userContent with no summary', () => {
      expect(at(message('f', { kind: 'task-finished', fields: {}, userContent: [text('Task finished')] }))).toEqual({ variant: 'notice', failed: false, text: 'Task finished' });
    });
  });

  describe('subagent-report', () => {
    it('folds the report under who sent it', () => {
      expect(at(message('r', { kind: 'subagent-report', fields: { agentType: 'general-purpose' }, content: [text('Review done')] }))).toEqual({ variant: 'folded', tone: 'agent', label: 'Message from @general-purpose', detail: '', blocks: [text('Review done')] });
    });
  });

  describe('compaction', () => {
    it('folds the summary under the trigger and duration', () => {
      expect(at(message('c', { kind: 'compaction', fields: { trigger: 'manual', durationMs: 4996 }, content: [text('Summary')] }))).toEqual({ variant: 'folded', tone: 'compaction', label: 'Conversation compacted', detail: 'manual · 5s', blocks: [text('Summary')] });
    });
  });

  describe('api-error', () => {
    it('shows the error class and status', () => {
      expect(at(message('e', { role: 'assistant', kind: 'api-error', fields: { error: 'server_error', status: 529 }, audience: { model: false, user: true }, content: [text('API Error')] }))).toEqual({ variant: 'error', detail: 'server_error · 529', blocks: [text('API Error')] });
    });
  });

  describe('model only', () => {
    it('labels a reminder by its kind', () => {
      expect(at(message('d', { kind: 'date', fields: { date: '2026-10-01' }, audience: { model: true, user: false } }))).toEqual({ variant: 'model-only', label: 'date', blocks: [text('d')] });
    });

    it('labels no-response by its kind', () => {
      expect(at(message('n', { role: 'assistant', kind: 'no-response', fields: {}, audience: { model: true, user: false } }))).toEqual({ variant: 'model-only', label: 'no-response', blocks: [text('n')] });
    });

    it('labels a message with no kind by its sender', () => {
      expect(at(message('m', { audience: { model: true, user: false } }))).toEqual({ variant: 'model-only', label: 'system', blocks: [text('m')] });
    });
  });

  describe('a kind it does not know', () => {
    it('shows userContent as a message', () => {
      expect(at(message('u', { kind: 'recap', fields: { text: 'r' }, userContent: [text('shown')] }))).toEqual({ variant: 'message', blocks: [text('shown')] });
    });
  });

  it('shows plain chat as a message', () => {
    expect(at(message('p'))).toEqual({ variant: 'message', blocks: [text('p')] });
  });

  it('shows a message with misshaped extras as a message of its content', () => {
    expect(at(MISSHAPED)).toEqual({ variant: 'message', blocks: [text('x')] });
  });
});
