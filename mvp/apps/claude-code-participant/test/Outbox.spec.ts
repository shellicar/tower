import { describe, expect, it } from 'vitest';
import { Outbox } from '../src/Outbox.js';
import { delivered, type FakeOutboxStore, testServices } from './support.js';

const ID = '0c77fb4e-655e-41f2-be80-558ad2aaf6dc';
const SUBJECT = `conv.v2.${ID}.changes.message`;

function outgoing(id: string, extra: { files?: { objectId: string; bytes: Uint8Array }[] } = {}) {
  return { subject: SUBJECT, body: { id }, id, files: (extra.files ?? []).map((file) => ({ ...file, bucket: 'durable-test', metadata: {} })) };
}

function outbox() {
  const services = testServices();
  services.timer.holdSleeps = true;
  return { ...services, lane: services.outbox.lane(ID) };
}

describe('Outbox', () => {
  describe('a message enqueued', () => {
    it('is on disk once enqueue resolves, before the stream has it', async () => {
      const { lane, broker, outboxStore } = outbox();
      broker.streamFailure = new Error('not connected to NATS');
      await lane.enqueue(outgoing('m1'));
      expect(outboxStore.waiting(ID)).toEqual(['m1']);
    });

    it('is removed from disk once the stream has acknowledged it', async () => {
      const { lane, outboxStore } = outbox();
      await lane.enqueue(outgoing('m1'));
      await delivered();
      expect(outboxStore.waiting(ID)).toEqual([]);
    });

    it('reaches the stream under the id it was enqueued with', async () => {
      const { lane, broker } = outbox();
      await lane.enqueue(outgoing('m1'));
      await delivered();
      expect(broker.streamIds).toEqual(['m1']);
    });
  });

  describe('while the stream cannot be reached', () => {
    async function down() {
      const services = outbox();
      services.broker.streamFailure = new Error('not connected to NATS');
      await services.lane.enqueue(outgoing('m1'));
      await services.lane.enqueue(outgoing('m2'));
      await services.lane.enqueue(outgoing('m3'));
      await delivered();
      return services;
    }

    it('keeps every message', async () => {
      const { outboxStore } = await down();
      expect(outboxStore.waiting(ID)).toEqual(['m1', 'm2', 'm3']);
    });

    it('delivers them in the order they were enqueued once it can', async () => {
      const services = await down();
      services.broker.streamFailure = undefined;
      services.timer.wake();
      await delivered();
      expect(services.broker.streamIds).toEqual(['m1', 'm2', 'm3']);
    });

    it('says so once, however many times it tries', async () => {
      const services = await down();
      services.timer.wake();
      await delivered();
      services.timer.wake();
      await delivered();
      expect(services.host.logs).toEqual([`conversation ${ID}: delivering message m1 on ${SUBJECT} failed, so it is kept and tried again: not connected to NATS`]);
    });

    it('waits longer after each failure, up to a limit', async () => {
      const services = outbox();
      const waits: number[] = [];
      let before = 0;
      services.timer.onSleep = (now) => {
        waits.push(now - before);
        before = now;
        if (waits.length === 8) {
          services.broker.streamFailure = undefined;
        }
        services.timer.wake();
      };
      services.broker.streamFailure = new Error('down');
      await services.lane.enqueue(outgoing('m1'));
      await delivered();
      expect(waits).toEqual([250, 500, 1000, 2000, 4000, 5000, 5000, 5000]);
    });
  });

  describe('a message the stream refuses', () => {
    it('holds back the messages behind it and is not skipped', async () => {
      const { lane, broker, outboxStore } = outbox();
      broker.streamFailure = new Error('message size exceeds maximum allowed');
      await lane.enqueue(outgoing('big'));
      await lane.enqueue(outgoing('small'));
      await delivered();
      expect(outboxStore.waiting(ID)).toEqual(['big', 'small']);
    });

    it('is delivered, and then the messages behind it, once the cause is removed', async () => {
      const { lane, broker, timer } = outbox();
      broker.streamFailure = new Error('message size exceeds maximum allowed');
      await lane.enqueue(outgoing('big'));
      await lane.enqueue(outgoing('small'));
      await delivered();
      broker.streamFailure = undefined;
      timer.wake();
      await delivered();
      expect(broker.streamIds).toEqual(['big', 'small']);
    });
  });

  describe('a message over what the broker accepts', () => {
    async function oversized() {
      const services = outbox();
      services.broker.maxPayload = 20;
      await services.lane.enqueue(outgoing('first'));
      await services.lane.enqueue({ subject: SUBJECT, id: 'huge', body: { id: 'huge', padding: 'x'.repeat(100) } });
      await services.lane.enqueue(outgoing('last'));
      await delivered();
      return services;
    }

    it('is dropped and the messages around it are delivered', async () => {
      const { broker } = await oversized();
      expect(broker.streamIds).toEqual(['first', 'last']);
    });

    it('is removed from disk', async () => {
      const { outboxStore } = await oversized();
      expect(outboxStore.waiting(ID)).toEqual([]);
    });

    it('is logged', async () => {
      const { host } = await oversized();
      expect(host.logs).toEqual([expect.stringContaining(`message huge on ${SUBJECT} is dropped, and the messages after it go on`)]);
    });
  });

  describe('an acknowledgement that is lost', () => {
    it('is not stored twice when the message is sent again', async () => {
      const { lane, broker, timer } = outbox();
      broker.afterTaken = () => {
        broker.afterTaken = undefined;
        throw new Error('timed out');
      };
      await lane.enqueue(outgoing('m1'));
      await delivered();
      timer.wake();
      await delivered();
      expect(broker.streamIds).toEqual(['m1']);
    });

    it('still removes the message once it is acknowledged', async () => {
      const { lane, broker, timer, outboxStore } = outbox();
      broker.afterTaken = () => {
        broker.afterTaken = undefined;
        throw new Error('timed out');
      };
      await lane.enqueue(outgoing('m1'));
      await delivered();
      timer.wake();
      await delivered();
      expect(outboxStore.waiting(ID)).toEqual([]);
    });
  });

  describe('a run that ended with messages still on disk', () => {
    function restarted(onDisk: FakeOutboxStore) {
      const services = testServices();
      services.timer.holdSleeps = true;
      const store = services.outboxStore;
      for (const [conversation, directory] of onDisk.conversationsOnDisk) {
        store.conversationsOnDisk.set(conversation, directory);
      }
      return services;
    }

    async function leftBehind() {
      const first = outbox();
      first.broker.streamFailure = new Error('not connected to NATS');
      await first.lane.enqueue(outgoing('m1'));
      await first.lane.enqueue(outgoing('m2', { files: [{ objectId: `${ID}/m2.0`, bytes: new Uint8Array([1, 2, 3]) }] }));
      return first.outboxStore;
    }

    it('delivers them, in order, when the next run resumes', async () => {
      const services = restarted(await leftBehind());
      await services.outbox.resume();
      await delivered();
      expect(services.broker.streamIds).toEqual(['m1', 'm2']);
    });

    it('stores the files of a message that had them, with their bytes', async () => {
      const services = restarted(await leftBehind());
      await services.outbox.resume();
      await delivered();
      expect(services.broker.objects.map(({ name, data }) => ({ name, data: [...data] }))).toEqual([{ name: `${ID}/m2.0`, data: [1, 2, 3] }]);
    });

    it('puts what the next run enqueues behind them', async () => {
      const services = restarted(await leftBehind());
      services.broker.streamFailure = new Error('still down');
      await services.outbox.resume();
      await services.outbox.lane(ID).enqueue(outgoing('m3'));
      await delivered();
      expect(services.outboxStore.waiting(ID)).toEqual(['m1', 'm2', 'm3']);
    });
  });

  describe('a message with a file', () => {
    it('has its file stored before it is published', async () => {
      const { lane, broker } = outbox();
      await lane.enqueue(outgoing('m1', { files: [{ objectId: `${ID}/m1.0`, bytes: new Uint8Array([9]) }] }));
      await delivered();
      expect(broker.objects[0]?.publishedBefore).toBe(0);
    });

    it('is kept, with its bytes, while the object store cannot take it', async () => {
      const { lane, broker, outboxStore } = outbox();
      broker.storeFailure = new Error('no responders');
      await lane.enqueue(outgoing('m1', { files: [{ objectId: `${ID}/m1.0`, bytes: new Uint8Array([9]) }] }));
      await delivered();
      expect(
        outboxStore.conversationsOnDisk
          .get(ID)
          ?.get(1)
          ?.blobs.map((blob) => [...blob]),
      ).toEqual([[9]]);
    });

    it('does not store its file again when only the publish failed', async () => {
      const { lane, broker, timer } = outbox();
      broker.streamFailure = new Error('down');
      await lane.enqueue(outgoing('m1', { files: [{ objectId: `${ID}/m1.0`, bytes: new Uint8Array([9]) }] }));
      await delivered();
      timer.wake();
      await delivered();
      expect(broker.objects).toHaveLength(1);
    });
  });

  describe('closing', () => {
    it('delivers what the stream takes now', async () => {
      const { lane, broker } = outbox();
      await lane.enqueue(outgoing('m1'));
      await lane.close();
      expect(broker.streamIds).toEqual(['m1']);
    });

    it('stops at the first message the stream will not take, and leaves it on disk', async () => {
      const { lane, broker, outboxStore } = outbox();
      broker.streamFailure = new Error('down');
      await lane.enqueue(outgoing('m1'));
      await lane.close();
      expect(outboxStore.waiting(ID)).toEqual(['m1']);
    });
  });

  it('gives a conversation one lane', () => {
    const { outbox: instance } = outbox();
    expect(instance.lane(ID)).toBe(instance.lane(ID));
  });

  it('is one service', () => {
    const { provider } = outbox();
    expect(provider.resolve(Outbox)).toBe(provider.resolve(Outbox));
  });
});
