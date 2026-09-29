import { PassThrough } from 'node:stream';
import type { Options, Query, SDKUserMessage, SessionKey, SessionStoreEntry, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { IClaudeCode } from '../src/ClaudeCode.js';
import { ControlLines } from '../src/ControlLines.js';
import { participantServices } from '../src/container.js';
import { ParticipantConfig } from '../src/ParticipantConfig.js';
import { IProcessSpawner, type ProcessOptions } from '../src/ProcessSpawner.js';
import { IPublisher } from '../src/SessionStore.js';

export function testConfig(overrides: { setpriv?: string | null } = {}): ParticipantConfig {
  return new ParticipantConfig(
    {
      natsUrl: 'nats://127.0.0.1:31416',
      configDir: '/agents/alpha/config',
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

/** The participant's services with every boundary faked. */
export function testServices(config: ParticipantConfig = testConfig()) {
  const services = participantServices(config);
  services.register(FakeClaudeCode).as(IClaudeCode);
  services.register(FakeProcessSpawner).as(IProcessSpawner);
  services.register(FakePublisher).as(IPublisher);
  const provider = services.buildProvider();
  return {
    provider,
    claudeCode: provider.resolve(IClaudeCode) as FakeClaudeCode,
    processes: provider.resolve(IProcessSpawner) as FakeProcessSpawner,
    publisher: provider.resolve(IPublisher) as FakePublisher,
    /** Sends control lines, as stdin would, and returns their replies. */
    control: (...lines: unknown[]) => lines.map((line) => provider.resolve(ControlLines).handle(typeof line === 'string' ? line : JSON.stringify(line))),
  };
}

export const CONFIGURED: unknown[] = [{ model: { name: 'claude-sonnet-5', maxTokens: 32000, thinking: 'adaptive', thinkingDisplay: 'summarized', effort: 'medium' } }, { system: { preset: true } }, { permissionMode: 'auto' }];
