import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RecordEntry } from '../src/ConversationEntries.js';
import { EXITS } from '../src/ExitCodes.js';
import { Presence } from '../src/Presence.js';
import { ServingGate } from '../src/ServingGate.js';
import { PublishingSessionStore } from '../src/SessionStore.js';
import { Shutdown } from '../src/Shutdown.js';
import { ANSWER, IMAGE_TOOL_RESULT, INTERRUPT_MARKER, PROMPT, THINKING, TOOL_USE } from './entries.js';
import { CONFIGURED, delivered, FAKE_TIMESTAMP, resultMessage, taskStarted, testConfig, testServices } from './support.js';

const ID = '0f8b7c1e-2a4d-4e6f-9b1a-3c5d7e9f1a2b';
const WORLD = 'agent.v1.test-world';
const CONV = `conv.v2.${ID}`;

function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Writes Claude Code's transcript of the conversation into the config dir, as Claude Code would. */
function writeTranscript(configDir: string, ...uuids: string[]): void {
  const project = join(configDir, 'projects', '-work-project');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, `${ID}.jsonl`), uuids.map((uuid, n) => JSON.stringify({ type: n % 2 === 0 ? 'user' : 'assistant', uuid })).join('\n'));
}

/** Writes these entries as Claude Code's transcript of the conversation. */
function writeEntries(configDir: string, ...entries: RecordEntry[]): void {
  const project = join(configDir, 'projects', '-work-project');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, `${ID}.jsonl`), entries.map((entry) => JSON.stringify(entry)).join('\n'));
}

/** A configured participant that has announced itself on the bus. */
async function started(options: { configure?: boolean } = {}) {
  const configDir = scratch('participant-config-');
  const services = testServices(testConfig({ configDir }));
  if (options.configure !== false) {
    services.control(...CONFIGURED);
  }
  const presence = services.provider.resolve(Presence);
  await presence.start();
  return { ...services, configDir, presence, cwd: scratch('participant-cwd-') };
}

type Started = Awaited<ReturnType<typeof started>>;

function service(services: Started, body: Record<string, unknown>) {
  return services.broker.request(`${WORLD}.requests.service`, { ts: FAKE_TIMESTAMP, ...body });
}

/** A started participant holding the conversation. */
async function serving() {
  const services = await started();
  const reply = await service(services, { conversationId: ID, cwd: services.cwd });
  const launch = services.claudeCode.launches[0];
  if (launch === undefined) {
    throw new Error(`nothing was launched: ${JSON.stringify(reply)}`);
  }
  return { ...services, launch };
}

type Serving = Awaited<ReturnType<typeof serving>>;

function say(services: Started, text: string, tip: string | null, extra: Record<string, unknown> = {}) {
  return services.broker.request(`${CONV}.requests.say`, { ts: FAKE_TIMESTAMP, from: { kind: 'human' }, text, precondition: { tip }, ...extra });
}

function cancel(services: Started, id: string) {
  return services.broker.request(`${CONV}.requests.cancel`, { ts: FAKE_TIMESTAMP, id });
}

/** The query id an accepted say replied with. */
async function acceptedQuery(services: Serving, text: string, tip: string | null): Promise<string> {
  const reply = await say(services, text, tip);
  if (reply === undefined || !('accepted' in reply) || reply.id === undefined) {
    throw new Error(`the say was not accepted: ${JSON.stringify(reply)}`);
  }
  return reply.id;
}

/** Claude Code finishing the running query: its transcript grows, then its result arrives. */
async function finishQuery(services: Serving, ...transcript: string[]): Promise<void> {
  writeTranscript(services.configDir, ...transcript);
  services.launch.replies.push(resultMessage());
  await delivered();
}

describe('Presence', () => {
  describe('starting', () => {
    it('joins the world queue group for its requests', async () => {
      const { broker } = await started();
      expect(broker.subscriptions.map(({ subject, queue }) => ({ subject, queue }))).toEqual([{ subject: `${WORLD}.requests.>`, queue: 'servicers' }]);
    });

    it('publishes ready, then a first pulse', async () => {
      const { broker } = await started();
      expect(broker.subjects()).toEqual([`${WORLD}.telemetry.ready`, `${WORLD}.telemetry.pulse`]);
    });

    it('delivers nothing from the outbox when shutdown began while it was connecting', async () => {
      const services = testServices(testConfig({ configDir: scratch('participant-config-') }));
      services.outboxStore.conversationsOnDisk.set(ID, new Map([[1, { record: { id: 'left-behind', subject: `${CONV}.changes.message`, body: { id: 'left-behind' }, files: [] }, blobs: [] }]]));
      const connected = Promise.withResolvers<void>();
      services.broker.connectHold = connected.promise;
      const start = services.provider.resolve(Presence).start();
      services.provider.resolve(Shutdown).ask('SIGINT');
      await delivered();
      connected.resolve();
      await start;
      await delivered();
      expect(services.broker.published).toEqual([]);
    });

    it('delivers what an earlier run left in the outbox', async () => {
      const services = testServices(testConfig({ configDir: scratch('participant-config-') }));
      services.outboxStore.conversationsOnDisk.set(ID, new Map([[1, { record: { id: 'left-behind', subject: `${CONV}.changes.message`, body: { id: 'left-behind' }, files: [] }, blobs: [] }]]));
      await services.provider.resolve(Presence).start();
      await delivered();
      expect(services.broker.published.filter(({ subject }) => subject.startsWith(CONV)).map(({ body }) => body.id)).toEqual(['left-behind']);
    });

    it('announces a freshly minted instance id', async () => {
      const { broker } = await started();
      expect(broker.published[0]?.body).toEqual({ ts: FAKE_TIMESTAMP, instanceId: 'id-1' });
    });

    it('pulses with a 30 second interval', async () => {
      const { broker } = await started();
      expect(broker.published[1]?.body).toEqual({ ts: FAKE_TIMESTAMP, instanceId: 'id-1', intervalS: 30 });
    });

    it('pulses again every 30 seconds', async () => {
      const { timer } = await started();
      expect(timer.repeating.map(({ ms }) => ms)).toEqual([30_000]);
    });

    it('publishes a pulse on each tick', async () => {
      const { broker, timer } = await started();
      timer.repeating[0]?.tick();
      expect(broker.subjects().filter((subject) => subject.endsWith('.pulse'))).toHaveLength(2);
    });

    it('subscribes to nothing while the serving gate is shut', async () => {
      const services = testServices(testConfig(), { gateShut: true });
      void services.provider.resolve(Presence).start();
      await delivered();
      expect(services.broker.subscriptions).toEqual([]);
    });

    it('announces itself once the serving gate opens', async () => {
      const services = testServices(testConfig(), { gateShut: true });
      const starting = services.provider.resolve(Presence).start();
      services.provider.resolve(ServingGate).open();
      await starting;
      expect(services.broker.subjects()).toEqual([`${WORLD}.telemetry.ready`, `${WORLD}.telemetry.pulse`]);
    });

    it('never announces itself once shutdown has begun', async () => {
      const services = testServices(testConfig(), { gateShut: true });
      const starting = services.provider.resolve(Presence).start();
      services.provider.resolve(Shutdown).ask('SIGINT');
      services.provider.resolve(ServingGate).open();
      await starting;
      expect(services.broker.published).toEqual([]);
    });

    it('fails when NATS cannot be reached', async () => {
      const services = testServices();
      services.broker.connectFailure = new Error('connection refused');
      await expect(services.provider.resolve(Presence).start()).rejects.toThrow('connection refused');
    });
  });

  describe('world requests', () => {
    it('answers drain unsupported', async () => {
      const services = await started();
      expect(await services.broker.request(`${WORLD}.requests.drain`, { ts: FAKE_TIMESTAMP })).toEqual({ rejected: true, reason: 'unsupported' });
    });

    it('answers an unknown request unsupported', async () => {
      const services = await started();
      expect(await services.broker.request(`${WORLD}.requests.teleport`, { ts: FAKE_TIMESTAMP })).toEqual({ rejected: true, reason: 'unsupported' });
    });
  });

  describe('service', () => {
    it('is accepted', async () => {
      const services = await started();
      expect(await service(services, { conversationId: ID, cwd: services.cwd })).toEqual({ accepted: true });
    });

    it('launches Claude Code for the conversation', async () => {
      const { launch } = await serving();
      expect(launch.options.sessionId).toBe(ID);
    });

    it('launches Claude Code in the conversation cwd', async () => {
      const { launch, cwd } = await serving();
      expect(launch.options.cwd).toBe(cwd);
    });

    it('resumes a conversation Claude Code has a record of', async () => {
      const services = await started();
      writeTranscript(services.configDir, 'u1');
      await service(services, { conversationId: ID, cwd: services.cwd });
      expect(services.claudeCode.launches[0]?.options.resume).toBe(ID);
    });

    it('publishes attached with the world, instance, cwd and interval', async () => {
      const { broker, cwd } = await serving();
      expect(broker.published.find(({ subject }) => subject === `${CONV}.attachment.attached`)?.body).toEqual({ ts: FAKE_TIMESTAMP, instanceId: 'id-1', world: 'test-world', cwd, intervalS: 30 });
    });

    it('publishes attached before any message of the conversation', async () => {
      const services = await serving();
      await acceptedQuery(services, 'hello', null);
      await services.provider.resolve(PublishingSessionStore).append({ projectKey: '-work-project', sessionId: ID }, [PROMPT]);
      await delivered();
      expect(services.broker.subjects().filter((subject) => subject.startsWith(CONV))).toEqual([`${CONV}.attachment.attached`, `${CONV}.changes.message`]);
    });

    it('publishes detached after the messages still waiting when it detaches', async () => {
      const services = await serving();
      const held = Promise.withResolvers<void>();
      services.broker.storeHold = held.promise;
      await acceptedQuery(services, 'hello', null);
      await services.provider.resolve(PublishingSessionStore).append({ projectKey: '-work-project', sessionId: ID }, [IMAGE_TOOL_RESULT]);
      const detached = services.presence.detachAll();
      await delivered();
      held.resolve();
      await detached;
      expect(services.broker.subjects().filter((subject) => subject.startsWith(CONV))).toEqual([`${CONV}.attachment.attached`, `${CONV}.changes.message`, `${CONV}.attachment.detached`]);
    });

    describe('when attached cannot be written to disk', () => {
      async function unwritable() {
        const services = await started();
        services.outboxStore.writeFailure = new Error('no space left on device');
        const reply = await service(services, { conversationId: ID, cwd: services.cwd });
        return { ...services, reply };
      }

      it('is rejected failed, with the reason', async () => {
        const { reply } = await unwritable();
        expect(reply).toMatchObject({ rejected: true, reason: 'failed' });
      });

      it('does not answer the conversation’s requests', async () => {
        const { broker } = await unwritable();
        expect(broker.hasResponder(`${CONV}.requests.say`)).toBe(false);
      });

      it('closes the input of the Claude Code it launched', async () => {
        const services = await unwritable();
        const input = await Promise.race([services.claudeCode.launches[0]?.done.then(() => 'closed'), delivered().then(() => 'open')]);
        expect(input).toBe('closed');
      });

      it('can be asked for again once it can be written', async () => {
        const services = await unwritable();
        services.outboxStore.writeFailure = undefined;
        expect(await service(services, { conversationId: ID, cwd: services.cwd })).toEqual({ accepted: true });
      });
    });

    it("answers the conversation's requests once accepted", async () => {
      const { broker } = await serving();
      expect(broker.hasResponder(`${CONV}.requests.say`)).toBe(true);
    });

    it('is rejected invalid without a conversation id', async () => {
      const services = await started();
      expect(await service(services, { cwd: services.cwd })).toMatchObject({ rejected: true, reason: 'invalid' });
    });

    it('is rejected invalid with an empty conversation id', async () => {
      const services = await started();
      expect(await service(services, { conversationId: '', cwd: services.cwd })).toMatchObject({ rejected: true, reason: 'invalid' });
    });

    it('is rejected invalid with a conversation id that is not a UUID', async () => {
      const services = await started();
      expect(await service(services, { conversationId: 'conv-abc', cwd: services.cwd })).toMatchObject({ rejected: true, reason: 'invalid' });
    });

    it('is rejected invalid without a cwd', async () => {
      const services = await started();
      expect(await service(services, { conversationId: ID })).toMatchObject({ rejected: true, reason: 'invalid' });
    });

    it('is rejected invalid_cwd for a relative cwd', async () => {
      const services = await started();
      expect(await service(services, { conversationId: ID, cwd: 'work/project' })).toMatchObject({ rejected: true, reason: 'invalid_cwd' });
    });

    it('is rejected invalid_cwd for a cwd that does not exist', async () => {
      const services = await started();
      expect(await service(services, { conversationId: ID, cwd: join(services.cwd, 'missing') })).toMatchObject({ rejected: true, reason: 'invalid_cwd' });
    });

    it('is rejected invalid_cwd for a cwd that is a file', async () => {
      const services = await started();
      const file = join(services.cwd, 'file');
      writeFileSync(file, '');
      expect(await service(services, { conversationId: ID, cwd: file })).toMatchObject({ rejected: true, reason: 'invalid_cwd' });
    });

    it('launches nothing when rejected', async () => {
      const services = await started();
      await service(services, { conversationId: ID, cwd: 'work/project' });
      expect(services.claudeCode.launches).toEqual([]);
    });

    it('is rejected already_attached for a conversation it holds', async () => {
      const services = await serving();
      expect(await service(services, { conversationId: ID, cwd: services.cwd })).toEqual({ rejected: true, reason: 'already_attached' });
    });

    it('is rejected already_attached while the same conversation is still being taken', async () => {
      const services = await started();
      const [first, second] = await Promise.all([service(services, { conversationId: ID, cwd: services.cwd }), service(services, { conversationId: ID, cwd: services.cwd })]);
      expect([first, second]).toEqual([{ accepted: true }, { rejected: true, reason: 'already_attached' }]);
    });

    it('can be taken again after a rejection', async () => {
      const services = await started();
      await service(services, { conversationId: ID, cwd: 'work/project' });
      expect(await service(services, { conversationId: ID, cwd: services.cwd })).toEqual({ accepted: true });
    });

    it('is rejected failed, saying what is missing, until configured', async () => {
      const services = await started({ configure: false });
      expect(await service(services, { conversationId: ID, cwd: services.cwd })).toMatchObject({ rejected: true, reason: 'failed', detail: expect.stringContaining('model.name') });
    });

    it('is rejected unsupported when it names a model', async () => {
      const services = await started();
      expect(await service(services, { conversationId: ID, cwd: services.cwd, model: 'claude-opus-5-5' })).toMatchObject({ rejected: true, reason: 'unsupported' });
    });

    it('is rejected unavailable when it reaches the instance after unavailable', async () => {
      const services = await started();
      const [worldRequests] = services.broker.subscriptions;
      services.presence.stopServing();
      const reply = await new Promise((resolve) => worldRequests?.handle({ subject: `${WORLD}.requests.service`, body: { conversationId: ID, cwd: services.cwd }, reply: resolve }));
      expect(reply).toEqual({ rejected: true, reason: 'unavailable' });
    });
  });

  describe('say', () => {
    it('is accepted with a query id', async () => {
      const services = await serving();
      expect(await say(services, 'hello', null)).toEqual({ accepted: true, id: 'id-3' });
    });

    it('sends the text to Claude Code', async () => {
      const services = await serving();
      await say(services, 'hello', null);
      await delivered();
      expect(services.launch.sent[0]?.message.content).toContainEqual({ type: 'text', text: 'hello' });
    });

    it('is rejected stale when it names a tip a new conversation does not have', async () => {
      const services = await serving();
      expect(await say(services, 'hello', 'm4')).toEqual({ rejected: true, reason: 'stale' });
    });

    it('is rejected stale while a query runs', async () => {
      const services = await serving();
      await say(services, 'hello', null);
      expect(await say(services, 'again', null)).toEqual({ rejected: true, reason: 'stale' });
    });

    it('sends nothing to Claude Code when rejected', async () => {
      const services = await serving();
      await say(services, 'hello', null);
      await say(services, 'again', null);
      await delivered();
      expect(services.launch.sent).toHaveLength(1);
    });

    it('accepts one of two says against the same tip that arrive together', async () => {
      const services = await serving();
      const replies = await Promise.all([say(services, 'one', null), say(services, 'two', null)]);
      expect(replies).toEqual([
        { accepted: true, id: 'id-3' },
        { rejected: true, reason: 'stale' },
      ]);
    });

    it("is accepted once the query has ended, against Claude Code's last message", async () => {
      const services = await serving();
      await say(services, 'hello', null);
      await finishQuery(services, 'u1', 'a1');
      expect(await say(services, 'again', 'a1')).toEqual({ accepted: true, id: 'id-5' });
    });

    it("is rejected stale once the query has ended, against anything but Claude Code's last message", async () => {
      const services = await serving();
      await say(services, 'hello', null);
      await finishQuery(services, 'u1', 'a1');
      expect(await say(services, 'again', 'u1')).toEqual({ rejected: true, reason: 'stale' });
    });

    it('is rejected unsupported when it carries attachments', async () => {
      const services = await serving();
      const attachments = [{ type: 'image', source: { type: 'object', id: 'att-1', bucket: 'attach' } }];
      expect(await say(services, 'look', null, { attachments })).toMatchObject({ rejected: true, reason: 'unsupported' });
    });

    it('is rejected invalid without a precondition', async () => {
      const services = await serving();
      expect(await services.broker.request(`${CONV}.requests.say`, { ts: FAKE_TIMESTAMP, from: { kind: 'human' }, text: 'hello' })).toMatchObject({ rejected: true, reason: 'invalid' });
    });

    it('is rejected unavailable once the instance is unavailable', async () => {
      const services = await serving();
      services.presence.stopServing();
      expect(await say(services, 'hello', null)).toEqual({ rejected: true, reason: 'unavailable' });
    });
  });

  describe('cancel', () => {
    it('is accepted for the running query', async () => {
      const services = await serving();
      const query = await acceptedQuery(services, 'hello', null);
      expect(await cancel(services, query)).toEqual({ accepted: true });
    });

    it('interrupts Claude Code', async () => {
      const services = await serving();
      const query = await acceptedQuery(services, 'hello', null);
      await cancel(services, query);
      expect(services.launch.interrupts).toEqual([false]);
    });

    it('stops no subagent', async () => {
      const services = await serving();
      const query = await acceptedQuery(services, 'hello', null);
      services.launch.replies.push(taskStarted('agent-1', 'local_agent'));
      await delivered();
      await cancel(services, query);
      expect(services.launch.stops).toEqual([]);
    });

    it('is rejected already_complete for a query that has ended', async () => {
      const services = await serving();
      const query = await acceptedQuery(services, 'hello', null);
      await finishQuery(services, 'u1', 'a1');
      expect(await cancel(services, query)).toEqual({ rejected: true, reason: 'already_complete' });
    });

    it("is rejected already_complete once Claude Code's messages have ended mid-query", async () => {
      const services = await serving();
      const query = await acceptedQuery(services, 'hello', null);
      services.launch.replies.close();
      await delivered();
      expect(await cancel(services, query)).toEqual({ rejected: true, reason: 'already_complete' });
    });

    it('is rejected not_found for a query it never accepted', async () => {
      const services = await serving();
      expect(await cancel(services, 'q-unknown')).toEqual({ rejected: true, reason: 'not_found' });
    });

    it('is still answered once the instance is unavailable', async () => {
      const services = await serving();
      const query = await acceptedQuery(services, 'hello', null);
      services.presence.stopServing();
      expect(await cancel(services, query)).toEqual({ accepted: true });
    });
  });

  describe('changes', () => {
    const KEY = { projectKey: '-work-project', sessionId: ID };

    /** Claude Code appending to its record, as the session store receives it. */
    async function append(services: Serving, ...entries: RecordEntry[]): Promise<void> {
      await services.provider.resolve(PublishingSessionStore).append(KEY, entries);
      await delivered();
    }

    function changes(services: Serving) {
      return services.broker.published.filter(({ subject }) => subject.startsWith(`${CONV}.changes.`));
    }

    function closure(services: Serving) {
      return services.broker.published.find(({ subject }) => subject === `${CONV}.changes.query.closed`)?.body;
    }

    it("publishes a say's prompt in the query the say was accepted as, with the say's from", async () => {
      const services = await serving();
      const queryId = await acceptedQuery(services, 'hello', null);
      await append(services, PROMPT);
      expect(changes(services)[0]?.body).toMatchObject({ id: PROMPT.uuid, queryId, from: { kind: 'human' } });
    });

    it('carries the instance id on each change', async () => {
      const services = await serving();
      await acceptedQuery(services, 'hello', null);
      await append(services, PROMPT);
      expect(changes(services)[0]?.body.instanceId).toBe('id-1');
    });

    it('closes the query completed once Claude Code sends its result', async () => {
      const services = await serving();
      const queryId = await acceptedQuery(services, 'hello', null);
      await append(services, PROMPT, ANSWER);
      services.launch.replies.push(resultMessage());
      await delivered();
      expect(closure(services)).toEqual({ ts: FAKE_TIMESTAMP, instanceId: 'id-1', queryId, reason: 'completed' });
    });

    it("publishes the closure after the query's messages", async () => {
      const services = await serving();
      await acceptedQuery(services, 'hello', null);
      await append(services, PROMPT, ANSWER);
      services.launch.replies.push(resultMessage());
      await delivered();
      expect(changes(services).map(({ subject }) => subject.slice(CONV.length + 1))).toEqual(['changes.message', 'changes.message', 'changes.query.closed']);
    });

    it('publishes the closure after a message whose file is still being stored when the result arrives', async () => {
      const services = await serving();
      const held = Promise.withResolvers<void>();
      services.broker.storeHold = held.promise;
      await acceptedQuery(services, 'hello', null);
      const appended = append(services, PROMPT, IMAGE_TOOL_RESULT);
      services.launch.replies.push(resultMessage());
      await delivered();
      held.resolve();
      await appended;
      await delivered();
      expect(changes(services).map(({ subject }) => subject.slice(CONV.length + 1))).toEqual(['changes.message', 'changes.message', 'changes.query.closed']);
    });

    it('closes a cancelled query cancelled', async () => {
      const services = await serving();
      const queryId = await acceptedQuery(services, 'hello', null);
      await cancel(services, queryId);
      services.launch.replies.push(resultMessage('error_during_execution'));
      await delivered();
      expect(closure(services)?.reason).toBe('cancelled');
    });

    it('closes a query that failed aborted', async () => {
      const services = await serving();
      await acceptedQuery(services, 'hello', null);
      services.launch.replies.push(resultMessage('error_during_execution'));
      await delivered();
      expect(closure(services)?.reason).toBe('aborted');
    });

    it('closes the running query aborted when Claude Code stops sending', async () => {
      const services = await serving();
      await acceptedQuery(services, 'hello', null);
      services.launch.replies.close();
      await delivered();
      expect(closure(services)?.reason).toBe('aborted');
    });

    const FILE_WITHOUT_MEDIA_TYPE: RecordEntry = { type: 'user', uuid: 'u-no-type', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'JVBERg==' } }] } };

    it('interrupts Claude Code when a file cannot be referenced', async () => {
      const services = await serving();
      await acceptedQuery(services, 'hello', null);
      await append(services, PROMPT, THINKING, TOOL_USE, FILE_WITHOUT_MEDIA_TYPE);
      expect(services.launch.interrupts).toHaveLength(1);
    });

    it('closes the query aborted when a file cannot be referenced', async () => {
      const services = await serving();
      await acceptedQuery(services, 'hello', null);
      await append(services, PROMPT, THINKING, TOOL_USE, FILE_WITHOUT_MEDIA_TYPE);
      services.launch.replies.push(resultMessage('error_during_execution'));
      await delivered();
      expect(closure(services)?.reason).toBe('aborted');
    });

    it('accepts a say premised on the last message it published', async () => {
      const services = await serving();
      await acceptedQuery(services, 'hello', null);
      await append(services, PROMPT, ANSWER, INTERRUPT_MARKER);
      writeEntries(services.configDir, PROMPT, ANSWER, INTERRUPT_MARKER);
      services.launch.replies.push(resultMessage());
      await delivered();
      const lastPublished = changes(services)
        .filter(({ subject }) => subject.endsWith('.message'))
        .at(-1)?.body.id;
      expect(await say(services, 'again', lastPublished as string)).toMatchObject({ accepted: true });
    });

    it('does not stop detaching the others, or deliver what is waiting, when detached cannot be written', async () => {
      const services = await serving();
      await acceptedQuery(services, 'hello', null);
      services.outboxStore.writeFailure = new Error('no space left on device');
      await expect(services.presence.detachAll()).resolves.toBeUndefined();
    });

    it('says when detached is not recorded', async () => {
      const services = await serving();
      services.outboxStore.writeFailure = new Error('no space left on device');
      await services.presence.detachAll();
      expect(services.host.logs.filter((line) => line.includes('detached is not recorded'))).toHaveLength(1);
    });

    it('says when the closure of a query is not recorded, and carries on', async () => {
      const services = await serving();
      await acceptedQuery(services, 'hello', null);
      services.outboxStore.writeFailure = new Error('no space left on device');
      services.launch.replies.push(resultMessage());
      await delivered();
      expect(services.host.logs.filter((line) => line.includes('the closure of the query is not recorded'))).toHaveLength(1);
    });

    it('publishes nothing once detached', async () => {
      const services = await serving();
      await acceptedQuery(services, 'hello', null);
      await services.presence.detachAll();
      await append(services, PROMPT);
      expect(changes(services)).toEqual([]);
    });
  });

  describe('other conversation requests', () => {
    it('answers chdir unsupported', async () => {
      const services = await serving();
      expect(await services.broker.request(`${CONV}.requests.chdir`, { ts: FAKE_TIMESTAMP, cwd: '/work' })).toEqual({ rejected: true, reason: 'unsupported' });
    });
  });

  describe('shutdown', () => {
    /** Serving, with Claude Code started, then shutdown asked for; Claude Code exits when `exit` is called. */
    async function shuttingDown() {
      const services = await serving();
      const child = services.launch.start() as unknown as { exit(code: number): void };
      const before = services.broker.published.length;
      const shutdown = services.provider.resolve(Shutdown);
      shutdown.ask('SIGINT');
      await delivered();
      return { ...services, child, shutdown, publishedSince: () => services.broker.subjects().slice(before) };
    }

    it('stops a subagent Claude Code reported starting', async () => {
      const services = await serving();
      services.launch.start();
      services.launch.replies.push(taskStarted('agent-1', 'local_agent'));
      await delivered();
      services.provider.resolve(Shutdown).ask('SIGINT');
      await delivered();
      expect(services.launch.stops.map((stop) => stop.taskId)).toEqual(['agent-1']);
    });

    it('publishes unavailable at once', async () => {
      const { publishedSince } = await shuttingDown();
      expect(publishedSince()).toEqual([`${WORLD}.telemetry.unavailable`]);
    });

    it("leaves the world's queue group at once", async () => {
      const { broker } = await shuttingDown();
      expect(broker.hasResponder(`${WORLD}.requests.service`)).toBe(false);
    });

    it("still answers the conversation's requests while Claude Code stops", async () => {
      const { broker } = await shuttingDown();
      expect(broker.hasResponder(`${CONV}.requests.cancel`)).toBe(true);
    });

    it('publishes unavailable, detached and offline in that order once Claude Code has exited', async () => {
      const { child, publishedSince } = await shuttingDown();
      child.exit(0);
      await delivered();
      await delivered();
      expect(publishedSince()).toEqual([`${WORLD}.telemetry.unavailable`, `${CONV}.attachment.detached`, `${WORLD}.telemetry.offline`]);
    });

    it('detaches as the instance that attached', async () => {
      const { child, broker } = await shuttingDown();
      child.exit(0);
      await delivered();
      expect(broker.published.find(({ subject }) => subject === `${CONV}.attachment.detached`)?.body).toEqual({ ts: FAKE_TIMESTAMP, instanceId: 'id-1', world: 'test-world' });
    });

    it('stops pulsing', async () => {
      const { child, timer } = await shuttingDown();
      child.exit(0);
      await delivered();
      expect(timer.repeating[0]?.stopped).toBe(true);
    });

    it('drains the connection last', async () => {
      const { child, broker } = await shuttingDown();
      child.exit(0);
      await delivered();
      await delivered();
      expect(broker.ended).toBe('drain');
    });

    it('in stage 2, publishes detached and offline and closes the connection', async () => {
      const { child, shutdown, broker, publishedSince, host } = await shuttingDown();
      shutdown.ask('SIGINT');
      child.exit(null as unknown as number);
      await delivered();
      await delivered();
      expect({ published: publishedSince(), ended: broker.ended, exits: host.exits }).toEqual({
        published: [`${WORLD}.telemetry.unavailable`, `${CONV}.attachment.detached`, `${WORLD}.telemetry.offline`],
        ended: 'close',
        exits: [EXITS.forced.code],
      });
    });

    it('in stage 3, publishes nothing more', async () => {
      const { shutdown, publishedSince } = await shuttingDown();
      shutdown.ask('SIGINT');
      shutdown.ask('SIGINT');
      await delivered();
      expect(publishedSince()).toEqual([`${WORLD}.telemetry.unavailable`]);
    });

    it('publishes nothing when it never announced itself', async () => {
      const services = testServices(testConfig(), { gateShut: true });
      void services.provider.resolve(Presence).start();
      services.provider.resolve(Shutdown).ask('SIGINT');
      await delivered();
      await delivered();
      expect(services.broker.published).toEqual([]);
    });
  });
});
