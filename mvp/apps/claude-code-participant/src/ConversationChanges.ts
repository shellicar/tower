import type { IBroker } from './Broker.js';
import { contentBlocksOf, isMainChain, isObject, isPrompt, type RecordEntry, responseIdOf, roleOf } from './ConversationEntries.js';
import { describeError } from './describeError.js';
import type { IHost } from './Host.js';
import type { IIds } from './Ids.js';
import type { Outbox } from './Outbox.js';
import type { ITimer } from './Timer.js';

export type QueryReason = 'completed' | 'cancelled' | 'aborted';

/** What a conversation's change stream is published with. */
export type ChangeSources = {
  /** Where files are stored. */
  broker: IBroker;
  /** Every change is queued here, to be published once the stream has acknowledged it. */
  outbox: Outbox;
  timer: ITimer;
  ids: IIds;
  host: IHost;
  instanceId: string;
  /** The durable object store bucket files are stored in. */
  durableBucket: string;
  /** Stops the running query, when one of its files can't be stored. */
  abort(): void;
};

type OpenQuery = {
  id: string;
  /** The `from` of the say that opened it, for its prompt; spent once the prompt is published. */
  from: unknown;
  /** A file of one of its messages couldn't be stored: nothing more of it is published. */
  aborted: boolean;
};

/** One API round; its id is minted with its first published message. */
type Turn = { id?: string };

/** A reference block's source: the durable object holding a file's bytes. */
type ObjectSource = { type: 'object'; id: string; bucket: string; mediaType: string; size: number };

/**
 * One conversation's `changes`: each entry Claude Code appends that is a
 * message goes out on `changes.message`, with the query and turn it belongs
 * to, and each query's end on `changes.query.closed`. Everything is
 * handed to the outbox in the order it is handed over.
 */
export class ConversationChanges {
  private readonly conversationId: string;
  private readonly sources: ChangeSources;
  private readonly subjectPrefix: string;
  private query: OpenQuery | undefined;
  private currentTurn: Turn = {};
  private latestResponseId: string | undefined;
  private pendingTurn: Turn | undefined;
  private queue: Promise<void> = Promise.resolve();

  public constructor(conversationId: string, sources: ChangeSources) {
    this.conversationId = conversationId;
    this.sources = sources;
    this.subjectPrefix = `conv.v2.${conversationId}.changes`;
  }

  /** A say was accepted as `queryId`: the query its prompt opens. */
  public openQuery(queryId: string, from: unknown): Promise<void> {
    return this.enqueue(() => {
      this.startQuery(queryId, from);
    });
  }

  /** Queues the messages among `entries` in the outbox. Never rejects: a failure is logged. */
  public commit(entries: readonly RecordEntry[]): Promise<void> {
    return this.enqueue(async () => {
      for (const entry of entries) {
        try {
          await this.take(entry);
        } catch (err) {
          this.sources.host.log(`conversation ${this.conversationId}: publishing entry ${entry.uuid ?? entry.type} failed: ${describeError(err)}`);
        }
      }
    });
  }

  /** Queues the open query's closure, after everything handed over before it; `aborted` if it was given up. */
  public close(reason: QueryReason): Promise<void> {
    return this.enqueue(() => {
      const { query } = this;
      if (query === undefined) {
        return;
      }
      this.query = undefined;
      // TODO(claude): undecided: the message id a query's closure is published with. As built, the query id and `.closed`.
      this.publish('query.closed', `${query.id}.closed`, { queryId: query.id, reason: query.aborted ? 'aborted' : reason });
    });
  }

  private enqueue(work: () => void | Promise<void>): Promise<void> {
    this.queue = this.queue.then(work).catch((err: unknown) => this.sources.host.log(`conversation ${this.conversationId}: publishing changes failed: ${describeError(err)}`));
    return this.queue;
  }

  private startQuery(id: string, from: unknown): OpenQuery {
    this.query = { id, from, aborted: false };
    this.currentTurn = {};
    this.latestResponseId = undefined;
    this.pendingTurn = undefined;
    return this.query;
  }

  private async take(entry: RecordEntry): Promise<void> {
    if (!isMainChain(entry)) {
      return;
    }
    const role = roleOf(entry);
    // No query is open (none was asked for, or the last one has closed): the message opens one of its own.
    if (role !== undefined && this.query === undefined) {
      this.startQuery(this.sources.ids.mint(), undefined);
    }
    const turn = this.place(entry);
    const { query } = this;
    if (role === undefined || query === undefined || query.aborted) {
      return;
    }
    turn.id ??= this.sources.ids.mint();
    const id = entry.uuid as string;
    let content: unknown[];
    try {
      content = await this.storeFiles(id, contentBlocksOf(entry));
    } catch (err) {
      query.aborted = true;
      this.sources.host.log(`conversation ${this.conversationId}: storing a file of message ${id} failed, so query ${query.id} is aborted: ${describeError(err)}`);
      this.sources.abort();
      return;
    }
    let from: unknown;
    if (isPrompt(entry) && query.from !== undefined) {
      from = query.from;
      query.from = undefined;
    }
    // TODO(claude): undecided: what id keys the publish dedupe. As built, the entry's `uuid`, which is also the message's `id`.
    this.publish('message', id, { id, queryId: query.id, turnId: turn.id, role, ...(from === undefined ? {} : { from }), content });
  }

  /**
   * The turn an entry belongs to. Every piece of one API response shares the
   * response's turn, whatever was written between its pieces. Input written
   * after a response has begun (tool results, reminders) waits in the next
   * turn, which the next response takes, and so does any other entry written
   * while that turn waits; a response with no new input before it stays in
   * the turn it follows.
   */
  private place(entry: RecordEntry): Turn {
    if (entry.type === 'assistant') {
      const response = responseIdOf(entry);
      if (response !== this.latestResponseId && this.pendingTurn !== undefined) {
        this.currentTurn = this.pendingTurn;
        this.pendingTurn = undefined;
      }
      this.latestResponseId = response;
      return this.currentTurn;
    }
    if ((entry.type === 'user' || entry.type === 'attachment') && this.latestResponseId !== undefined) {
      this.pendingTurn ??= {};
      return this.pendingTurn;
    }
    return this.pendingTurn ?? this.currentTurn;
  }

  /**
   * The content with each file's bytes stored in the durable store and its
   * block pointing there instead, files inside tool results included.
   */
  private async storeFiles(messageId: string, blocks: readonly unknown[]): Promise<unknown[]> {
    const stored: unknown[] = [];
    for (const block of blocks) {
      if (!isObject(block)) {
        stored.push(block);
      } else if (isObject(block.source) && block.source.type === 'base64' && typeof block.source.data === 'string') {
        stored.push({ ...block, source: await this.storeFile(messageId, block.source) });
      } else if (block.type === 'tool_result' && Array.isArray(block.content)) {
        stored.push({ ...block, content: await this.storeFiles(messageId, block.content) });
      } else {
        stored.push(block);
      }
    }
    return stored;
  }

  private async storeFile(messageId: string, source: Record<string, unknown>): Promise<ObjectSource> {
    const mediaType = source.media_type;
    if (typeof mediaType !== 'string') {
      throw new Error('the file has no media type');
    }
    const bytes = Buffer.from(source.data as string, 'base64');
    const { durableBucket: bucket } = this.sources;
    const id = `${this.conversationId}/${this.sources.ids.mint()}`;
    await this.sources.broker.storeObject(bucket, id, bytes, { messageId, mediaType });
    return { type: 'object', id, bucket, mediaType, size: bytes.length };
  }

  private publish(leaf: string, msgId: string, fields: Record<string, unknown>): void {
    // TODO(claude): undecided: what `ts` means for a message that is published late. As built, it is the time the message was queued.
    const body = { ts: this.sources.timer.timestamp(), instanceId: this.sources.instanceId, ...fields };
    this.sources.outbox.enqueue(`${this.subjectPrefix}.${leaf}`, msgId, JSON.stringify(body));
  }
}
