import { describe, expect, it } from 'vitest';
import { NullPublisher, PublishingSessionStore } from '../src/SessionStore.js';
import { testServices } from './support.js';

const KEY = { projectKey: '-work-project', sessionId: '0f8b7c1e-2a4d-4e6f-9b1a-3c5d7e9f1a2b' };
const ENTRIES = [
  { type: 'user', uuid: 'a' },
  { type: 'assistant', uuid: 'b' },
];

describe('PublishingSessionStore', () => {
  it('hands every appended entry to the publisher', async () => {
    const services = testServices();
    await services.provider.resolve(PublishingSessionStore).append(KEY, ENTRIES);
    expect(services.publisher.published).toEqual([{ key: KEY, entries: ENTRIES }]);
  });

  it('loads nothing, so a resume reads the local record', async () => {
    const services = testServices();
    expect(await services.provider.resolve(PublishingSessionStore).load()).toBeNull();
  });
});

describe('NullPublisher', () => {
  it('accepts entries and does nothing', async () => {
    await expect(new NullPublisher().publish()).resolves.toBeUndefined();
  });
});
