import { describe, expect, it } from 'vitest';
import type { ConversationMessage, MessageScope } from '../types';
import { firstLine, messageTime, scopedOutIds, visibleRows } from './visibleRows';

function msg(id: string, extra: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    id,
    query: 'q',
    turn: 't',
    role: 'user',
    content: [{ type: 'text', text: `body ${id}` }],
    ts: 1000,
    ...extra,
  };
}

describe('visibleRows', () => {
  it('keeps messages with no new fields unchanged and in order', () => {
    const expected = ['a', 'b'];

    const actual = visibleRows([msg('a'), msg('b')]).map((r) => r.id);

    expect(actual).toEqual(expected);
  });

  it('drops a message not meant for the user', () => {
    const expected = ['a'];

    const actual = visibleRows([msg('a'), msg('b', { audience: { model: true, user: false } })]).map((r) => r.id);

    expect(actual).toEqual(expected);
  });

  it('keeps a message meant for the user but not the model', () => {
    const expected = ['a'];

    const actual = visibleRows([msg('a', { audience: { model: false, user: true } })]).map((r) => r.id);

    expect(actual).toEqual(expected);
  });

  it('shows userContent instead of content', () => {
    const userContent = [{ type: 'text', text: 'for you' }];
    const expected = userContent;

    const actual = visibleRows([msg('a', { userContent })])[0].content;

    expect(actual).toEqual(expected);
  });

  it('shows content when userContent is absent', () => {
    const m = msg('a');
    const expected = m.content;

    const actual = visibleRows([m])[0].content;

    expect(actual).toEqual(expected);
  });

  it('marks a scope message with a note', () => {
    const expected = true;

    const actual = visibleRows([msg('a'), msg('b', { scope: { replaces: 'before', except: [] } })])[1].scopeNote;

    expect(actual).toBe(expected);
  });

  it('collapses a user-role message from an agent', () => {
    const expected = true;

    const actual = visibleRows([msg('a', { from: { kind: 'agent' } })])[0].collapsed;

    expect(actual).toBe(expected);
  });

  it('does not collapse an assistant-role message from an agent', () => {
    const expected = false;

    const actual = visibleRows([msg('a', { role: 'assistant', from: { kind: 'agent' } })])[0].collapsed;

    expect(actual).toBe(expected);
  });

  it('does not collapse a user message from an orchestrator', () => {
    const expected = false;

    const actual = visibleRows([msg('a', { from: { kind: 'orchestrator' } })])[0].collapsed;

    expect(actual).toBe(expected);
  });
});

describe('dimming', () => {
  const scope: MessageScope = { replaces: 'before', except: ['keep'] };

  it('dims an earlier message the model saw', () => {
    const expected = [true, false];

    const actual = visibleRows([msg('a'), msg('s', { scope })]).map((r) => r.dimmed);

    expect(actual).toEqual(expected);
  });

  it('does not dim an excepted message', () => {
    const expected = false;

    const actual = visibleRows([msg('keep'), msg('s', { scope })])[0].dimmed;

    expect(actual).toBe(expected);
  });

  it('does not dim an earlier message the model never saw', () => {
    const expected = false;

    const actual = visibleRows([msg('a', { audience: { model: false, user: true } }), msg('s', { scope })])[0].dimmed;

    expect(actual).toBe(expected);
  });

  it('does not dim a later message', () => {
    const expected = false;

    const actual = visibleRows([msg('s', { scope }), msg('later')])[1].dimmed;

    expect(actual).toBe(expected);
  });

  it('leaves a hidden message out of the rows while a scope after it still applies', () => {
    const expected = ['a', 's'];

    const actual = visibleRows([msg('a'), msg('h', { audience: { model: true, user: false } }), msg('s', { scope })]).map((r) => r.id);

    expect(actual).toEqual(expected);
  });

  it('removes an earlier scope message and its predecessors when a second scope follows', () => {
    const expected = ['s1', 'a'];

    const actual = [
      ...scopedOutIds([msg('s1', { scope: { replaces: 'before', except: [] } }), msg('a'), msg('s2', { scope: { replaces: 'before', except: [] } })]),
    ];

    expect(actual).toEqual(expected);
  });
});

describe('messageTime', () => {
  it('uses at when present', () => {
    const expected = Date.parse('2026-10-03T01:02:03Z');

    const actual = messageTime(msg('a', { at: '2026-10-03T01:02:03Z' }));

    expect(actual).toBe(expected);
  });

  it('uses ts when at is absent', () => {
    const expected = 1000;

    const actual = messageTime(msg('a'));

    expect(actual).toBe(expected);
  });

  it('uses ts when at does not parse', () => {
    const expected = 1000;

    const actual = messageTime(msg('a', { at: 'nonsense' }));

    expect(actual).toBe(expected);
  });
});

describe('firstLine', () => {
  it('returns the first line of the first text block', () => {
    const expected = 'one';

    const actual = firstLine([{ type: 'text', text: 'one\ntwo' }]);

    expect(actual).toBe(expected);
  });

  it('returns empty when there is no text block', () => {
    const expected = '';

    const actual = firstLine([{ type: 'image' }]);

    expect(actual).toBe(expected);
  });
});
