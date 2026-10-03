import { DatabaseSync } from 'node:sqlite';
import { PublishRejected } from './AckedPublish.js';
import type { IBroker } from './Broker.js';
import { describeError } from './describeError.js';
import type { IHost } from './Host.js';
import type { ITimer } from './Timer.js';

/** In the config dir, its own database file: the lock file must not be opened by anything else. */
export const OUTBOX_FILE = 'tower-participant-outbox.db';

/** The largest message NATS carries by default. */
export const MAX_PAYLOAD_BYTES = 1_048_576;

const RETRY_FIRST_MS = 250;
const RETRY_MAX_MS = 2000;

type Row = { seq: number; subject: string; msg_id: string; payload: string };

export type OutboxSources = {
  broker: IBroker;
  host: IHost;
  timer: ITimer;
};

/**
 * Every message the participant publishes to a conversation, kept on disk
 * until the stream has acknowledged it.
 *
 * `enqueue` writes the message to the database and returns. One pump takes
 * the oldest row, publishes it with its message id as the idempotency key,
 * and deletes the row once the stream has acknowledged it; so rows go out one
 * at a time in the order they were enqueued, across restarts too. A failure
 * that may clear (no connection, a timeout) is retried with a growing pause.
 * A row the stream refuses is marked and skipped.
 */
export class Outbox {
  private readonly sources: OutboxSources;
  private readonly db: DatabaseSync;
  private readonly insert: ReturnType<DatabaseSync['prepare']>;
  private readonly oldest: ReturnType<DatabaseSync['prepare']>;
  private readonly remove: ReturnType<DatabaseSync['prepare']>;
  private readonly refuse: ReturnType<DatabaseSync['prepare']>;
  private pump: Promise<void> | undefined;
  private stopping = false;
  /** Set while the pump waits for a row; called to wake it. */
  private wake: (() => void) | undefined;
  private readonly stopped: Promise<void>;
  private signalStop: () => void = () => {};

  public constructor(path: string, sources: OutboxSources) {
    this.sources = sources;
    this.stopped = new Promise((resolve) => {
      this.signalStop = resolve;
    });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = FULL');
    // TODO(claude): undecided: where the outbox lives and how its rows are keyed. As built, one table in one file in the config dir, rows ordered by an increasing number across every conversation.
    this.db.exec('CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT NOT NULL, msg_id TEXT NOT NULL, payload TEXT NOT NULL, refused TEXT)');
    this.insert = this.db.prepare('INSERT INTO outbox (subject, msg_id, payload) VALUES (?, ?, ?)');
    this.oldest = this.db.prepare('SELECT seq, subject, msg_id, payload FROM outbox WHERE refused IS NULL ORDER BY seq LIMIT 1');
    this.remove = this.db.prepare('DELETE FROM outbox WHERE seq = ?');
    this.refuse = this.db.prepare('UPDATE outbox SET refused = ? WHERE seq = ?');
  }

  /**
   * Writes the message to the outbox; it is published later, after every row
   * before it. A payload over NATS's size limit is logged and dropped.
   */
  public enqueue(subject: string, msgId: string, payload: string): void {
    if (!this.db.isOpen) {
      this.sources.host.log(`outbox: message ${msgId} for ${subject} arrived after the outbox closed, so it is not queued`);
      return;
    }
    const bytes = Buffer.byteLength(payload);
    if (bytes > MAX_PAYLOAD_BYTES) {
      this.sources.host.log(`outbox: message ${msgId} for ${subject} is ${bytes} bytes, over the ${MAX_PAYLOAD_BYTES} NATS carries, so it is dropped`);
      return;
    }
    this.insert.run(subject, msgId, payload);
    this.wake?.();
  }

  /** Starts publishing: the rows already on disk first, then each new one. */
  public start(): void {
    if (this.pump !== undefined) {
      return;
    }
    this.pump = this.run().catch((err: unknown) => this.sources.host.log(`outbox: publishing stopped: ${describeError(err)}`));
  }

  /**
   * Publishes what can be published, then stops and closes the database.
   * Rows still unsent stay on disk for the next start.
   */
  public async stop(): Promise<void> {
    this.stopping = true;
    this.signalStop();
    this.wake?.();
    await this.pump;
    if (this.db.isOpen) {
      this.db.close();
    }
  }

  private async run(): Promise<void> {
    let failures = 0;
    let reported: string | undefined;
    for (;;) {
      const row = this.oldest.get() as Row | undefined;
      if (row === undefined) {
        if (this.stopping) {
          return;
        }
        await Promise.race([new Promise<void>((resolve) => (this.wake = resolve)), this.stopped]);
        this.wake = undefined;
        continue;
      }
      try {
        // TODO(claude): undecided: the dedupe window, and what happens to a row re-sent after it. As built, the stream's own window decides; a row sent again after it is stored a second time.
        await this.sources.broker.publishAcked(row.subject, row.payload, row.msg_id);
      } catch (err) {
        const reason = describeError(err);
        if (err instanceof PublishRejected) {
          // TODO(claude): undecided: what happens to a message the stream rejects. As built, it stays in the outbox marked with the reason, is logged once, and the rows behind it go on.
          this.refuse.run(reason, row.seq);
          this.sources.host.log(`outbox: the stream refused message ${row.msg_id} for ${row.subject}, kept in the outbox: ${reason}`);
          continue;
        }
        if (this.stopping) {
          return;
        }
        if (reason !== reported) {
          reported = reason;
          this.sources.host.log(`outbox: publishing message ${row.msg_id} failed, retrying: ${reason}`);
        }
        await Promise.race([this.sources.timer.sleep(Math.min(RETRY_FIRST_MS * 2 ** failures, RETRY_MAX_MS)), this.stopped]);
        failures += 1;
        continue;
      }
      this.remove.run(row.seq);
      failures = 0;
      reported = undefined;
    }
  }
}
