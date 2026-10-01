import type { SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import { dependsOn } from '@shellicar/core-di';
import type { ConversationChanges } from './ConversationChanges.js';
import { IHost } from './Host.js';

/** Where each transcript entry Claude Code commits goes: tower's bus. */
export abstract class IPublisher {
  public abstract publish(key: SessionKey, entries: SessionStoreEntry[]): Promise<void>;
  /** Hands each later append to conversation `id`'s record to `changes`, until the returned function is called. */
  public abstract route(id: string, changes: ConversationChanges): () => void;
}

/**
 * Hands each conversation's entries to its change stream. A subagent's
 * record, and a conversation nothing is serving, publish nothing.
 */
export class BusPublisher implements IPublisher {
  @dependsOn(IHost) private readonly host!: IHost;
  private readonly routes = new Map<string, ConversationChanges>();

  public publish(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    if (key.subpath !== undefined) {
      return Promise.resolve();
    }
    const changes = this.routes.get(key.sessionId);
    if (changes === undefined) {
      this.host.log(`conversation ${key.sessionId}: ${entries.length} entries appended while it isn't served, not published`);
      return Promise.resolve();
    }
    return changes.commit(entries);
  }

  public route(id: string, changes: ConversationChanges): () => void {
    this.routes.set(id, changes);
    return () => {
      if (this.routes.get(id) === changes) {
        this.routes.delete(id);
      }
    };
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
  // agent's config dir. Returning entries would resume from a temporary copy
  // the SDK writes instead.
  public load(): Promise<null> {
    return Promise.resolve(null);
  }
}
