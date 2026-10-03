import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { type BrokerRequest, type BrokerSubscription, IBroker, MessageTooLarge, type Reply } from '../src/Broker.js';
import { IClaudeCode } from '../src/ClaudeCode.js';
import { ControlLines } from '../src/ControlLines.js';
import { participantServices } from '../src/container.js';
import { IHost } from '../src/Host.js';
import { IIds } from '../src/Ids.js';
import { MessageChannel } from '../src/MessageChannel.js';
import { Outbox } from '../src/Outbox.js';
import { IOutboxStore, type OutboxRecord, type StoredRecord } from '../src/OutboxStore.js';
import { ParticipantConfig } from '../src/ParticipantConfig.js';
import { type ChildProcessHandle, IProcessSpawner, type ProcessOptions } from '../src/ProcessSpawner.js';
import { IProcessTable, type ProcessIdentity, ProcessListUnreadable, type TaggedProcess } from '../src/ProcessTable.js';
import { ServingGate } from '../src/ServingGate.js';
import { StartupError } from '../src/startup.js';
import { ITimer } from '../src/Timer.js';

/** A Linux config unless `macOS` is set, which gives it a login dir and the security shim. */
export function testConfig(overrides: { setpriv?: string | null; configDir?: string; macOS?: boolean } = {}): ParticipantConfig {
  return new ParticipantConfig(
    {
      natsUrl: 'nats://127.0.0.1:31416',
      world: 'test-world',
      durableBucket: 'durable-test',
      configDir: overrides.configDir ?? '/agents/alpha/config',
      realHome: '/home/someone',
      loginDir: overrides.macOS === true ? '/data/tower/login' : null,
      inheritedEnv: { PATH: '/usr/bin', LANG: 'C.UTF-8' },
    },
    '/tmp/tower-participant-home-abc123',
    overrides.setpriv === undefined ? '/usr/bin/setpriv' : overrides.setpriv,
    '/opt/participant/bin/real-home-shell.sh',
    overrides.macOS === true ? '/opt/participant/bin/real-home-security' : null,
  );
}

/** What an interrupt does: answer, fail with the error, or never answer. */
type InterruptBehaviour = 'answer' | 'hang' | Error;

type FakeLaunch = {
  options: Options;
  sent: SDKUserMessage[];
  done: Promise<void>;
  /** Whether the input was already closed at each interrupt, one entry per interrupt. */
  interrupts: boolean[];
  interruptBehaviour: InterruptBehaviour;
  /** Each task stopped, with whether the input was already closed when it was, in order. */
  stops: { taskId: string; inputClosed: boolean }[];
  /** What stopping a task does, as for an interrupt. */
  stopBehaviour: InterruptBehaviour;
  /** Does what the SDK does when it starts Claude Code: calls the spawn hook. */
  start: () => ChildProcessHandle;
  /** What Claude Code sends back, as the query yields it; closing it ends the query's messages. */
  replies: MessageChannel<SDKMessage>;
};

/** Lets every pending promise callback run. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Lets the outbox deliver everything the fakes will take: its work is promises, which a few turns of the event loop finish. */
export async function delivered(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await settle();
  }
}

/** The `result` Claude Code sends when a query ends, with only the fields the participant reads. */
export function resultMessage(ending: 'success' | 'error_during_execution' = 'success'): SDKMessage {
  return { type: 'result', subtype: ending, is_error: ending !== 'success' } as SDKMessage;
}

/** The `task_started` Claude Code sends when a task starts, with only the fields the participant reads. */
export function taskStarted(taskId: string, taskType: string): SDKMessage {
  return { type: 'system', subtype: 'task_started', task_id: taskId, task_type: taskType } as SDKMessage;
}

/** The `task_notification` Claude Code sends when a task ends, with only the fields the participant reads. */
export function taskEnded(taskId: string): SDKMessage {
  return { type: 'system', subtype: 'task_notification', task_id: taskId, status: 'completed' } as SDKMessage;
}

/** The `task_updated` Claude Code sends when a task's status changes, with only the fields the participant reads. */
export function taskUpdated(taskId: string, status: string): SDKMessage {
  return { type: 'system', subtype: 'task_updated', task_id: taskId, patch: { status } } as SDKMessage;
}

/** Records each query instead of starting Claude Code, and collects what the conversation sends it. */
class FakeClaudeCode implements IClaudeCode {
  public readonly launches: FakeLaunch[] = [];

  public query(prompt: AsyncIterable<SDKUserMessage>, options: Options): Query {
    const sent: SDKUserMessage[] = [];
    const done = (async () => {
      for await (const message of prompt) {
        sent.push(message);
      }
    })();
    const launch: FakeLaunch = {
      options,
      sent,
      done,
      interrupts: [],
      interruptBehaviour: 'answer',
      stops: [],
      stopBehaviour: 'answer',
      start: () => {
        const hook = options.spawnClaudeCodeProcess;
        if (hook === undefined) {
          throw new Error('launched without a spawn hook');
        }
        return hook({ command: '/sdk/claude', args: [], cwd: options.cwd, env: {}, signal: new AbortController().signal }) as ChildProcessHandle;
      },
      replies: new MessageChannel<SDKMessage>(),
    };
    this.launches.push(launch);
    const interrupt = (): Promise<undefined> => {
      launch.interrupts.push((prompt as MessageChannel<SDKUserMessage>).isClosed);
      const behaviour = launch.interruptBehaviour;
      if (behaviour === 'hang') {
        return new Promise(() => {});
      }
      return behaviour === 'answer' ? Promise.resolve(undefined) : Promise.reject(behaviour);
    };
    const stopTask = (taskId: string): Promise<void> => {
      launch.stops.push({ taskId, inputClosed: (prompt as MessageChannel<SDKUserMessage>).isClosed });
      const behaviour = launch.stopBehaviour;
      if (behaviour === 'hang') {
        return new Promise(() => {});
      }
      return behaviour === 'answer' ? Promise.resolve() : Promise.reject(behaviour);
    };
    return { interrupt, stopTask, [Symbol.asyncIterator]: () => launch.replies[Symbol.asyncIterator]() } as unknown as Query;
  }
}

/** A child process that runs until a test makes it exit. */
export class FakeChild extends EventEmitter {
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly killed = false;
  public exitCode: number | null = null;
  public signalCode: NodeJS.Signals | null = null;
  public readonly pid: number | undefined;

  public constructor(pid: number | undefined) {
    super();
    this.pid = pid;
  }

  public kill(): boolean {
    return true;
  }

  public exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

/** Records each spawn and each group signal instead of touching the OS. */
class FakeProcessSpawner implements IProcessSpawner {
  public readonly spawns: { command: string; args: string[]; options: ProcessOptions; child: FakeChild }[] = [];
  public readonly signals: { pid: number; signal: NodeJS.Signals }[] = [];
  /** Makes the next spawn fail to start, as a missing executable does. */
  public failNextStart = false;
  /** Makes signalling this pid's group fail with this error. */
  public readonly signalFailures = new Map<number, Error>();
  private nextPid = 4001;

  public spawn(command: string, args: string[], options: ProcessOptions): ChildProcessHandle {
    const child = new FakeChild(this.failNextStart ? undefined : this.nextPid++);
    this.failNextStart = false;
    this.spawns.push({ command, args, options, child });
    return child as unknown as ChildProcessHandle;
  }

  public signalGroup(pid: number, signal: NodeJS.Signals): void {
    const failure = this.signalFailures.get(pid);
    if (failure !== undefined) {
      throw failure;
    }
    this.signals.push({ pid, signal });
  }
}

/** Records what shutdown does to the process, and holds its deadlines for a test to expire. */
class FakeHost implements IHost {
  public readonly deadlines: { ms: number; expire: () => void; cancelled: boolean }[] = [];
  public readonly exits: number[] = [];
  public readonly logs: string[] = [];
  public letEndCalls = 0;

  public deadline(ms: number, expired: () => void): () => void {
    const deadline = { ms, expire: expired, cancelled: false };
    this.deadlines.push(deadline);
    return () => {
      deadline.cancelled = true;
    };
  }

  public letEnd(): void {
    this.letEndCalls += 1;
  }

  public exit(code: number): void {
    this.exits.push(code);
  }

  public log(line: string): void {
    this.logs.push(line);
  }
}

type FakeProcess = TaggedProcess & {
  /** The one environment entry the fake matches the tag against. */
  tag: string;
  /** The signals that end it; any other it ignores. */
  endsOn: NodeJS.Signals[];
  /** Started by this process, directly or not: left out unless the search asks for its own descendants. */
  own: boolean;
};

/** A process list the test writes, which records each signal and ends a process on the ones it names. */
class FakeProcessTable implements IProcessTable {
  public processes: FakeProcess[] = [];
  public readonly signals: { pid: number; signal: NodeJS.Signals }[] = [];
  /** Makes signalling this pid fail with this error. */
  public readonly signalFailures = new Map<number, Error>();
  /** Makes `check` fail with this error, as a process list that can't be read does. */
  public checkFailure: Error | undefined;

  public check(): void {
    if (this.checkFailure !== undefined) {
      throw this.checkFailure;
    }
  }

  public add(pid: number, tag: string, endsOn: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGKILL'], own = false): void {
    this.processes.push({ pid, startTime: `${pid}0`, commandLine: `cmd-${pid}`, tag, endsOn, own });
  }

  public remove(pid: number): void {
    this.processes = this.processes.filter((p) => p.pid !== pid);
  }

  /**
   * Makes the list unreadable for `tagged` and `signal`, as a ps that stops
   * working does: a strict read throws, any other reads as no processes.
   */
  public unreadable = false;

  public tagged(entry: string, options: { withOwnDescendants?: boolean; strict?: boolean } = {}): TaggedProcess[] {
    if (this.unreadable) {
      return this.whenUnreadable(options.strict, []);
    }
    return this.processes.filter((p) => p.tag === entry && (options.withOwnDescendants === true || !p.own)).map(({ pid, startTime, commandLine }) => ({ pid, startTime, commandLine }));
  }

  public signal(process: ProcessIdentity, signal: NodeJS.Signals, options: { strict?: boolean } = {}): boolean {
    if (this.unreadable) {
      return this.whenUnreadable(options.strict, false);
    }
    const failure = this.signalFailures.get(process.pid);
    if (failure !== undefined) {
      throw failure;
    }
    const target = this.processes.find((p) => p.pid === process.pid && p.startTime === process.startTime);
    if (target === undefined) {
      return false;
    }
    this.signals.push({ pid: process.pid, signal });
    if (target.endsOn.includes(signal)) {
      this.processes = this.processes.filter((p) => p !== target);
    }
    return true;
  }

  private whenUnreadable<T>(strict: boolean | undefined, otherwise: T): T {
    if (strict === true) {
      throw new ProcessListUnreadable('ps could not be run', { cause: new Error('spawnSync /bin/ps EPERM') });
    }
    return otherwise;
  }
}

/** Time that passes only when something sleeps, all at once. */
class FakeTimer implements ITimer {
  public time = 0;
  /** Runs after each sleep, with the time it ended at: how a test makes something happen partway through a wait. */
  public onSleep: ((now: number) => void) | undefined;

  public now(): number {
    return this.time;
  }

  /** While set, a sleep waits until `wake` is called instead of ending at once. */
  public holdSleeps = false;
  private readonly sleepers: (() => void)[] = [];

  public sleep(ms: number, wake?: AbortSignal): Promise<void> {
    this.time += ms;
    const held = this.holdSleeps
      ? new Promise<void>((resolve) => {
          this.sleepers.push(resolve);
          wake?.addEventListener('abort', () => resolve(), { once: true });
        })
      : Promise.resolve();
    this.onSleep?.(this.time);
    return held;
  }

  /** Ends every sleep that is being held. */
  public wake(): void {
    for (const resolve of this.sleepers.splice(0)) {
      resolve();
    }
  }

  public timestamp(): string {
    return FAKE_TIMESTAMP;
  }

  /** Every repeating callback asked for; a test ticks one by calling it. */
  public readonly repeating: { ms: number; tick: () => void; stopped: boolean }[] = [];

  public every(ms: number, tick: () => void): () => void {
    const repeating = { ms, tick, stopped: false };
    this.repeating.push(repeating);
    return () => {
      repeating.stopped = true;
    };
  }
}

export const FAKE_TIMESTAMP = '2026-10-01T10:00:00.000+10:00';

/** Ids in the order they are minted: id-1, id-2, and so on. */
class FakeIds implements IIds {
  private minted = 0;

  public mint(): string {
    this.minted += 1;
    return `id-${this.minted}`;
  }
}

/** Whether a NATS subject matches a subscription's subject, wildcards included. */
function matches(subscribed: string, subject: string): boolean {
  const want = subscribed.split('.');
  const have = subject.split('.');
  for (const [index, token] of want.entries()) {
    if (token === '>') {
      return have.length > index;
    }
    if (index >= have.length || (token !== '*' && token !== have[index])) {
      return false;
    }
  }
  return want.length === have.length;
}

type FakeSubscription = { subject: string; queue: string | undefined; handle: (request: BrokerRequest) => void; active: boolean };

type StoredObject = {
  bucket: string;
  name: string;
  data: Uint8Array;
  metadata: Record<string, string>;
  /** How many messages had been published when it was stored. */
  publishedBefore: number;
};

/** The outbox's directory held in memory; a test reads and writes `conversations` to stand for what is on disk. */
export class FakeOutboxStore implements IOutboxStore {
  public readonly conversationsOnDisk = new Map<string, Map<number, { record: OutboxRecord; blobs: Uint8Array[] }>>();
  /** Makes every write fail with this error, as a full disk does. */
  public writeFailure: Error | undefined;

  public conversations(): Promise<string[]> {
    return Promise.resolve([...this.conversationsOnDisk.keys()].filter((id) => (this.conversationsOnDisk.get(id)?.size ?? 0) > 0));
  }

  public load(conversationId: string): Promise<StoredRecord[]> {
    const records = [...(this.conversationsOnDisk.get(conversationId) ?? [])].sort(([a], [b]) => a - b);
    return Promise.resolve(records.map(([seq, { record }]) => ({ seq, record: structuredClone(record) })));
  }

  public write(conversationId: string, seq: number, record: OutboxRecord, blobs: readonly Uint8Array[]): Promise<void> {
    if (this.writeFailure !== undefined) {
      return Promise.reject(this.writeFailure);
    }
    const directory = this.conversationsOnDisk.get(conversationId) ?? new Map();
    directory.set(seq, { record: structuredClone(record), blobs: [...blobs] });
    this.conversationsOnDisk.set(conversationId, directory);
    return Promise.resolve();
  }

  public readBlob(conversationId: string, seq: number, index: number): Promise<Uint8Array> {
    const blob = this.conversationsOnDisk.get(conversationId)?.get(seq)?.blobs[index];
    return blob === undefined ? Promise.reject(new Error('no such blob')) : Promise.resolve(blob);
  }

  public remove(conversationId: string, seq: number): Promise<void> {
    this.conversationsOnDisk.get(conversationId)?.delete(seq);
    return Promise.resolve();
  }

  /** The ids of what is waiting for the conversation, in order. */
  public waiting(conversationId: string): string[] {
    return [...(this.conversationsOnDisk.get(conversationId) ?? [])].sort(([a], [b]) => a - b).map(([, { record }]) => record.id);
  }
}

/** Records what is published, stored and subscribed, and delivers a test's requests to whatever subscribes to them. */
class FakeBroker implements IBroker {
  /** Everything published, to the stream or not, in the order the broker took it. */
  public readonly published: { subject: string; body: Record<string, unknown> }[] = [];
  /** The id of each message the stream took, in order. A repeat of one already taken is acknowledged and not taken again. */
  public readonly streamIds: string[] = [];
  /** Makes every publish to the stream fail with this error, as a broker that is down or a stream that refuses does. */
  public streamFailure: Error | undefined;
  /** The largest message the fake broker takes, in the size of its JSON body. */
  public maxPayload = Number.POSITIVE_INFINITY;
  /** Called after the stream has taken a message and before it is acknowledged: a test throws here to lose the acknowledgement. */
  public afterTaken: ((id: string) => void) | undefined;
  public readonly objects: StoredObject[] = [];
  public readonly subscriptions: FakeSubscription[] = [];
  public connectFailure: Error | undefined;
  /** Makes every store fail with this error. */
  public storeFailure: Error | undefined;
  public ended: 'drain' | 'close' | undefined;

  public connect(): Promise<void> {
    return this.connectFailure === undefined ? Promise.resolve() : Promise.reject(this.connectFailure);
  }

  public publish(subject: string, body: Record<string, unknown>): void {
    this.published.push({ subject, body: structuredClone(body) });
  }

  public publishToStream(subject: string, body: Record<string, unknown>, id: string): Promise<void> {
    if (this.streamFailure !== undefined) {
      return Promise.reject(this.streamFailure);
    }
    const size = JSON.stringify(body).length;
    if (size > this.maxPayload) {
      return Promise.reject(new MessageTooLarge(size, this.maxPayload));
    }
    if (!this.streamIds.includes(id)) {
      this.streamIds.push(id);
      this.published.push({ subject, body: structuredClone(body) });
    }
    this.afterTaken?.(id);
    return Promise.resolve();
  }

  public subscribe(subject: string, handle: (request: BrokerRequest) => void, options: { queue?: string } = {}): BrokerSubscription {
    const subscription: FakeSubscription = { subject, queue: options.queue, handle, active: true };
    this.subscriptions.push(subscription);
    return {
      unsubscribe: () => {
        subscription.active = false;
      },
    };
  }

  /** While set, every store waits for it before it completes. */
  public storeHold: Promise<void> | undefined;

  public async storeObject(bucket: string, name: string, data: Uint8Array, metadata: Record<string, string>): Promise<void> {
    if (this.storeFailure !== undefined) {
      throw this.storeFailure;
    }
    await this.storeHold;
    this.objects.push({ bucket, name, data, metadata, publishedBefore: this.published.length });
  }

  public drain(): Promise<void> {
    this.ended = 'drain';
    return Promise.resolve();
  }

  public close(): Promise<void> {
    this.ended = 'close';
    return Promise.resolve();
  }

  /** The subjects published, in order. */
  public subjects(): string[] {
    return this.published.map((message) => message.subject);
  }

  /** Whether anything is subscribed to `subject` now. */
  public hasResponder(subject: string): boolean {
    return this.subscriptions.some((subscription) => subscription.active && matches(subscription.subject, subject));
  }

  /** Sends a request as a sender would; resolves with the reply, or undefined when nothing is subscribed. */
  public request(subject: string, body: unknown): Promise<Reply | undefined> {
    const subscription = this.subscriptions.find((candidate) => candidate.active && matches(candidate.subject, subject));
    if (subscription === undefined) {
      return Promise.resolve(undefined);
    }
    return new Promise((resolve) => subscription.handle({ subject, body, reply: resolve }));
  }
}

/**
 * The participant's services with every boundary faked. The serving gate
 * starts open, as it is once the leftover scan is done, unless `gateShut`.
 */
export function testServices(config: ParticipantConfig = testConfig(), options: { gateShut?: boolean } = {}) {
  const services = participantServices(config, 'linux');
  services.register(FakeClaudeCode).as(IClaudeCode);
  services.register(FakeProcessSpawner).as(IProcessSpawner);
  services.register(FakeProcessTable).as(IProcessTable);
  services.register(FakeTimer).as(ITimer);
  services.register(FakeHost).as(IHost);
  services.register(FakeBroker).as(IBroker);
  services.register(FakeOutboxStore).as(IOutboxStore);
  services.register(FakeIds).as(IIds);
  const provider = services.buildProvider();
  if (options.gateShut !== true) {
    provider.resolve(ServingGate).open();
  }
  return {
    provider,
    claudeCode: provider.resolve(IClaudeCode) as FakeClaudeCode,
    processes: provider.resolve(IProcessSpawner) as FakeProcessSpawner,
    processTable: provider.resolve(IProcessTable) as FakeProcessTable,
    timer: provider.resolve(ITimer) as FakeTimer,
    host: provider.resolve(IHost) as FakeHost,
    broker: provider.resolve(IBroker) as FakeBroker,
    outboxStore: provider.resolve(IOutboxStore) as FakeOutboxStore,
    outbox: provider.resolve(Outbox),
    ids: provider.resolve(IIds) as FakeIds,
    /** Sends control lines, as stdin would, and returns their replies. */
    control: (...lines: unknown[]) => lines.map((line) => provider.resolve(ControlLines).handle(typeof line === 'string' ? line : JSON.stringify(line))),
  };
}

export const CONFIGURED: unknown[] = [{ model: { name: 'claude-sonnet-5', maxTokens: 32000, thinking: 'adaptive', thinkingDisplay: 'summarized', effort: 'medium' } }, { system: { preset: true } }, { permissionMode: 'auto' }];

/** Which way a start that fails exits, or undefined when `start` doesn't fail with a startup error. */
export function startupExitOf(start: () => unknown): string | undefined {
  try {
    start();
  } catch (err) {
    return err instanceof StartupError ? err.exit : undefined;
  }
  return undefined;
}
