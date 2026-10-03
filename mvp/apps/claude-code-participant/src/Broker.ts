import { type JetStreamClient, jetstream } from '@nats-io/jetstream';
import { type ObjectStore, Objm } from '@nats-io/obj';
import { connect, type Msg, type NatsConnection } from '@nats-io/transport-node';
import { dependsOn } from '@shellicar/core-di';
import { describeError } from './describeError.js';
import { IHost } from './Host.js';
import { ParticipantConfig } from './ParticipantConfig.js';

export type Reply = { accepted: true; id?: string } | { rejected: true; reason: string; detail?: string };

/** A request as it arrives: the subject it came on, its body, and the one way to answer it. */
export type BrokerRequest = {
  subject: string;
  /** The body parsed as JSON; undefined when it isn't JSON. */
  body: unknown;
  reply(reply: Reply): void;
};

export type BrokerSubscription = { unsubscribe(): void };

/** The message is larger than the broker accepts, so no stream can ever take it. */
export class MessageTooLarge extends Error {
  public override name = 'MessageTooLarge';
  public readonly size: number;
  public readonly limit: number;

  public constructor(size: number, limit: number) {
    super(`message of ${size} bytes is over the broker's limit of ${limit} bytes`);
    this.size = size;
    this.limit = limit;
  }
}

/** A stream acknowledges a publish within this long, or the publish has failed. */
const STREAM_PUBLISH_TIMEOUT_MS = 10_000;

/** Tower's bus: the edge between the participant and NATS. */
export abstract class IBroker {
  public abstract connect(): Promise<void>;
  /** Publishes without waiting for the broker: a message sent while the connection is down may be lost. */
  public abstract publish(subject: string, body: Record<string, unknown>): void;
  /**
   * Publishes to the stream that stores `subject` and resolves once the stream
   * has acknowledged it, rejecting when it hasn't (no connection, no answer, no
   * stream for the subject, or the stream refusing the message). The stream
   * drops a publish of an `id` it has already stored within its duplicate
   * window, so the same call can be repeated safely. Rejects with
   * `MessageTooLarge` when the broker would never accept the message.
   */
  public abstract publishToStream(subject: string, body: Record<string, unknown>, id: string): Promise<void>;
  /** Hands each request on `subject` to `handle`; with `queue`, as one member of that queue group. */
  public abstract subscribe(subject: string, handle: (request: BrokerRequest) => void, options?: { queue?: string }): BrokerSubscription;
  /** Stores `data` as the object `name` in the object store `bucket`; resolves once the store has it. */
  public abstract storeObject(bucket: string, name: string, data: Uint8Array, metadata: Record<string, string>): Promise<void>;
  /** Sends what is published, lets every subscription finish what it received, then closes. */
  public abstract drain(): Promise<void>;
  /** Sends what is published and closes, without waiting on subscriptions. */
  public abstract close(): Promise<void>;
}

function parse(msg: Msg): unknown {
  try {
    return msg.json<unknown>();
  } catch {
    return undefined;
  }
}

export class NatsBroker implements IBroker {
  @dependsOn(ParticipantConfig) private readonly config!: ParticipantConfig;
  @dependsOn(IHost) private readonly host!: IHost;
  private connection: NatsConnection | undefined;
  private stream: JetStreamClient | undefined;
  private readonly objectStores = new Map<string, Promise<ObjectStore>>();
  private ended = false;

  public async connect(): Promise<void> {
    // Reconnects for as long as it takes: the client's default gives up after
    // ten attempts, and every call after that throws.
    const connection = await connect({ servers: this.config.natsUrl, maxReconnectAttempts: -1 });
    const shutDownWhileConnecting = this.ended;
    if (shutDownWhileConnecting) {
      await connection.close();
      return;
    }
    this.connection = connection;
    this.stream = jetstream(connection);
  }

  public publish(subject: string, body: Record<string, unknown>): void {
    this.connected().publish(subject, JSON.stringify(body));
  }

  public async publishToStream(subject: string, body: Record<string, unknown>, id: string): Promise<void> {
    const connection = this.connected();
    const { stream } = this;
    if (stream === undefined) {
      throw new Error('not connected to NATS');
    }
    const payload = JSON.stringify(body);
    // The limit counts the headers too: the version line, the id header and the closing blank line.
    const size = Buffer.byteLength(payload) + Buffer.byteLength(`NATS/1.0\r\nNats-Msg-Id: ${id}\r\n\r\n`);
    const limit = connection.info?.max_payload;
    if (limit !== undefined && size > limit) {
      throw new MessageTooLarge(size, limit);
    }
    await stream.publish(subject, payload, { msgID: id, timeout: STREAM_PUBLISH_TIMEOUT_MS });
  }

  public subscribe(subject: string, handle: (request: BrokerRequest) => void, options: { queue?: string } = {}): BrokerSubscription {
    const subscription = this.connected().subscribe(subject, {
      ...(options.queue === undefined ? {} : { queue: options.queue }),
      callback: (err, msg) => {
        if (err !== null) {
          this.host.log(`subscription to ${subject} failed: ${describeError(err)}`);
          return;
        }
        handle({ subject: msg.subject, body: parse(msg), reply: (reply) => msg.respond(JSON.stringify(reply)) });
      },
    });
    return { unsubscribe: () => subscription.unsubscribe() };
  }

  public async storeObject(bucket: string, name: string, data: Uint8Array, metadata: Record<string, string>): Promise<void> {
    const store = await this.objectStore(bucket);
    await store.putBlob({ name, metadata }, data);
  }

  public async drain(): Promise<void> {
    this.ended = true;
    await this.connection?.drain();
  }

  public async close(): Promise<void> {
    this.ended = true;
    await this.connection?.close();
  }

  /** The bucket, opened once; an open that fails is tried again next time. */
  private objectStore(bucket: string): Promise<ObjectStore> {
    const opened = this.objectStores.get(bucket);
    if (opened !== undefined) {
      return opened;
    }
    const opening = new Objm(this.connected()).open(bucket);
    this.objectStores.set(bucket, opening);
    opening.catch(() => {
      if (this.objectStores.get(bucket) === opening) {
        this.objectStores.delete(bucket);
      }
    });
    return opening;
  }

  private connected(): NatsConnection {
    if (this.connection === undefined) {
      throw new Error('not connected to NATS');
    }
    return this.connection;
  }
}
