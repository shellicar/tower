import type { SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import type { ConversationChanges } from './ConversationChanges.js';
import { kindOf } from './ConversationEntries.js';
import type { IIds } from './Ids.js';
import type { IPublisher } from './SessionStore.js';

/** The `from` a say typed by a person carries, as tower sends it. */
const HUMAN = { kind: 'human' };

/**
 * A finished session's record replayed through the participant's publishing
 * path, as `importSessionToStore` hands it over: each entry goes to the
 * publisher one at a time, in the order the record holds it, and each prompt
 * opens a query of its own first, as a say does when the participant serves
 * the conversation live.
 */
export class TranscriptReplay implements SessionStore {
  private readonly publisher: IPublisher;
  private readonly changes: ConversationChanges;
  private readonly ids: IIds;

  public constructor(publisher: IPublisher, changes: ConversationChanges, ids: IIds) {
    this.publisher = publisher;
    this.changes = changes;
    this.ids = ids;
  }

  public async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    for (const entry of entries) {
      if (kindOf(entry) === 'prompt') {
        // TODO(claude): undecided: where a replayed query begins and how it ends. Every entry the participant classifies as a prompt opens a query of its own, with the `from` of a say typed by a person, and no query's closure is published, because a record holds nothing that says how a query ended.
        await this.changes.openQuery(this.ids.mint(), HUMAN);
      }
      await this.publisher.publish(key, [entry]);
    }
  }

  public load(): Promise<null> {
    return Promise.resolve(null);
  }
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
