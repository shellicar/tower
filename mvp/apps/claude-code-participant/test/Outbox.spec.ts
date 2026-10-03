import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PublishRejected } from '../src/AckedPublish.js';
import { MAX_PAYLOAD_BYTES, Outbox } from '../src/Outbox.js';
import { settle, testServices } from './support.js';

const SUBJECT = 'conv.v2.c1.changes.message';

/** An outbox on its own file in a fresh directory, publishing through the fake broker. */
function outboxOnDisk(dir = mkdtempSync(join(tmpdir(), 'outbox-spec-'))) {
  const services = testServices();
  const outbox = new Outbox(join(dir, 'outbox.db'), { broker: services.broker, host: services.host, timer: services.timer });
  return { ...services, outbox, dir, reopen: () => new Outbox(join(dir, 'outbox.db'), { broker: services.broker, host: services.host, timer: services.timer }) };
}

function body(n: string): string {
  return JSON.stringify({ n });
}

describe('Outbox', () => {
  describe('publishing', () => {
    it('publishes each message with its id, in the order they were queued', async () => {
      const services = outboxOnDisk();
      services.outbox.start();
      services.outbox.enqueue(SUBJECT, 'a', body('a'));
      services.outbox.enqueue(SUBJECT, 'b', body('b'));
      await settle();
      expect(services.broker.ackedIds).toEqual(['a', 'b']);
    });

    it('publishes the message body as it was queued', async () => {
      const services = outboxOnDisk();
      services.outbox.start();
      services.outbox.enqueue(SUBJECT, 'a', body('a'));
      await settle();
      expect(services.broker.published).toEqual([{ subject: SUBJECT, body: { n: 'a' } }]);
    });

    it('publishes nothing before it is started', async () => {
      const services = outboxOnDisk();
      services.outbox.enqueue(SUBJECT, 'a', body('a'));
      await settle();
      expect(services.broker.ackedIds).toEqual([]);
    });
  });

  describe('a publish that fails', () => {
    it('is tried again until it is acknowledged', async () => {
      const services = outboxOnDisk();
      services.broker.ackFailures.push(new Error('no connection'), new Error('timeout'));
      services.outbox.start();
      services.outbox.enqueue(SUBJECT, 'a', body('a'));
      await settle();
      expect(services.broker.ackedIds).toEqual(['a']);
    });

    it('is not overtaken by the messages queued after it', async () => {
      const services = outboxOnDisk();
      services.broker.ackFailures.push(new Error('no connection'), new Error('timeout'));
      services.outbox.start();
      services.outbox.enqueue(SUBJECT, 'a', body('a'));
      services.outbox.enqueue(SUBJECT, 'b', body('b'));
      await settle();
      expect(services.broker.ackedIds).toEqual(['a', 'b']);
    });

    it('is logged once however often it is tried', async () => {
      const services = outboxOnDisk();
      services.broker.ackFailures.push(new Error('no connection'), new Error('no connection'), new Error('no connection'));
      services.outbox.start();
      services.outbox.enqueue(SUBJECT, 'a', body('a'));
      await settle();
      expect(services.host.logs).toEqual(['outbox: publishing message a failed, retrying: no connection']);
    });
  });

  describe('a message the stream refuses', () => {
    it('does not hold back the messages after it', async () => {
      const services = outboxOnDisk();
      services.broker.ackFailures.push(new PublishRejected('the stream refused the message'));
      services.outbox.start();
      services.outbox.enqueue(SUBJECT, 'a', body('a'));
      services.outbox.enqueue(SUBJECT, 'b', body('b'));
      await settle();
      expect(services.broker.ackedIds).toEqual(['b']);
    });

    it('is logged with the reason', async () => {
      const services = outboxOnDisk();
      services.broker.ackFailures.push(new PublishRejected('the stream refused the message', { cause: new Error('message size exceeds maximum allowed') }));
      services.outbox.start();
      services.outbox.enqueue(SUBJECT, 'a', body('a'));
      await settle();
      expect(services.host.logs).toEqual([`outbox: the stream refused message a for ${SUBJECT}, kept in the outbox: the stream refused the message: message size exceeds maximum allowed`]);
    });

    it('is not sent again after a restart', async () => {
      const first = outboxOnDisk();
      first.broker.ackFailures.push(new PublishRejected('the stream refused the message'));
      first.outbox.start();
      first.outbox.enqueue(SUBJECT, 'a', body('a'));
      await settle();
      await first.outbox.stop();
      const second = first.reopen();
      second.start();
      await settle();
      expect(first.broker.ackedIds).toEqual([]);
    });
  });

  describe('a message over what NATS carries', () => {
    it('is dropped and logged', async () => {
      const services = outboxOnDisk();
      services.outbox.start();
      services.outbox.enqueue(SUBJECT, 'big', 'x'.repeat(MAX_PAYLOAD_BYTES + 1));
      await settle();
      expect(services.host.logs).toEqual([`outbox: message big for ${SUBJECT} is ${MAX_PAYLOAD_BYTES + 1} bytes, over the ${MAX_PAYLOAD_BYTES} NATS carries, so it is dropped`]);
    });

    it('does not hold back the messages after it', async () => {
      const services = outboxOnDisk();
      services.outbox.start();
      services.outbox.enqueue(SUBJECT, 'big', 'x'.repeat(MAX_PAYLOAD_BYTES + 1));
      services.outbox.enqueue(SUBJECT, 'b', body('b'));
      await settle();
      expect(services.broker.ackedIds).toEqual(['b']);
    });
  });

  describe('a restart', () => {
    it('publishes what the last run left unsent, then what is queued after', async () => {
      const first = outboxOnDisk();
      first.outbox.enqueue(SUBJECT, 'a', body('a'));
      first.outbox.enqueue(SUBJECT, 'b', body('b'));
      await first.outbox.stop();
      const second = first.reopen();
      second.start();
      second.enqueue(SUBJECT, 'c', body('c'));
      await settle();
      expect(first.broker.ackedIds).toEqual(['a', 'b', 'c']);
    });

    it('does not publish again what was acknowledged', async () => {
      const first = outboxOnDisk();
      first.outbox.start();
      first.outbox.enqueue(SUBJECT, 'a', body('a'));
      await settle();
      await first.outbox.stop();
      first.reopen().start();
      await settle();
      expect(first.broker.ackedIds).toEqual(['a']);
    });
  });

  describe('stopping', () => {
    it('publishes what is queued first', async () => {
      const services = outboxOnDisk();
      services.outbox.start();
      services.outbox.enqueue(SUBJECT, 'a', body('a'));
      await services.outbox.stop();
      expect(services.broker.ackedIds).toEqual(['a']);
    });

    it('does not retry a publish that fails', async () => {
      const services = outboxOnDisk();
      services.broker.ackFailures.push(new Error('no connection'));
      services.outbox.start();
      services.outbox.enqueue(SUBJECT, 'a', body('a'));
      await services.outbox.stop();
      expect(services.broker.ackedIds).toEqual([]);
    });

    it('can be asked twice', async () => {
      const services = outboxOnDisk();
      services.outbox.start();
      await services.outbox.stop();
      await expect(services.outbox.stop()).resolves.toBeUndefined();
    });

    it('says so when a message arrives after it closed', async () => {
      const services = outboxOnDisk();
      await services.outbox.stop();
      services.outbox.enqueue(SUBJECT, 'a', body('a'));
      expect(services.host.logs).toEqual([`outbox: message a for ${SUBJECT} arrived after the outbox closed, so it is not queued`]);
    });
  });
});
