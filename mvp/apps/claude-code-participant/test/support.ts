import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { Options, Query, SDKUserMessage, SessionKey, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import { IClaudeCode } from '../src/ClaudeCode.js';
import { ControlLines } from '../src/ControlLines.js';
import { participantServices } from '../src/container.js';
import { IHost } from '../src/Host.js';
import type { MessageChannel } from '../src/MessageChannel.js';
import { ParticipantConfig } from '../src/ParticipantConfig.js';
import { type ChildProcessHandle, IProcessSpawner, type ProcessOptions } from '../src/ProcessSpawner.js';
import { IProcessTable, type ProcessIdentity, type TaggedProcess } from '../src/ProcessTable.js';
import { ServingGate } from '../src/ServingGate.js';
import { IPublisher } from '../src/SessionStore.js';
import { StartupError } from '../src/startup.js';
import { ITimer } from '../src/Timer.js';

export function testConfig(overrides: { setpriv?: string | null; configDir?: string } = {}): ParticipantConfig {
  return new ParticipantConfig(
    {
      natsUrl: 'nats://127.0.0.1:31416',
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
};

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
    return { interrupt } as unknown as Query;
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

class FakePublisher implements IPublisher {
  public readonly published: { key: SessionKey; entries: SessionStoreEntry[] }[] = [];

  public publish(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    this.published.push({ key, entries });
    return Promise.resolve();
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
}

/**
 * The participant's services with every boundary faked. The serving gate
 * starts open, as it is once the leftover scan is done, unless `gateShut`.
 */
export function testServices(config: ParticipantConfig = testConfig(), options: { gateShut?: boolean } = {}) {
  const services = participantServices(config);
  services.register(FakeClaudeCode).as(IClaudeCode);
  services.register(FakeProcessSpawner).as(IProcessSpawner);
  services.register(FakePublisher).as(IPublisher);
  services.register(FakeProcessTable).as(IProcessTable);
  services.register(FakeTimer).as(ITimer);
  services.register(FakeHost).as(IHost);
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
    publisher: provider.resolve(IPublisher) as FakePublisher,
    host: provider.resolve(IHost) as FakeHost,
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
