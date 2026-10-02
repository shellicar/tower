import { jetstream } from '@nats-io/jetstream';
import { connect } from '@nats-io/transport-node';
import { dependsOn } from '@shellicar/core-di';
import { ParticipantConfig } from './ParticipantConfig.js';

/** One message of a conversation's `changes`, as it was published. */
export type PublishedChange = {
  /** The subject's leaf after `changes.`: `message`, `entry`, `query.closed`. */
  leaf: string;
  body: Record<string, unknown>;
};

/** What the bus holds of a conversation: the edge a resume reads published messages from. */
export abstract class IPublishedHistory {
  /** Every `changes` message published for `conversationId`, oldest first. */
  public abstract read(conversationId: string): Promise<PublishedChange[]>;
}

// The stream the conv.v2 changes subjects land in (stream-init.sh, AUDIT_STREAM).
// TODO(claude): undecided: the stream name is a constant here; where it comes
// from (config, discovery by subject) is not decided.
const CHANGES_STREAM = 'conv-approval';

/** Reads the history from JetStream with an ordered consumer, on its own connection. */
export class NatsPublishedHistory implements IPublishedHistory {
  @dependsOn(ParticipantConfig) private readonly config!: ParticipantConfig;

  public async read(conversationId: string): Promise<PublishedChange[]> {
    const prefix = `conv.v2.${conversationId}.changes.`;
    const connection = await connect({ servers: this.config.natsUrl });
    try {
      const consumer = await jetstream(connection).consumers.get(CHANGES_STREAM, { filter_subjects: [`${prefix}>`] });
      const changes: PublishedChange[] = [];
      for (;;) {
        const message = await consumer.next({ expires: 3000 });
        if (message === null) {
          break;
        }
        changes.push({ leaf: message.subject.slice(prefix.length), body: message.json<Record<string, unknown>>() });
        if (message.info.pending === 0) {
          break;
        }
      }
      return changes;
    } finally {
      await connection.close();
    }
  }
}
