import { describe, expect, it } from 'vitest';
import { ConversationChanges } from '../src/ConversationChanges.js';
import { IPublisher, PublishingSessionStore } from '../src/SessionStore.js';
import { ANSWER } from './entries.js';
import { delivered, testServices } from './support.js';

const ID = '0f8b7c1e-2a4d-4e6f-9b1a-3c5d7e9f1a2b';
const KEY = { projectKey: '-work-project', sessionId: ID };

function routed() {
  const services = testServices();
  services.timer.holdSleeps = true;
  const changes = new ConversationChanges(ID, { lane: services.outbox.lane(ID), timer: services.timer, ids: services.ids, host: services.host, instanceId: 'inst-1', durableBucket: 'durable-test', abort: () => {} });
  const unroute = services.provider.resolve(IPublisher).route(ID, changes);
  const store = services.provider.resolve(PublishingSessionStore);
  return { ...services, store, unroute };
}

describe('PublishingSessionStore', () => {
  it("publishes a conversation's appended messages on its change stream", async () => {
    const services = routed();
    await services.store.append(KEY, [ANSWER]);
    await delivered();
    expect(services.broker.subjects()).toEqual([`conv.v2.${ID}.changes.message`]);
  });

  it('returns once the entry is on disk, not once the stream has it', async () => {
    const services = routed();
    services.broker.streamFailure = new Error('not connected to NATS');
    await services.store.append(KEY, [ANSWER]);
    expect(services.outboxStore.waiting(ID)).toEqual([ANSWER.uuid]);
  });

  it('rejects when the entry could not be written, so the SDK hands it over again', async () => {
    const services = routed();
    services.outboxStore.writeFailure = new Error('no space left on device');
    await expect(services.store.append(KEY, [ANSWER])).rejects.toThrow('writing message');
  });

  it("publishes nothing from a subagent's record", async () => {
    const services = routed();
    await services.store.append({ ...KEY, subpath: 'subagents/agent-a1' }, [ANSWER]);
    expect(services.broker.published).toEqual([]);
  });

  it('publishes nothing for a conversation that is not served', async () => {
    const services = routed();
    await services.store.append({ ...KEY, sessionId: 'another' }, [ANSWER]);
    expect(services.broker.published).toEqual([]);
  });

  it('says so when a conversation that is not served has entries appended', async () => {
    const services = routed();
    await services.store.append({ ...KEY, sessionId: 'another' }, [ANSWER]);
    expect(services.host.logs).toEqual(["conversation another: 1 entries appended while it isn't served, not published"]);
  });

  it('publishes nothing once the route is removed', async () => {
    const services = routed();
    services.unroute();
    await services.store.append(KEY, [ANSWER]);
    expect(services.broker.published).toEqual([]);
  });

  it('keeps a later route when an earlier one for the same conversation is removed', async () => {
    const services = routed();
    const later = new ConversationChanges(ID, { lane: services.outbox.lane(ID), timer: services.timer, ids: services.ids, host: services.host, instanceId: 'inst-2', durableBucket: 'durable-test', abort: () => {} });
    services.provider.resolve(IPublisher).route(ID, later);
    services.unroute();
    await services.store.append(KEY, [ANSWER]);
    await delivered();
    expect(services.broker.published[0]?.body.instanceId).toBe('inst-2');
  });

  it('loads nothing, so a resume reads the local record', async () => {
    const services = testServices();
    expect(await services.provider.resolve(PublishingSessionStore).load()).toBeNull();
  });
});
