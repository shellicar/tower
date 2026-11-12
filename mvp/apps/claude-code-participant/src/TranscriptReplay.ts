import type { SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import type { ConversationChanges } from './ConversationChanges.js';
import { kindOf } from './ConversationEntries.js';
import type { IIds } from './Ids.js';
import type { IPublisher } from './SessionStore.js';
import type { ITimer } from './Timer.js';

/** The `from` a say typed by a person carries, as tower sends it. */
const HUMAN = { kind: 'human' };

/**
 * The clock a replayed conversation's changes are stamped with: while an
 * entry is being published, its own time, and otherwise the time of `inner`.
 */
export class EntryClock implements ITimer {
  private readonly inner: ITimer;
  private entryTime: string | undefined;

  public constructor(inner: ITimer) {
    this.inner = inner;
  }

  /** Stamps what is published from now on with `time`; undefined goes back to the time of `inner`. */
  public set(time: string | undefined): void {
    this.entryTime = time;
  }

  public now(): number {
    return this.inner.now();
  }

  public timestamp(): string {
    return this.entryTime ?? this.inner.timestamp();
  }

  public sleep(ms: number, wake?: AbortSignal): Promise<void> {
    return this.inner.sleep(ms, wake);
  }

  public every(ms: number, tick: () => void): () => void {
    return this.inner.every(ms, tick);
  }
}

/**
 * A finished session's record replayed through the participant's publishing
 * path, as `importSessionToStore` hands it over: each entry goes to the
 * publisher one at a time, in the order the record holds it, stamped with the
 * entry's own time. Each prompt in the main record first opens a query of its
 * own, from a human.
 */
export class TranscriptReplay implements SessionStore {
  private readonly publisher: IPublisher;
  private readonly changes: ConversationChanges;
  private readonly ids: IIds;
  private readonly clock: EntryClock;

  /** `clock` must be the timer `changes` is published with. */
  public constructor(publisher: IPublisher, changes: ConversationChanges, ids: IIds, clock: EntryClock) {
    this.publisher = publisher;
    this.changes = changes;
    this.ids = ids;
    this.clock = clock;
  }

  public async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    for (const entry of entries) {
      if (key.subpath === undefined && kindOf(entry) === 'prompt') {
        // TODO(claude): undecided: where a replayed query begins. Every entry in the main record the participant classifies as a prompt opens one for now, and no query's closure is published.
        await this.changes.openQuery(this.ids.mint(), HUMAN);
      }
      this.clock.set(typeof entry.timestamp === 'string' ? entry.timestamp : undefined);
      try {
        await this.publisher.publish(key, [entry]);
      } finally {
        this.clock.set(undefined);
      }
    }
  }

  public load(): Promise<null> {
    return Promise.resolve(null);
  }
}

/** The id the stream deduplicates a replayed message by: scoped to the conversation, so each run of one record is stored again. */
export function deliveryId(conversationId: string, id: string): string {
  return `${conversationId}:${id}`;
}

/** A published message, as far as its order is concerned. */
export type PublishedMessage = { id: string; ts: string };

/**
 * A place where publish order and time order disagree: `earlier` were each
 * published after `latest` although their `ts` comes before its.
 */
export type OrderDisagreement<T extends PublishedMessage> = { latest: T; earlier: T[] };

/**
 * Each place in `messages`, taken in publish order, where a message's `ts` is
 * before that of one published ahead of it. A run of such messages behind the
 * same latest message is one place.
 */
export function orderDisagreements<T extends PublishedMessage>(messages: readonly T[]): OrderDisagreement<T>[] {
  const places: OrderDisagreement<T>[] = [];
  let latest: { message: T; time: number } | undefined;
  let open: OrderDisagreement<T> | undefined;
  for (const message of messages) {
    const time = Date.parse(message.ts);
    if (latest !== undefined && time < latest.time) {
      if (open === undefined) {
        open = { latest: latest.message, earlier: [] };
        places.push(open);
      }
      open.earlier.push(message);
      continue;
    }
    open = undefined;
    latest = { message, time };
  }
  return places;
}
