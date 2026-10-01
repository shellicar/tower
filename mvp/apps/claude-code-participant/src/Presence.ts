import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { dependsOn } from '@shellicar/core-di';
import { z } from 'zod';
import { type BrokerRequest, type BrokerSubscription, IBroker, type Reply } from './Broker.js';
import { readRecord } from './ClaudeCodeRecord.js';
import { ConversationLauncher, NotConfiguredError } from './ConversationLauncher.js';
import { describeError } from './describeError.js';
import { IHost } from './Host.js';
import { IIds } from './Ids.js';
import { ParticipantConfig } from './ParticipantConfig.js';
import { rejected, ServedConversation, type ServingInstance } from './ServedConversation.js';
import { ServingGate } from './ServingGate.js';
import { IPublisher } from './SessionStore.js';
import { ITimer } from './Timer.js';

/** The liveness promise every pulse and `attached` makes: another pulse within this many seconds. */
const PULSE_INTERVAL_S = 30;

/** The world's queue group: every instance serving a world joins it, so exactly one answers each request. */
const QUEUE_GROUP = 'servicers';

const serviceRequest = z.looseObject({
  conversationId: z.uuid(),
  cwd: z.string().min(1),
  model: z.string().optional(),
});

/**
 * Where the instance stands on the bus. `idle` until it has published
 * `ready`; `unavailable` once shutdown has begun, whether or not it ever got
 * as far as `ready`.
 */
type State = 'idle' | 'serving' | 'unavailable' | 'offline';

/**
 * The instance on tower's bus: its presence in the world (`ready`, `pulse`,
 * `unavailable`, `offline`), the world's requests, and the conversations it
 * holds.
 */
export class Presence {
  @dependsOn(IBroker) private readonly broker!: IBroker;
  @dependsOn(ParticipantConfig) private readonly config!: ParticipantConfig;
  @dependsOn(IIds) private readonly ids!: IIds;
  @dependsOn(ITimer) private readonly timer!: ITimer;
  @dependsOn(IHost) private readonly host!: IHost;
  @dependsOn(ConversationLauncher) private readonly launcher!: ConversationLauncher;
  @dependsOn(ServingGate) private readonly gate!: ServingGate;
  @dependsOn(IPublisher) private readonly publisher!: IPublisher;

  private state: State = 'idle';
  private instanceId: string | undefined;
  private worldRequests: BrokerSubscription | undefined;
  private stopPulsing: (() => void) | undefined;
  /** Every conversation claimed, from the moment its `service` is taken up. */
  private readonly claimed = new Set<string>();
  private readonly served = new Map<string, ServedConversation>();

  private get agentPrefix(): string {
    return `agent.v1.${this.config.world}`;
  }

  /**
   * Connects, waits for the serving gate, then joins the world's queue group
   * and announces itself: `ready`, then a first `pulse`, then one every
   * interval. Shutdown beginning first stops it where it is.
   */
  public async start(): Promise<void> {
    await this.broker.connect();
    await this.gate.wait();
    if (this.state !== 'idle') {
      return;
    }
    const instanceId = this.ids.mint();
    this.instanceId = instanceId;
    this.worldRequests = this.broker.subscribe(`${this.agentPrefix}.requests.>`, (request) => void this.onWorldRequest(request), { queue: QUEUE_GROUP });
    this.state = 'serving';
    this.broker.publish(`${this.agentPrefix}.telemetry.ready`, { ts: this.timer.timestamp(), instanceId });
    this.pulse();
    this.stopPulsing = this.timer.every(PULSE_INTERVAL_S * 1000, () => this.pulse());
    this.host.log(`serving world ${this.config.world} as instance ${instanceId}`);
  }

  /** Shutdown's first step: leaves the world's queue group and publishes `unavailable`. Says are refused from here on. */
  public stopServing(): void {
    if (this.state === 'serving') {
      this.worldRequests?.unsubscribe();
      this.publishTelemetry('unavailable');
    }
    if (this.state === 'idle' || this.state === 'serving') {
      this.state = 'unavailable';
    }
  }

  /** Publishes `detached` for every conversation still held. */
  public detachAll(): void {
    for (const conversation of this.served.values()) {
      conversation.detach();
    }
  }

  /** Stops pulsing and publishes `offline`, once. */
  public goOffline(): void {
    if (this.state === 'offline') {
      return;
    }
    const announced = this.instanceId !== undefined;
    this.state = 'offline';
    this.stopPulsing?.();
    if (announced) {
      this.publishTelemetry('offline');
    }
  }

  /** Ends the connection: `drain` lets what was received finish; `close` doesn't wait for it. */
  public async disconnect(how: 'drain' | 'close'): Promise<void> {
    try {
      await (how === 'drain' ? this.broker.drain() : this.broker.close());
    } catch (err) {
      this.host.log(`closing the NATS connection failed: ${describeError(err)}`);
    }
  }

  private pulse(): void {
    this.publishTelemetry('pulse', { intervalS: PULSE_INTERVAL_S });
  }

  private publishTelemetry(event: string, fields: Record<string, unknown> = {}): void {
    this.broker.publish(`${this.agentPrefix}.telemetry.${event}`, { ts: this.timer.timestamp(), instanceId: this.instanceId, ...fields });
  }

  private async onWorldRequest(request: BrokerRequest): Promise<void> {
    const leaf = request.subject.slice(`${this.agentPrefix}.requests.`.length);
    if (leaf !== 'service') {
      // drain, and any leaf not known here.
      request.reply(rejected('unsupported'));
      return;
    }
    try {
      request.reply(await this.service(request.body));
    } catch (err) {
      this.host.log(`service failed: ${describeError(err)}`);
      request.reply(rejected('failed', describeError(err)));
    }
  }

  private async service(body: unknown): Promise<Reply> {
    if (this.state !== 'serving') {
      return rejected('unavailable');
    }
    const parsed = serviceRequest.safeParse(body);
    if (!parsed.success) {
      return rejected('invalid', parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
    }
    const { conversationId, cwd, model } = parsed.data;
    // TODO: launch with the model a `service` names (agent.md: presence
    // binds). Until then a service that names one is rejected unsupported.
    if (model !== undefined) {
      return rejected('unsupported', 'a model named on service is not supported');
    }
    // Claimed before anything is awaited, so a second `service` for the same
    // conversation arriving meanwhile is refused rather than taken twice.
    if (this.claimed.has(conversationId)) {
      return rejected('already_attached');
    }
    this.claimed.add(conversationId);
    let reply: Reply;
    try {
      reply = await this.take(conversationId, cwd);
    } catch (err) {
      this.claimed.delete(conversationId);
      throw err;
    }
    if (!('accepted' in reply)) {
      this.claimed.delete(conversationId);
    }
    return reply;
  }

  // TODO: decide `service` by the spec's premise: the conversation's
  // attachment record and this world's liveness, read from a warm fold, with
  // the queue group joined only once that fold is warm. Until then a
  // conversation this instance doesn't hold is always taken.
  private async take(conversationId: string, cwd: string): Promise<Reply> {
    const cwdProblem = await checkCwd(cwd);
    if (cwdProblem !== undefined) {
      return rejected('invalid_cwd', cwdProblem);
    }
    const resume = (await readRecord(this.config.configDir, conversationId)) !== undefined;
    const { instanceId } = this;
    if (this.state !== 'serving' || instanceId === undefined) {
      return rejected('unavailable');
    }
    let conversation: Awaited<ReturnType<ConversationLauncher['launch']>>;
    try {
      conversation = await this.launcher.launch({ id: conversationId, cwd, additionalDirectories: [], resume });
    } catch (err) {
      if (err instanceof NotConfiguredError) {
        return rejected('failed', err.message);
      }
      throw err;
    }
    this.served.set(conversationId, new ServedConversation(conversation, this.servingInstance(instanceId)));
    this.broker.publish(`conv.v2.${conversationId}.attachment.attached`, {
      ts: this.timer.timestamp(),
      instanceId,
      world: this.config.world,
      cwd,
      intervalS: PULSE_INTERVAL_S,
    });
    this.host.log(`serving conversation ${conversationId} in ${cwd}${resume ? ', resumed' : ''}`);
    return { accepted: true };
  }

  private servingInstance(instanceId: string): ServingInstance {
    return {
      broker: this.broker,
      timer: this.timer,
      ids: this.ids,
      host: this.host,
      publisher: this.publisher,
      configDir: this.config.configDir,
      durableBucket: this.config.durableBucket,
      world: this.config.world,
      instanceId,
      isUnavailable: () => this.state !== 'serving',
    };
  }
}

/** Why `cwd` can't be a conversation's working directory, or undefined when it can. */
async function checkCwd(cwd: string): Promise<string | undefined> {
  if (!isAbsolute(cwd)) {
    return `cwd ${cwd} is not an absolute path`;
  }
  try {
    const stats = await stat(cwd);
    return stats.isDirectory() ? undefined : `cwd ${cwd} is not a directory`;
  } catch (err) {
    return `cwd ${cwd}: ${describeError(err)}`;
  }
}
