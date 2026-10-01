import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { type BrokerRequest, type BrokerSubscription, IBroker, type Reply } from '../src/Broker.js';
import { IClaudeCode } from '../src/ClaudeCode.js';
import { ControlLines } from '../src/ControlLines.js';
import { participantServices } from '../src/container.js';
import { IHost } from '../src/Host.js';
import { IIds } from '../src/Ids.js';
import { MessageChannel } from '../src/MessageChannel.js';
import { ParticipantConfig } from '../src/ParticipantConfig.js';
import { type ChildProcessHandle, IProcessSpawner, type ProcessOptions } from '../src/ProcessSpawner.js';
import { IProcessTable, type ProcessIdentity, type TaggedProcess } from '../src/ProcessTable.js';
import { ServingGate } from '../src/ServingGate.js';
import { StartupError } from '../src/startup.js';
import { ITimer } from '../src/Timer.js';

export function testConfig(overrides: { setpriv?: string | null; configDir?: string } = {}): ParticipantConfig {
  return new ParticipantConfig(
    {
      natsUrl: 'nats://127.0.0.1:31416',
      world: 'test-world',
      durableBucket: 'durable-test',
      configDir: overrides.configDir ?? '/agents/alpha/config',
      realHome: '/home/someone',
      inheritedEnv: { PATH: '/usr/bin', LANG: 'C.UTF-8' },
    },
    '/tmp/tower-participant-home-abc123',
    overrides.setpriv === undefined ? '/usr/bin/setpriv' : overrides.setpriv,
    '/opt/participant/bin/real-home-shell.sh',
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
  /** Does what the SDK does when it starts Claude Code: calls the spawn hook. */
  start: () => ChildProcessHandle;
  /** What Claude Code sends back, as the query yields it; closing it ends the query's messages. */
  replies: MessageChannel<SDKMessage>;
};

/** Lets every pending promise callback run. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** The `result` Claude Code sends when a query ends, with only the fields the participant reads. */
export function resultMessage(ending: 'success' | 'error_during_execution' = 'success'): SDKMessage {
  return { type: 'result', subtype: ending, is_error: ending !== 'success' } as SDKMessage;
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
    return { interrupt, [Symbol.asyncIterator]: () => launch.replies[Symbol.asyncIterator]() } as unknown as Query;
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

  public add(pid: number, tag: string, endsOn: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGKILL'], own = false): void {
    this.processes.push({ pid, startTime: `${pid}0`, commandLine: `cmd-${pid}`, tag, endsOn, own });
  }

  public remove(pid: number): void {
    this.processes = this.processes.filter((p) => p.pid !== pid);
  }

  public tagged(entry: string, options: { withOwnDescendants?: boolean } = {}): TaggedProcess[] {
    return this.processes.filter((p) => p.tag === entry && (options.withOwnDescendants === true || !p.own)).map(({ pid, startTime, commandLine }) => ({ pid, startTime, commandLine }));
  }

  public signal(process: ProcessIdentity, signal: NodeJS.Signals): boolean {
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
}

/** Time that passes only when something sleeps, all at once. */
class FakeTimer implements ITimer {
  public time = 0;
  /** Runs after each sleep, with the time it ended at: how a test makes something happen partway through a wait. */
  public onSleep: ((now: number) => void) | undefined;

  public now(): number {
    return this.time;
  }

  public sleep(ms: number): Promise<void> {
    this.time += ms;
    this.onSleep?.(this.time);
    return Promise.resolve();
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

/** Records what is published, stored and subscribed, and delivers a test's requests to whatever subscribes to them. */
class FakeBroker implements IBroker {
  public readonly published: { subject: string; body: Record<string, unknown> }[] = [];
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
  const services = participantServices(config);
  services.register(FakeClaudeCode).as(IClaudeCode);
  services.register(FakeProcessSpawner).as(IProcessSpawner);
  services.register(FakeProcessTable).as(IProcessTable);
  services.register(FakeTimer).as(ITimer);
  services.register(FakeHost).as(IHost);
  services.register(FakeBroker).as(IBroker);
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
