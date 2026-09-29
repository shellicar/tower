import { PassThrough } from 'node:stream';
import type { Options, Query, SDKUserMessage, SessionKey, SessionStoreEntry, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { IClaudeCode } from '../src/ClaudeCode.js';
import { ControlLines } from '../src/ControlLines.js';
import { participantServices } from '../src/container.js';
import { ParticipantConfig } from '../src/ParticipantConfig.js';
import { IProcessSpawner, type ProcessOptions } from '../src/ProcessSpawner.js';
import { IProcessTable, type ProcessIdentity, type TaggedProcess } from '../src/ProcessTable.js';
import { IPublisher } from '../src/SessionStore.js';
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

/** Records each query instead of starting Claude Code, and collects what the conversation sends it. */
class FakeClaudeCode implements IClaudeCode {
  public readonly launches: { options: Options; sent: SDKUserMessage[]; done: Promise<void> }[] = [];

  public query(prompt: AsyncIterable<SDKUserMessage>, options: Options): Query {
    const sent: SDKUserMessage[] = [];
    const done = (async () => {
      for await (const message of prompt) {
        sent.push(message);
      }
    })();
    this.launches.push({ options, sent, done });
    return {} as Query;
  }
}

/** Records each spawn instead of starting a process. */
class FakeProcessSpawner implements IProcessSpawner {
  public readonly spawns: { command: string; args: string[]; options: ProcessOptions }[] = [];

  public spawn(command: string, args: string[], options: ProcessOptions): SpawnedProcess {
    this.spawns.push({ command, args, options });
    return { stdin: new PassThrough(), stdout: new PassThrough() } as unknown as SpawnedProcess;
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
};

/** A process list the test writes, which records each signal and ends a process on the ones it names. */
class FakeProcessTable implements IProcessTable {
  public ownIdentity: ProcessIdentity = { pid: 100, startTime: '500' };
  public processes: FakeProcess[] = [];
  public readonly signals: { pid: number; signal: NodeJS.Signals }[] = [];
  /** Runs on each liveness check, before it is answered: how a test makes something happen at that moment. */
  public onIsRunning: ((process: ProcessIdentity) => void) | undefined;

  public add(pid: number, tag: string, endsOn: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGKILL']): void {
    this.processes.push({ pid, startTime: `${pid}0`, commandLine: `cmd-${pid}`, tag, endsOn });
  }

  public own(): ProcessIdentity {
    return this.ownIdentity;
  }

  public isRunning(process: ProcessIdentity): boolean {
    this.onIsRunning?.(process);
    return process.pid === this.ownIdentity.pid ? process.startTime === this.ownIdentity.startTime : this.processes.some((p) => p.pid === process.pid && p.startTime === process.startTime);
  }

  public tagged(entry: string): TaggedProcess[] {
    return this.processes.filter((p) => p.tag === entry).map(({ pid, startTime, commandLine }) => ({ pid, startTime, commandLine }));
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

/** The participant's services with every boundary faked. */
export function testServices(config: ParticipantConfig = testConfig()) {
  const services = participantServices(config);
  services.register(FakeClaudeCode).as(IClaudeCode);
  services.register(FakeProcessSpawner).as(IProcessSpawner);
  services.register(FakePublisher).as(IPublisher);
  services.register(FakeProcessTable).as(IProcessTable);
  services.register(FakeTimer).as(ITimer);
  const provider = services.buildProvider();
  return {
    provider,
    claudeCode: provider.resolve(IClaudeCode) as FakeClaudeCode,
    processes: provider.resolve(IProcessSpawner) as FakeProcessSpawner,
    processTable: provider.resolve(IProcessTable) as FakeProcessTable,
    timer: provider.resolve(ITimer) as FakeTimer,
    publisher: provider.resolve(IPublisher) as FakePublisher,
    /** Sends control lines, as stdin would, and returns their replies. */
    control: (...lines: unknown[]) => lines.map((line) => provider.resolve(ControlLines).handle(typeof line === 'string' ? line : JSON.stringify(line))),
  };
}

export const CONFIGURED: unknown[] = [{ model: { name: 'claude-sonnet-5', maxTokens: 32000, thinking: 'adaptive', thinkingDisplay: 'summarized', effort: 'medium' } }, { system: { preset: true } }, { permissionMode: 'auto' }];
