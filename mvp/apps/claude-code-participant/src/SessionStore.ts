import type { SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import { dependsOn } from '@shellicar/core-di';

/** Where each transcript entry Claude Code commits goes: tower's bus, once built. */
export abstract class IPublisher {
  public abstract publish(key: SessionKey, entries: SessionStoreEntry[]): Promise<void>;
}

/** Publishes nothing, until the publisher that writes to NATS exists. */
export class NullPublisher implements IPublisher {
  public publish(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * The SDK's session store is the commit signal: `append` receives each entry
 * as soon as Claude Code has written it locally (with eager flushing).
 */
export class PublishingSessionStore implements SessionStore {
  @dependsOn(IPublisher) private readonly publisher!: IPublisher;

  public append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    return this.publisher.publish(key, entries);
  }

  // Returning null makes a resume read Claude Code's own local record in the
  // agent's config dir, which is where v0 resumes from. Returning entries
  // would resume from a temporary copy the SDK writes instead.
  public load(): Promise<null> {
    return Promise.resolve(null);
  }
}
