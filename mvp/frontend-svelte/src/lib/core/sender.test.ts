import { describe, expect, it } from 'vitest';
import type { ContentBlock, ConversationMessage, Sender } from '../types';
import { senderLabel } from './sender';

function message(from: Sender | undefined, content: ContentBlock[], role = 'user'): ConversationMessage {
  return { id: 'm', query: 'q', turn: 't', role, from, content, ts: 1 };
}

const text: ContentBlock = { type: 'text', text: 'hi' };
const toolResult: ContentBlock = { type: 'tool_result', tool_use_id: 't1', content: 'ok' };

describe('senderLabel', () => {
  it('names a sender by its userId', () => {
    const expected = 'stephen';

    const actual = senderLabel(message({ kind: 'human', userId: 'stephen' }, [text]));

    expect(actual).toBe(expected);
  });

  it('names a sender without a userId by its kind', () => {
    const expected = 'human';

    const actual = senderLabel(message({ kind: 'human' }, [text]));

    expect(actual).toBe(expected);
  });

  it('names a system message with a sender by its sender', () => {
    const expected = 'agent';

    const actual = senderLabel(message({ kind: 'agent' }, [text], 'system'));

    expect(actual).toBe(expected);
  });

  it('reads no sender delivering tool results as tool', () => {
    const expected = 'tool';

    const actual = senderLabel(message(undefined, [toolResult]));

    expect(actual).toBe(expected);
  });

  it('reads no sender with a tool result beside other blocks as tool', () => {
    const expected = 'tool';

    const actual = senderLabel(message(undefined, [toolResult, text]));

    expect(actual).toBe(expected);
  });

  it('reads a system message with no sender delivering a tool result as tool', () => {
    const expected = 'tool';

    const actual = senderLabel(message(undefined, [toolResult], 'system'));

    expect(actual).toBe(expected);
  });

  it('reads a system message with no sender as system', () => {
    const expected = 'system';

    const actual = senderLabel(message(undefined, [text], 'system'));

    expect(actual).toBe(expected);
  });

  it('reads a user message with no sender and no tool result as unknown', () => {
    const expected = 'unknown';

    const actual = senderLabel(message(undefined, [text]));

    expect(actual).toBe(expected);
  });

  it('reads an assistant message with no sender as unknown', () => {
    const expected = 'unknown';

    const actual = senderLabel(message(undefined, [text], 'assistant'));

    expect(actual).toBe(expected);
  });

  it('reads no sender and no content as unknown', () => {
    const expected = 'unknown';

    const actual = senderLabel(message(undefined, []));

    expect(actual).toBe(expected);
  });
});
