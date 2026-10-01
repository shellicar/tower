import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { BrokerRequest, BrokerSubscription, IBroker, Reply } from './Broker.js';
import { readRecord } from './ClaudeCodeRecord.js';
import type { Conversation } from './Conversation.js';
import { ConversationChanges, type QueryReason } from './ConversationChanges.js';
import { describeError } from './describeError.js';
import type { IHost } from './Host.js';
import type { IIds } from './Ids.js';
import type { IPublisher } from './SessionStore.js';
import type { ITimer } from './Timer.js';

const sayRequest = z.looseObject({
  text: z.string(),
  precondition: z.looseObject({ tip: z.string().nullable() }),
  attachments: z.array(z.unknown()).optional(),
});

const cancelRequest = z.looseObject({ id: z.string() });

export function rejected(reason: string, detail?: string): Reply {
  return detail === undefined ? { rejected: true, reason } : { rejected: true, reason, detail };
}

/** What a served conversation shares with the instance serving it. */
export type ServingInstance = {
  broker: IBroker;
  timer: ITimer;
  ids: IIds;
  host: IHost;
  publisher: IPublisher;
  configDir: string;
  durableBucket: string;
  world: string;
  instanceId: string;
  /** Whether the instance has published `unavailable`. */
  isUnavailable(): boolean;
};

/** How a query Claude Code sent `result` for ended. */
function reasonOf(result: Extract<SDKMessage, { type: 'result' }>): QueryReason {
  return result.subtype === 'success' && result.is_error !== true ? 'completed' : 'aborted';
}

/**
 * A conversation this instance holds on the bus, from `attached` to
 * `detached`: it answers the conversation's requests, publishes its
 * changes, and knows which query is running in it and which have ended.
 */
export class ServedConversation {
  private readonly conversation: Conversation;
  private readonly instance: ServingInstance;
  private readonly requestPrefix: string;
  private readonly subscription: BrokerSubscription;
  private readonly changes: ConversationChanges;
  private readonly unroute: () => void;
  /** The query running now, started by an accepted `say`. */
  private live: string | undefined;
  /** Whether a cancel was accepted for the live query. */
  private liveCancelled = false;
  private readonly ended = new Set<string>();
  /** Says are decided one at a time, in the order they arrive. */
  private says: Promise<void> = Promise.resolve();
  private isDetached = false;

  public constructor(conversation: Conversation, instance: ServingInstance) {
    this.conversation = conversation;
    this.instance = instance;
    this.requestPrefix = `conv.v2.${conversation.id}.requests.`;
    this.changes = new ConversationChanges(conversation.id, {
      broker: instance.broker,
      timer: instance.timer,
      ids: instance.ids,
      host: instance.host,
      instanceId: instance.instanceId,
      durableBucket: instance.durableBucket,
      abort: () => this.interrupt('aborting the query'),
    });
    this.unroute = instance.publisher.route(conversation.id, this.changes);
    this.subscription = instance.broker.subscribe(`${this.requestPrefix}>`, (request) => this.handle(request));
    void this.follow();
  }

  public get id(): string {
    return this.conversation.id;
  }

  /** Stops answering the conversation's requests and publishing its changes, and publishes `detached`, once. */
  public detach(): void {
    if (this.isDetached) {
      return;
    }
    this.isDetached = true;
    this.subscription.unsubscribe();
    this.unroute();
    this.instance.broker.publish(`conv.v2.${this.id}.attachment.detached`, { ts: this.instance.timer.timestamp(), instanceId: this.instance.instanceId, world: this.instance.world });
  }

  private handle(request: BrokerRequest): void {
    const leaf = request.subject.slice(this.requestPrefix.length);
    if (leaf === 'say') {
      this.says = this.says.then(() => this.say(request));
      return;
    }
    if (leaf === 'cancel') {
      request.reply(this.cancel(request.body));
      return;
    }
    // chdir, and any leaf not known here.
    request.reply(rejected('unsupported'));
  }

  private async say(request: BrokerRequest): Promise<void> {
    try {
      request.reply(await this.decideSay(request.body));
    } catch (err) {
      this.instance.host.log(`conversation ${this.id}: say failed: ${describeError(err)}`);
      request.reply(rejected('failed', describeError(err)));
    }
  }

  private async decideSay(body: unknown): Promise<Reply> {
    if (this.instance.isUnavailable()) {
      return rejected('unavailable');
    }
    const say = sayRequest.safeParse(body);
    if (!say.success) {
      return rejected('invalid', say.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
    }
    // TODO: pass a say's attachments through to Claude Code, fetched from the
    // transit store. Until then they're rejected unsupported.
    if (say.data.attachments !== undefined && say.data.attachments.length > 0) {
      return rejected('unsupported', 'attachments are not supported');
    }
    if (this.live !== undefined) {
      return rejected('stale');
    }
    const tip = (await readRecord(this.instance.configDir, this.id))?.tip ?? null;
    if (this.instance.isUnavailable()) {
      return rejected('unavailable');
    }
    if (say.data.precondition.tip !== tip) {
      return rejected('stale');
    }
    const queryId = this.instance.ids.mint();
    this.live = queryId;
    this.liveCancelled = false;
    void this.changes.openQuery(queryId, say.data.from);
    this.conversation.send(say.data.text);
    return { accepted: true, id: queryId };
  }

  private cancel(body: unknown): Reply {
    const cancel = cancelRequest.safeParse(body);
    if (!cancel.success) {
      return rejected('invalid', 'id is required');
    }
    const { id } = cancel.data;
    if (id === this.live) {
      this.liveCancelled = true;
      this.interrupt(`interrupting query ${id}`);
      return { accepted: true };
    }
    return this.ended.has(id) ? rejected('already_complete') : rejected('not_found');
  }

  private interrupt(what: string): void {
    this.conversation.interrupt().catch((err: unknown) => this.instance.host.log(`conversation ${this.id}: ${what} failed: ${describeError(err)}`));
  }

  /**
   * Reads what Claude Code sends back: its `result` ends the running query,
   * whether it finished, was interrupted or failed.
   */
  private async follow(): Promise<void> {
    try {
      for await (const message of this.conversation.messages) {
        if (message.type === 'result') {
          this.endQuery(reasonOf(message));
        }
      }
    } catch (err) {
      this.instance.host.log(`conversation ${this.id}: reading Claude Code's messages failed: ${describeError(err)}`);
    }
    this.endQuery('aborted');
  }

  /** Ends the query running now, and publishes its closure: `cancelled` when a cancel for it was accepted. */
  private endQuery(reason: QueryReason): void {
    const cancelled = this.live !== undefined && this.liveCancelled;
    if (this.live !== undefined) {
      this.ended.add(this.live);
      this.live = undefined;
    }
    void this.changes.close(cancelled ? 'cancelled' : reason);
  }
}
