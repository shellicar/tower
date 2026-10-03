import { JetStreamApiError, jetstream } from '@nats-io/jetstream';
import type { NatsConnection } from '@nats-io/transport-node';

/** The broker refused a message and will refuse it again however often it is sent. */
export class PublishRejected extends Error {}

// TODO(claude): undecided: what happens to a message the stream rejects. As built, a payload over the
// connection's limit and a 4xx from the stream are rejections; "no responders" (a subject no stream
// covers) is treated as a failure that may clear.
function isRejection(err: unknown): boolean {
  // The payload is over what the connection can carry: thrown before anything is sent.
  if (err instanceof Error && err.name === 'InvalidArgumentError') {
    return true;
  }
  // The stream answered with a 4xx, such as a size limit.
  if (err instanceof JetStreamApiError) {
    const { code } = err.apiError();
    return code >= 400 && code < 500;
  }
  return false;
}

/**
 * Publishes to a stream and resolves once the stream has stored the message.
 * `msgId` is the message's idempotency key: the stream drops a second message
 * with the same id inside its duplicate window.
 *
 * @throws PublishRejected when the message itself is refused; any other failure may clear by itself.
 */
export async function ackedPublish(connection: NatsConnection, subject: string, payload: string, msgId: string): Promise<void> {
  try {
    await jetstream(connection).publish(subject, payload, { msgID: msgId });
  } catch (err) {
    if (isRejection(err)) {
      throw new PublishRejected('the stream refused the message', { cause: err });
    }
    throw err;
  }
}
