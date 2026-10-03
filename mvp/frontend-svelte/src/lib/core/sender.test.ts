import { describe, expect, it } from 'vitest';
import type { ContentBlock, ConversationMessage, Sender } from '../types';
import { senderLabel } from './sender';

function message(from: Sender | undefined, content: ContentBlock[]): ConversationMessage {
  return { id: 'm', query: 'q', turn: 't', role: 'user', from, content, ts: 1 };
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

  it('names an orchestrator by its kind', () => {
    const expected = 'orchestrator';

    const actual = senderLabel(message({ kind: 'orchestrator', userId: 'x' }, [text]));

    expect(actual).toBe(expected);
  });

  it('names an agent by its kind', () => {
    const expected = 'agent';

    const actual = senderLabel(message({ kind: 'agent' }, [text]));

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

  it('reads no sender without tool results as system', () => {
    const expected = 'system';

    const actual = senderLabel(message(undefined, [text]));

    expect(actual).toBe(expected);
  });

  it('reads no sender and no content as system', () => {
    const expected = 'system';

    const actual = senderLabel(message(undefined, []));

    expect(actual).toBe(expected);
  });
});
