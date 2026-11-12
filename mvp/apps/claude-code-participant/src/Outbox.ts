import { dependsOn } from '@shellicar/core-di';
import { IBroker, MessageTooLarge } from './Broker.js';
import { describeError } from './describeError.js';
import { IHost } from './Host.js';
import { IOutboxStore, type OutboxFile, type OutboxRecord } from './OutboxStore.js';
import { ITimer } from './Timer.js';

/** The first wait after a failed attempt; each further failure doubles it. */
const RETRY_FIRST_MS = 250;
/** The longest wait between attempts. */
const RETRY_LONGEST_MS = 5_000;

/** A message could not be written to disk, so it is not safe: the caller must not treat it as handed over. */
export class OutboxWriteError extends Error {
  public override name = 'OutboxWriteError';
}

/** A file to put in the object store before the message is published. */
export type OutgoingFile = OutboxFile & { bytes: Uint8Array };

/** A message to publish to the stream. */
export type Outgoing = {
  subject: string;
  body: Record<string, unknown>;
  /** What the stream recognises a repeat of this message by. */
  id: string;
  files?: readonly OutgoingFile[];
};

type Waiting = { seq: number; record: OutboxRecord; filesStored: boolean };

/**
 * One conversation's messages on their way to the stream. A message is
 * written to disk before `enqueue` resolves and removed only once the stream
 * has acknowledged it; until then it is published again and again, one at a
 * time and in the order it was enqueued, so a message the stream won't take
 * holds back those behind it.
 */
export class OutboxLane {
  private readonly conversationId: string;
  private readonly dependencies: OutboxDependencies;
  private readonly loaded: Promise<void>;
  private readonly waiting: Waiting[] = [];
  private nextSeq = 1;
  /** Writes happen one at a time, so disk order is call order. */
  private writes: Promise<void> = Promise.resolve();
  private delivering: Promise<void> | undefined;
  private closing = false;
  /** Aborted by `close`, which ends the wait between attempts. */
  private readonly closed = new AbortController();
  private lastFailure: string | undefined;

  public constructor(conversationId: string, dependencies: OutboxDependencies) {
    this.conversationId = conversationId;
    this.dependencies = dependencies;
    this.loaded = this.load();
    // Reported by whichever `enqueue` awaits it; this keeps a lane nobody has
    // written to yet from raising an unhandled rejection.
    this.loaded.catch((err: unknown) => dependencies.host.log(`conversation ${conversationId}: reading the outbox failed: ${describeError(err)}`));
  }

  /**
   * Writes the message to disk, then starts delivering it. Resolves once it
   * is written, not once it is published; rejects with `OutboxWriteError`
   * when it could not be written. Messages are ordered by when `enqueue` is
   * called.
   */
  public enqueue(outgoing: Outgoing): Promise<void> {
    const files = outgoing.files ?? [];
    const record: OutboxRecord = {
      id: outgoing.id,
      subject: outgoing.subject,
      body: outgoing.body,
      files: files.map(({ objectId, bucket, metadata }) => ({ objectId, bucket, metadata })),
    };
    const written = this.writes.then(async () => {
      let seq: number;
      try {
        await this.loaded;
        seq = this.nextSeq;
        await this.dependencies.store.write(
          this.conversationId,
          seq,
          record,
          files.map((file) => file.bytes),
        );
      } catch (err) {
        throw new OutboxWriteError(`writing message ${outgoing.id} to the outbox failed`, { cause: err });
      }
      this.nextSeq = seq + 1;
      this.waiting.push({ seq, record, filesStored: false });
      this.deliver();
    });
    this.writes = written.catch(() => undefined);
    return written;
  }

  /**
   * Stops waiting for the network: delivers what the stream will take now, in
   * order, and ends at the first message it won't. What is left stays on disk.
   */
  public async close(): Promise<void> {
    this.closing = true;
    this.closed.abort();
    await this.writes;
    if (!(await this.hasLoaded())) {
      return;
    }
    this.deliver();
    await this.delivering;
  }

  /** Whether what an earlier run left on disk could be read; a lane that couldn't read it delivers nothing. */
  private async hasLoaded(): Promise<boolean> {
    try {
      await this.loaded;
      return true;
    } catch {
      return false;
    }
  }

  private async load(): Promise<void> {
    const stored = await this.dependencies.store.load(this.conversationId);
    for (const { seq, record } of stored) {
      this.waiting.push({ seq, record, filesStored: false });
      this.nextSeq = Math.max(this.nextSeq, seq + 1);
    }
    this.deliver();
  }

  private deliver(): void {
    if (this.delivering === undefined && this.waiting.length > 0) {
      const run = this.run().finally(() => {
        if (this.delivering === run) {
          this.delivering = undefined;
        }
      });
      this.delivering = run;
    }
  }

  private async run(): Promise<void> {
    let wait = RETRY_FIRST_MS;
    while (this.waiting.length > 0) {
      const head = this.waiting[0] as Waiting;
      try {
        await this.attempt(head);
        this.lastFailure = undefined;
        wait = RETRY_FIRST_MS;
      } catch (err) {
        this.logFailure(head, err);
        if (this.closing) {
          return;
        }
        await this.dependencies.timer.sleep(wait, this.closed.signal);
        wait = Math.min(wait * 2, RETRY_LONGEST_MS);
      }
    }
  }

  /** Publishes the head message and removes it; a message the broker could never take is dropped. */
  private async attempt(head: Waiting): Promise<void> {
    const { store, broker, host } = this.dependencies;
    const { record, seq } = head;
    if (!head.filesStored) {
      for (const [index, file] of record.files.entries()) {
        await broker.storeObject(file.bucket, file.objectId, await store.readBlob(this.conversationId, seq, index), file.metadata);
      }
      head.filesStored = true;
    }
    try {
      await broker.publishToStream(record.subject, record.body, record.id);
    } catch (err) {
      if (!(err instanceof MessageTooLarge)) {
        throw err;
      }
      host.log(`conversation ${this.conversationId}: message ${record.id} on ${record.subject} is dropped, and the messages after it go on: ${describeError(err)}`);
    }
    await store.remove(this.conversationId, seq, record.files.length);
    this.waiting.shift();
  }

  /** Logs a failure once, then again only when it changes, so a long outage is one line. */
  private logFailure(head: Waiting, err: unknown): void {
    const failure = describeError(err);
    if (failure !== this.lastFailure) {
      this.lastFailure = failure;
      this.dependencies.host.log(`conversation ${this.conversationId}: delivering message ${head.record.id} on ${head.record.subject} failed, so it is kept and tried again: ${failure}`);
    }
  }
}

type OutboxDependencies = { store: IOutboxStore; broker: IBroker; timer: ITimer; host: IHost };

/**
 * Everything the participant publishes about a conversation that a reader
 * needs to see: messages, query closure, attached and detached. Each
 * conversation has one lane, which keeps what it publishes on disk until the
 * stream has it.
 */
export class Outbox {
  @dependsOn(IOutboxStore) private readonly store!: IOutboxStore;
  @dependsOn(IBroker) private readonly broker!: IBroker;
  @dependsOn(ITimer) private readonly timer!: ITimer;
  @dependsOn(IHost) private readonly host!: IHost;
  private readonly lanes = new Map<string, OutboxLane>();

  /** The conversation's lane; the same one every time. */
  public lane(conversationId: string): OutboxLane {
    let lane = this.lanes.get(conversationId);
    if (lane === undefined) {
      lane = new OutboxLane(conversationId, { store: this.store, broker: this.broker, timer: this.timer, host: this.host });
      this.lanes.set(conversationId, lane);
    }
    return lane;
  }

  /** Starts delivering what an earlier run left on disk. */
  public async resume(): Promise<void> {
    for (const conversationId of await this.store.conversations()) {
      this.lane(conversationId);
    }
  }

  /** Delivers what the broker will take now, and stops waiting on what it won't. */
  public async flush(): Promise<void> {
    await Promise.all([...this.lanes.values()].map((lane) => lane.close()));
  }
}
