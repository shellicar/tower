import { describe, expect, it } from 'vitest';
import { MessageChannel } from '../src/MessageChannel.js';

async function drain<T>(channel: MessageChannel<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of channel) {
    values.push(value);
  }
  return values;
}

describe('MessageChannel', () => {
  it('yields what was pushed before reading, in order', async () => {
    const channel = new MessageChannel<number>();
    channel.push(1);
    channel.push(2);
    channel.close();
    expect(await drain(channel)).toEqual([1, 2]);
  });

  it('yields what is pushed while a reader waits', async () => {
    const channel = new MessageChannel<number>();
    const read = drain(channel);
    channel.push(1);
    channel.close();
    expect(await read).toEqual([1]);
  });

  it('delivers a queued value that is itself undefined', async () => {
    const channel = new MessageChannel<number | undefined>();
    channel.push(undefined);
    channel.push(2);
    channel.close();
    expect(await drain(channel)).toEqual([undefined, 2]);
  });

  it('ends a waiting reader when closed', async () => {
    const channel = new MessageChannel<number>();
    const read = drain(channel);
    channel.close();
    expect(await read).toEqual([]);
  });

  it('refuses a push after close', () => {
    const channel = new MessageChannel<number>();
    channel.close();
    expect(() => channel.push(1)).toThrow('channel is closed');
  });
});
