import { type ObjectStore, Objm } from '@nats-io/obj';
import { connect, type Msg, type NatsConnection } from '@nats-io/transport-node';
import { dependsOn } from '@shellicar/core-di';
import { ackedPublish } from './AckedPublish.js';
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

/** Tower's bus: the edge between the participant and NATS. */
export abstract class IBroker {
  public abstract connect(): Promise<void>;
  public abstract publish(subject: string, body: Record<string, unknown>): void;
  /**
   * Publishes `payload` to the stream that covers `subject`; resolves once the stream has stored it.
   * `msgId` makes a repeat of the same message a no-op within the stream's duplicate window.
   * Rejects with `PublishRejected` when the message itself is refused, and with any other error when it may succeed later.
   */
  public abstract publishAcked(subject: string, payload: string, msgId: string): Promise<void>;
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
  private readonly objectStores = new Map<string, Promise<ObjectStore>>();
  private ended = false;

  public async connect(): Promise<void> {
    // TODO(claude): undecided: the connection options. As built, reconnecting never gives up; every other option is the client's default.
    const connection = await connect({ servers: this.config.natsUrl, maxReconnectAttempts: -1 });
    const shutDownWhileConnecting = this.ended;
    if (shutDownWhileConnecting) {
      await connection.close();
      return;
    }
    this.connection = connection;
  }

  public publish(subject: string, body: Record<string, unknown>): void {
    this.connected().publish(subject, JSON.stringify(body));
  }

  public publishAcked(subject: string, payload: string, msgId: string): Promise<void> {
    return ackedPublish(this.connected(), subject, payload, msgId);
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
