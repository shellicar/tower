import { describe, expect, it } from 'vitest';
import type { ContentBlock, ConversationMessage } from '../types';
import { blocksText, clockLabel, formatDuration, replacedForModel, shownToUser, userBlocks } from './extras';

const text = (value: string): ContentBlock => ({ type: 'text', text: value });

function message(id: string, fields: Partial<ConversationMessage> = {}): ConversationMessage {
  return { id, query: 'q', turn: 't', role: 'user', content: [text(id)], ts: 1, ...fields };
}

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
});

describe('userBlocks', () => {
  it('is the content when there is no userContent', () => {
    expect(userBlocks(message('m1'))).toEqual([text('m1')]);
  });

  it('is userContent when there is one', () => {
    expect(userBlocks(message('m1', { userContent: [text('shown')] }))).toEqual([text('shown')]);
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
  const noon = new Date(2026, 9, 3, 12, 0, 0).getTime();

  it('is just the time on the same day', () => {
    expect(clockLabel(new Date(2026, 9, 3, 19, 1, 0).getTime(), noon)).toMatch(/^\d{2}[:.]\d{2}\b/);
  });

  it('puts the weekday in front on another day', () => {
    expect(clockLabel(new Date(2026, 9, 1, 19, 1, 0).getTime(), noon)).toMatch(/^\D+ \d{2}[:.]\d{2}/);
  });

  it('is empty for a moment that is not a date', () => {
    expect(clockLabel('not a date', noon)).toBe('');
  });
});
