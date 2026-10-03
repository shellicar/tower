import { contentBlocksOf, isMainChain, isObject, isPrompt, type RecordEntry, responseIdOf, roleOf } from './ConversationEntries.js';
import { describeError } from './describeError.js';
import type { IHost } from './Host.js';
import type { IIds } from './Ids.js';
import { type OutboxLane, OutboxWriteError, type OutgoingFile } from './Outbox.js';
import type { ITimer } from './Timer.js';

export type QueryReason = 'completed' | 'cancelled' | 'aborted';

/** What a conversation's change stream is published with. */
export type ChangeSources = {
  /** Where everything published goes: kept on disk until the stream has it. */
  lane: OutboxLane;
  timer: ITimer;
  ids: IIds;
  host: IHost;
  instanceId: string;
  /** The durable object store bucket files are stored in. */
  durableBucket: string;
  /** Stops the running query, when one of its files can't be turned into a reference. */
  abort(): void;
};

type OpenQuery = {
  id: string;
  /** The `from` of the say that opened it, for its prompt; spent once the prompt is published. */
  from: unknown;
  /** A file of one of its messages couldn't be turned into a reference: nothing more of it is published. */
  aborted: boolean;
};

/** One API round; its id is minted with its first published message. */
type Turn = { id?: string };

/** A reference block's source: the durable object holding a file's bytes. */
type ObjectSource = { type: 'object'; id: string; bucket: string; mediaType: string; size: number };

/**
 * One conversation's `changes`: each entry Claude Code appends that is a
 * message goes out on `changes.message`, with the query and turn it belongs
 * to, and each query's end on `changes.query.closed`. Everything, attachment
 * events included, is handed to the conversation's outbox in the order it is
 * handed over here, and reaches the stream in that order.
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
    }).catch(() => undefined);
  }

  /**
   * Hands the messages among `entries` to the outbox, and resolves once they
   * are safe on disk. Rejects when one couldn't be written, so that Claude
   * Code's record hands the entries over again; an entry that can't be
   * turned into a message is logged and skipped.
   */
  public commit(entries: readonly RecordEntry[]): Promise<void> {
    return this.enqueue(async () => {
      for (const entry of entries) {
        try {
          await this.take(entry);
        } catch (err) {
          if (err instanceof OutboxWriteError) {
            throw err;
          }
          this.sources.host.log(`conversation ${this.conversationId}: publishing entry ${entry.uuid ?? entry.type} failed: ${describeError(err)}`);
        }
      }
    });
  }

  /** Publishes the open query's closure, after everything handed over before it; `aborted` if it was given up. */
  public close(reason: QueryReason): Promise<void> {
    return this.enqueue(async () => {
      const { query } = this;
      if (query === undefined) {
        return;
      }
      this.query = undefined;
      await this.publish('query.closed', { queryId: query.id, reason: query.aborted ? 'aborted' : reason });
    }).catch(() => undefined);
  }

  /** Publishes an attachment event (`attached`, `detached`), after everything handed over before it. */
  public announce(leaf: 'attached' | 'detached', fields: Record<string, unknown>): Promise<void> {
    const body = { ts: this.sources.timer.timestamp(), instanceId: this.sources.instanceId, ...fields };
    return this.enqueue(() => this.sources.lane.enqueue({ subject: `conv.v2.${this.conversationId}.attachment.${leaf}`, body, id: this.sources.ids.mint() })).catch(() => undefined);
  }

  /** Runs `work` after everything queued before it. A failure is logged and rejects the returned promise, and never stops the work queued after it. */
  private enqueue(work: () => void | Promise<void>): Promise<void> {
    const result = this.queue.then(work);
    this.queue = result.catch((err: unknown) => this.sources.host.log(`conversation ${this.conversationId}: publishing changes failed: ${describeError(err)}`));
    return result;
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
    const files: OutgoingFile[] = [];
    let content: unknown[];
    try {
      content = this.referenceFiles(id, contentBlocksOf(entry), files);
    } catch (err) {
      query.aborted = true;
      this.sources.host.log(`conversation ${this.conversationId}: a file of message ${id} can't be referenced, so query ${query.id} is aborted: ${describeError(err)}`);
      this.sources.abort();
      return;
    }
    let from: unknown;
    if (isPrompt(entry) && query.from !== undefined) {
      from = query.from;
      query.from = undefined;
    }
    await this.publish('message', { id, queryId: query.id, turnId: turn.id, role, ...(from === undefined ? {} : { from }), content }, { id, files });
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
   * The content with each file's block pointing at the object its bytes will
   * be stored as, files inside tool results included. The files are added to
   * `files`, to be stored before the message is published. An object is named
   * by its message and its place in it, so storing it again replaces it.
   */
  private referenceFiles(messageId: string, blocks: readonly unknown[], files: OutgoingFile[]): unknown[] {
    const referenced: unknown[] = [];
    for (const block of blocks) {
      if (!isObject(block)) {
        referenced.push(block);
      } else if (isObject(block.source) && block.source.type === 'base64' && typeof block.source.data === 'string') {
        referenced.push({ ...block, source: this.referenceFile(messageId, block.source, files) });
      } else if (block.type === 'tool_result' && Array.isArray(block.content)) {
        referenced.push({ ...block, content: this.referenceFiles(messageId, block.content, files) });
      } else {
        referenced.push(block);
      }
    }
    return referenced;
  }

  private referenceFile(messageId: string, source: Record<string, unknown>, files: OutgoingFile[]): ObjectSource {
    const mediaType = source.media_type;
    if (typeof mediaType !== 'string') {
      throw new Error('the file has no media type');
    }
    const bytes = Buffer.from(source.data as string, 'base64');
    const { durableBucket: bucket } = this.sources;
    const id = `${this.conversationId}/${messageId}.${files.length}`;
    files.push({ objectId: id, bucket, metadata: { messageId, mediaType }, bytes });
    return { type: 'object', id, bucket, mediaType, size: bytes.length };
  }

  private publish(leaf: string, fields: Record<string, unknown>, delivery: { id?: string; files?: readonly OutgoingFile[] } = {}): Promise<void> {
    const body = { ts: this.sources.timer.timestamp(), instanceId: this.sources.instanceId, ...fields };
    return this.sources.lane.enqueue({ subject: `${this.subjectPrefix}.${leaf}`, body, id: delivery.id ?? this.sources.ids.mint(), files: delivery.files ?? [] });
  }
}
