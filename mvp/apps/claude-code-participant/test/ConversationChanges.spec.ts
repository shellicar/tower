import { describe, expect, it } from 'vitest';
import { ConversationChanges } from '../src/ConversationChanges.js';
import type { RecordEntry } from '../src/ConversationEntries.js';
import {
  ANSWER,
  API_ERROR,
  CALL_A,
  CALL_B,
  COMPACT_BOUNDARY,
  COMPACT_SUMMARY,
  DATE_ATTACHMENT,
  IMAGE_TOOL_RESULT,
  INTERRUPT_MARKER,
  PARALLEL_ANSWER,
  PARTIAL_REPLY,
  PNG_BASE64,
  PROMPT,
  QUEUE_OPERATION,
  RESULT_A,
  RESULT_B,
  SECOND_PROMPT,
  TASK_NOTICE,
  THINKING,
  TOKENS_REMINDER,
  TOOL_USE,
  TURN_FINISHED,
} from './entries.js';
import { FAKE_TIMESTAMP, settle, testServices } from './support.js';

const ID = '0c77fb4e-655e-41f2-be80-558ad2aaf6dc';
const CHANGES = `conv.v2.${ID}.changes`;
const HUMAN = { kind: 'human', userId: 'stephen' };

/** The first query of the live run: a prompt, a reply that reads an image, the tool result and the answer. */
const FIRST_QUERY = [QUEUE_OPERATION, PROMPT, DATE_ATTACHMENT, THINKING, TOOL_USE, IMAGE_TOOL_RESULT, TOKENS_REMINDER, ANSWER];

function publishing() {
  const services = testServices();
  let aborts = 0;
  const changes = new ConversationChanges(ID, {
    broker: services.broker,
    timer: services.timer,
    ids: services.ids,
    host: services.host,
    instanceId: 'inst-1',
    durableBucket: 'durable-test',
    abort: () => {
      aborts += 1;
    },
  });
  return { ...services, changes, aborts: () => aborts };
}

type Publishing = ReturnType<typeof publishing>;

function messages(services: Publishing) {
  return services.broker.published.filter((message) => message.subject === `${CHANGES}.message`).map((message) => message.body);
}

function message(services: Publishing, id: string | undefined) {
  return messages(services).find((body) => body.id === id);
}

async function firstQuery() {
  const services = publishing();
  await services.changes.openQuery('q1', HUMAN);
  await services.changes.commit(FIRST_QUERY);
  await services.changes.close('completed');
  return services;
}

describe('ConversationChanges', () => {
  describe('a query', () => {
    it('publishes the prompt, each piece of the reply and the tool result, in order', async () => {
      const services = await firstQuery();
      expect(messages(services).map((body) => body.id)).toEqual([PROMPT.uuid, DATE_ATTACHMENT.uuid, THINKING.uuid, TOOL_USE.uuid, IMAGE_TOOL_RESULT.uuid, ANSWER.uuid]);
    });

    it('publishes the prompt with its ids, role, the say’s from and its content', async () => {
      const services = await firstQuery();
      expect(message(services, PROMPT.uuid)).toEqual({
        ts: FAKE_TIMESTAMP,
        instanceId: 'inst-1',
        id: PROMPT.uuid,
        queryId: 'q1',
        turnId: 'id-1',
        role: 'user',
        from: HUMAN,
        content: [{ type: 'text', text: 'Use the Read tool to read ./red.png, then tell me its colour in one short sentence.' }],
      });
    });

    it('publishes a reply piece as assistant, with no from', async () => {
      const services = await firstQuery();
      expect(message(services, THINKING.uuid)).toEqual({
        ts: FAKE_TIMESTAMP,
        instanceId: 'inst-1',
        id: THINKING.uuid,
        queryId: 'q1',
        turnId: 'id-1',
        role: 'assistant',
        content: [{ type: 'thinking', thinking: "No user memory is relevant here, so I'll just read the file directly.\n\n", signature: 'Et0CCrwBCBIYAipA' }],
      });
    });

    it('puts the prompt and the reply it gets in one turn', async () => {
      const services = await firstQuery();
      expect([PROMPT, THINKING, TOOL_USE].map((entry) => message(services, entry.uuid)?.turnId)).toEqual(['id-1', 'id-1', 'id-1']);
    });

    it('begins the next turn with the tool result, and puts the answer in it', async () => {
      const services = await firstQuery();
      expect([IMAGE_TOOL_RESULT, ANSWER].map((entry) => message(services, entry.uuid)?.turnId)).toEqual(['id-2', 'id-2']);
    });

    it('gives the tool result no from', async () => {
      const services = await firstQuery();
      expect(message(services, IMAGE_TOOL_RESULT.uuid)).not.toHaveProperty('from');
    });

    it('closes the query after its messages', async () => {
      const services = await firstQuery();
      expect(services.broker.published.at(-1)).toEqual({ subject: `${CHANGES}.query.closed`, body: { ts: FAKE_TIMESTAMP, instanceId: 'inst-1', queryId: 'q1', reason: 'completed' } });
    });

    it('closes nothing when no query is open', async () => {
      const services = publishing();
      await services.changes.close('completed');
      expect(services.broker.published).toEqual([]);
    });

    it('closes a query once', async () => {
      const services = await firstQuery();
      await services.changes.close('completed');
      expect(services.broker.subjects().filter((subject) => subject.endsWith('.query.closed'))).toHaveLength(1);
    });
  });

  describe('parallel tool calls, with results written between the calls', () => {
    async function parallel() {
      const services = publishing();
      await services.changes.openQuery('q1', HUMAN);
      await services.changes.commit([PROMPT, CALL_A, RESULT_A, CALL_B, RESULT_B, TOKENS_REMINDER, PARALLEL_ANSWER]);
      return services;
    }

    function turns(services: Publishing, ...entries: RecordEntry[]) {
      return entries.map((entry) => message(services, entry.uuid)?.turnId);
    }

    it('puts every call of one response in the turn of the prompt', async () => {
      const services = await parallel();
      expect(turns(services, PROMPT, CALL_A, CALL_B)).toEqual(['id-1', 'id-1', 'id-1']);
    });

    it('puts both results and the answer in the next turn', async () => {
      const services = await parallel();
      expect(turns(services, RESULT_A, RESULT_B, PARALLEL_ANSWER)).toEqual(['id-2', 'id-2', 'id-2']);
    });

    it('puts a system entry written between the results and the answer in the next turn', async () => {
      const services = publishing();
      const system: RecordEntry = { type: 'system', subtype: 'informational', uuid: 's0000000-0000-4000-8000-00000000000s', content: 'Tool finished' };
      await services.changes.openQuery('q1', HUMAN);
      await services.changes.commit([PROMPT, CALL_A, RESULT_A, CALL_B, RESULT_B, system, PARALLEL_ANSWER]);
      expect(turns(services, system, PARALLEL_ANSWER)).toEqual(['id-2', 'id-2']);
    });
  });

  it('keeps one turn when a response with the same input follows another', async () => {
    const services = publishing();
    await services.changes.openQuery('q1', HUMAN);
    await services.changes.commit([PROMPT, { ...PARALLEL_ANSWER, message: { ...(PARALLEL_ANSWER.message as object), id: 'msg_retry' } }, ANSWER]);
    expect([PROMPT, PARALLEL_ANSWER, ANSWER].map((entry) => message(services, entry.uuid)?.turnId)).toEqual(['id-1', 'id-1', 'id-1']);
  });

  it('publishes the closure after a message whose file is still being stored', async () => {
    const services = publishing();
    const held = Promise.withResolvers<void>();
    services.broker.storeHold = held.promise;
    await services.changes.openQuery('q1', HUMAN);
    const committed = services.changes.commit([IMAGE_TOOL_RESULT]);
    const closed = services.changes.close('completed');
    await settle();
    held.resolve();
    await Promise.all([committed, closed]);
    expect(services.broker.subjects()).toEqual([`${CHANGES}.message`, `${CHANGES}.query.closed`]);
  });

  describe('a cancelled query', () => {
    async function cancelled() {
      const services = await firstQuery();
      await services.changes.openQuery('q2', HUMAN);
      await services.changes.commit([SECOND_PROMPT, TOKENS_REMINDER, PARTIAL_REPLY, INTERRUPT_MARKER]);
      await services.changes.close('cancelled');
      return services;
    }

    it('publishes the prompt, the partial reply Claude Code kept and the marker', async () => {
      const services = await cancelled();
      expect(
        messages(services)
          .filter((body) => body.queryId === 'q2')
          .map((body) => body.id),
      ).toEqual([SECOND_PROMPT.uuid, PARTIAL_REPLY.uuid, INTERRUPT_MARKER.uuid]);
    });

    it('publishes the marker with the interruption text for the person', async () => {
      const services = await cancelled();
      expect(message(services, INTERRUPT_MARKER.uuid)).toEqual({
        ts: FAKE_TIMESTAMP,
        instanceId: 'inst-1',
        id: INTERRUPT_MARKER.uuid,
        queryId: 'q2',
        turnId: 'id-5',
        role: 'user',
        audience: { model: true, user: true },
        at: '2026-09-30T18:45:34.916Z',
        userContent: [{ type: 'text', text: 'Interrupted · What should Claude do instead?' }],
        content: [{ type: 'text', text: '[Request interrupted by user]' }],
      });
    });

    it('begins a new turn with the new query', async () => {
      const services = await cancelled();
      expect(message(services, SECOND_PROMPT.uuid)?.turnId).toBe('id-4');
    });

    it('closes it cancelled', async () => {
      const services = await cancelled();
      expect(services.broker.published.at(-1)?.body).toEqual({ ts: FAKE_TIMESTAMP, instanceId: 'inst-1', queryId: 'q2', reason: 'cancelled' });
    });
  });

  describe('extras', () => {
    it('publishes a reminder as a system message the person is not shown', async () => {
      const services = await firstQuery();
      expect(message(services, DATE_ATTACHMENT.uuid)).toMatchObject({ role: 'system', audience: { model: true, user: false }, at: '2026-09-30T18:45:18.780Z' });
    });

    it('publishes a task-finished notice from the orchestrator and leaves the say’s from for the next prompt', async () => {
      const services = publishing();
      await services.changes.openQuery('q1', HUMAN);
      await services.changes.commit([TASK_NOTICE, PROMPT]);
      expect([message(services, TASK_NOTICE.uuid)?.from, message(services, PROMPT.uuid)?.from]).toEqual([{ kind: 'orchestrator' }, HUMAN]);
    });

    it('publishes a compaction summary with the uuids its boundary kept', async () => {
      const services = publishing();
      await services.changes.commit([COMPACT_BOUNDARY, COMPACT_SUMMARY]);
      expect(message(services, COMPACT_SUMMARY.uuid)?.scope).toEqual({ replaces: 'before', except: ['2dde7688-fff7-4af9-ab6b-5220712f1002'] });
    });

    it('publishes the turn-finished line as text for the person', async () => {
      const services = publishing();
      await services.changes.commit([TURN_FINISHED]);
      expect(message(services, TURN_FINISHED.uuid)?.content).toEqual([{ type: 'text', text: 'Worked for 2s' }]);
    });

    it('publishes an API error as system, not as a reply', async () => {
      const services = publishing();
      await services.changes.commit([API_ERROR]);
      expect(message(services, API_ERROR.uuid)).toMatchObject({ role: 'system', audience: { model: false, user: true } });
    });
  });

  describe('a query Claude Code starts itself', () => {
    it('gets a query id minted for it', async () => {
      const services = publishing();
      await services.changes.commit([ANSWER]);
      expect(message(services, ANSWER.uuid)?.queryId).toBe('id-1');
    });

    it('carries no from on a prompt', async () => {
      const services = publishing();
      await services.changes.commit([PROMPT]);
      expect(message(services, PROMPT.uuid)).not.toHaveProperty('from');
    });
  });

  describe('files', () => {
    it('stores the image in the durable bucket, named under the conversation', async () => {
      const services = await firstQuery();
      expect(services.broker.objects.map(({ bucket, name }) => ({ bucket, name }))).toEqual([{ bucket: 'durable-test', name: `${ID}/id-3` }]);
    });

    it("stores the image's bytes", async () => {
      const services = await firstQuery();
      expect(Buffer.from(services.broker.objects[0]?.data ?? []).equals(Buffer.from(PNG_BASE64, 'base64'))).toBe(true);
    });

    it('names the message that references it and its media type in its metadata', async () => {
      const services = await firstQuery();
      expect(services.broker.objects[0]?.metadata).toEqual({ messageId: IMAGE_TOOL_RESULT.uuid, mediaType: 'image/png' });
    });

    it('stores it before the message that references it is published', async () => {
      const services = await firstQuery();
      const referencing = services.broker.published.findIndex((published) => published.body.id === IMAGE_TOOL_RESULT.uuid);
      expect(services.broker.objects[0]?.publishedBefore).toBe(referencing);
    });

    it('publishes a reference block in place of the bytes', async () => {
      const services = await firstQuery();
      expect(message(services, IMAGE_TOOL_RESULT.uuid)?.content).toEqual([
        {
          tool_use_id: 'toolu_018yQgWWFdcauitggzkBdjjb',
          type: 'tool_result',
          content: [{ type: 'image', source: { type: 'object', id: `${ID}/id-3`, bucket: 'durable-test', mediaType: 'image/png', size: 98 } }],
        },
      ]);
    });

    it('stores a file at the top of the content too', async () => {
      const services = publishing();
      await services.changes.commit([{ type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'document', source: { type: 'base64', data: 'JVBERg==', media_type: 'application/pdf' } }] } }]);
      expect(message(services, 'u1')?.content).toEqual([{ type: 'document', source: { type: 'object', id: `${ID}/id-3`, bucket: 'durable-test', mediaType: 'application/pdf', size: 4 } }]);
    });

    describe('that cannot be stored', () => {
      async function failing() {
        const services = publishing();
        services.broker.storeFailure = new Error('no responders');
        await services.changes.openQuery('q1', HUMAN);
        await services.changes.commit(FIRST_QUERY);
        await services.changes.close('completed');
        return services;
      }

      it('does not publish the message', async () => {
        const services = await failing();
        expect(message(services, IMAGE_TOOL_RESULT.uuid)).toBeUndefined();
      });

      it('aborts the query', async () => {
        const services = await failing();
        expect(services.aborts()).toBe(1);
      });

      it('publishes nothing more of the query', async () => {
        const services = await failing();
        expect(messages(services).map((body) => body.id)).toEqual([PROMPT.uuid, DATE_ATTACHMENT.uuid, THINKING.uuid, TOOL_USE.uuid]);
      });

      it('closes the query aborted', async () => {
        const services = await failing();
        expect(services.broker.published.at(-1)?.body).toEqual({ ts: FAKE_TIMESTAMP, instanceId: 'inst-1', queryId: 'q1', reason: 'aborted' });
      });

      it('says why', async () => {
        const services = await failing();
        expect(services.host.logs).toEqual([`conversation ${ID}: storing a file of message ${IMAGE_TOOL_RESULT.uuid} failed, so query q1 is aborted: no responders`]);
      });

      it('publishes the next query', async () => {
        const services = await failing();
        services.broker.storeFailure = undefined;
        await services.changes.openQuery('q2', HUMAN);
        await services.changes.commit([SECOND_PROMPT]);
        expect(message(services, SECOND_PROMPT.uuid)?.queryId).toBe('q2');
      });
    });

    it('treats a file with no media type as one that cannot be stored', async () => {
      const services = publishing();
      await services.changes.commit([{ type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', data: PNG_BASE64 } }] } }]);
      expect(message(services, 'u1')).toBeUndefined();
    });
  });

  it('keeps publishing the rest of a batch when one entry fails', async () => {
    const services = publishing();
    const publish = services.broker.publish.bind(services.broker);
    let calls = 0;
    services.broker.publish = (subject, body) => {
      calls += 1;
      if (calls === 1) {
        throw new Error('not connected to NATS');
      }
      publish(subject, body);
    };
    await services.changes.commit([PROMPT, THINKING]);
    expect(messages(services).map((body) => body.id)).toEqual([THINKING.uuid]);
  });
});
