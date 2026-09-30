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

/** Tower's bus: the edge between the participant and NATS. */
export abstract class IBroker {
  public abstract connect(): Promise<void>;
  public abstract publish(subject: string, body: Record<string, unknown>): void;
  /** Hands each request on `subject` to `handle`; with `queue`, as one member of that queue group. */
  public abstract subscribe(subject: string, handle: (request: BrokerRequest) => void, options?: { queue?: string }): BrokerSubscription;
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
  private ended = false;

  public async connect(): Promise<void> {
    const connection = await connect({ servers: this.config.natsUrl });
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

  public async drain(): Promise<void> {
    this.ended = true;
    await this.connection?.drain();
  }

  public async close(): Promise<void> {
    this.ended = true;
    await this.connection?.close();
  }

  private connected(): NatsConnection {
    if (this.connection === undefined) {
      throw new Error('not connected to NATS');
    }
    return this.connection;
  }
}
