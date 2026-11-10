import type { SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { ConversationChanges } from '../src/ConversationChanges.js';
import type { RecordEntry } from '../src/ConversationEntries.js';
import { IPublisher } from '../src/SessionStore.js';
import { orderDisagreements, TranscriptReplay } from '../src/TranscriptReplay.js';
import { ANSWER, DATE_ATTACHMENT, IMAGE_TOOL_RESULT, INTERRUPT_MARKER, PARTIAL_REPLY, PROMPT, QUEUE_OPERATION, SECOND_PROMPT, THINKING, TOKENS_REMINDER, TOOL_USE } from './entries.js';
import { delivered, testServices } from './support.js';

const SESSION = '0c77fb4e-655e-41f2-be80-558ad2aaf6dc';
const CONVERSATION = 'c0000000-0000-4000-8000-000000000001';
const MAIN = { projectKey: '-work', sessionId: SESSION };
const SUBAGENT = { ...MAIN, subpath: 'subagents/agent-a1' };

/** Both queries of the live run, as the record holds them. */
const RECORD = [QUEUE_OPERATION, PROMPT, DATE_ATTACHMENT, THINKING, TOOL_USE, IMAGE_TOOL_RESULT, TOKENS_REMINDER, ANSWER, SECOND_PROMPT, PARTIAL_REPLY, INTERRUPT_MARKER] as SessionStoreEntry[];

function replaying() {
  const services = testServices();
  const publisher = services.provider.resolve(IPublisher);
  const changes = new ConversationChanges(CONVERSATION, {
    lane: services.outbox.lane(CONVERSATION),
    timer: services.timer,
    ids: services.ids,
    host: services.host,
    instanceId: 'inst-1',
    durableBucket: 'durable-test',
    abort: () => {},
  });
  publisher.route(SESSION, changes);
  const replay = new TranscriptReplay(publisher, changes, services.ids);
  const append = async (key: typeof MAIN, entries: readonly RecordEntry[]) => {
    await replay.append(key, entries as SessionStoreEntry[]);
    await delivered();
  };
  return { ...services, append };
}

function messages(services: ReturnType<typeof replaying>) {
  return services.broker.published.filter((message) => message.subject === `conv.v2.${CONVERSATION}.changes.message`).map((message) => message.body);
}

describe('TranscriptReplay', () => {
  it('publishes the messages of the record under the conversation id, in the order the record holds them', async () => {
    const services = replaying();
    await services.append(MAIN, RECORD);
    const expected = [PROMPT, THINKING, TOOL_USE, IMAGE_TOOL_RESULT, ANSWER, SECOND_PROMPT, PARTIAL_REPLY].map((entry) => entry.uuid);
    const actual = messages(services).map((body) => body.id);
    expect(actual).toEqual(expected);
  });

  it('publishes nothing but messages', async () => {
    const services = replaying();
    await services.append(MAIN, RECORD);
    const expected = [`conv.v2.${CONVERSATION}.changes.message`];
    const actual = [...new Set(services.broker.subjects())];
    expect(actual).toEqual(expected);
  });

  it('publishes each prompt from a human', async () => {
    const services = replaying();
    await services.append(MAIN, RECORD);
    const expected = [{ kind: 'human' }, { kind: 'human' }];
    const actual = messages(services)
      .filter((body) => body.id === PROMPT.uuid || body.id === SECOND_PROMPT.uuid)
      .map((body) => body.from);
    expect(actual).toEqual(expected);
  });

  it('opens a query of its own for each prompt', async () => {
    const services = replaying();
    await services.append(MAIN, RECORD);
    const queries = messages(services).map((body) => body.queryId);
    const expected = [1, 1, 1, 1, 1, 2, 2];
    const actual = queries.map((queryId) => [...new Set(queries)].indexOf(queryId) + 1);
    expect(actual).toEqual(expected);
  });

  it('stamps each message with its entry’s time', async () => {
    const services = replaying();
    await services.append(MAIN, RECORD);
    const expected = [PROMPT, THINKING, TOOL_USE, IMAGE_TOOL_RESULT, ANSWER, SECOND_PROMPT, PARTIAL_REPLY].map((entry) => entry.timestamp);
    const actual = messages(services).map((body) => body.ts);
    expect(actual).toEqual(expected);
  });

  it('publishes nothing for a subagent’s record', async () => {
    const services = replaying();
    await services.append(SUBAGENT, RECORD);
    const expected: unknown[] = [];
    const actual = services.broker.published;
    expect(actual).toEqual(expected);
  });

  it('loads nothing', async () => {
    const services = replaying();
    const replay = new TranscriptReplay(services.provider.resolve(IPublisher), {} as ConversationChanges, services.ids);
    const expected = null;
    const actual = await replay.load();
    expect(actual).toEqual(expected);
  });
});

describe('orderDisagreements', () => {
  const at = (id: string, ts: string) => ({ id, ts });

  it('finds none when each message is no earlier than the one before it', () => {
    const expected: unknown[] = [];
    const actual = orderDisagreements([at('a', '2026-10-13T16:05:50.000Z'), at('b', '2026-10-13T16:05:50.000Z'), at('c', '2026-10-13T16:05:51.000Z')]);
    expect(actual).toEqual(expected);
  });

  it('makes a run of earlier messages behind one later message one place', () => {
    const boundary = at('boundary', '2026-10-13T16:06:10.765Z');
    const command = at('command', '2026-10-13T16:05:59.258Z');
    const caveat = at('caveat', '2026-10-13T16:05:59.259Z');
    const expected = [{ latest: boundary, earlier: [command, caveat] }];
    const actual = orderDisagreements([at('prompt', '2026-10-13T16:05:59.256Z'), boundary, command, caveat, at('stdout', '2026-10-13T16:06:10.864Z')]);
    expect(actual).toEqual(expected);
  });

  it('makes separate runs separate places', () => {
    const first = at('b', '2026-10-13T16:00:02.000Z');
    const second = at('e', '2026-10-13T16:00:05.000Z');
    const expected = [
      { latest: first, earlier: [at('c', '2026-10-13T16:00:01.000Z')] },
      { latest: second, earlier: [at('f', '2026-10-13T16:00:04.000Z')] },
    ];
    const actual = orderDisagreements([at('a', '2026-10-13T16:00:00.000Z'), first, at('c', '2026-10-13T16:00:01.000Z'), at('d', '2026-10-13T16:00:03.000Z'), second, at('f', '2026-10-13T16:00:04.000Z')]);
    expect(actual).toEqual(expected);
  });
});
