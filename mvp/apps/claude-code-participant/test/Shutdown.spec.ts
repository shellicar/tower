import { describe, expect, it } from 'vitest';
import { ConversationLauncher, type LaunchRequest } from '../src/ConversationLauncher.js';
import { Conversations } from '../src/Conversations.js';
import { Shutdown } from '../src/Shutdown.js';
import { CONFIGURED, type FakeChild, testServices } from './support.js';

function request(n: number): LaunchRequest {
  return { id: `0f8b7c1e-2a4d-4e6f-9b1a-3c5d7e9f1a2${n}`, cwd: '/work/project', additionalDirectories: [], resume: false };
}

/** Lets every pending promise callback run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A configured participant serving `count` conversations, each with its Claude Code started. */
async function serving(count: number, lines: unknown[] = []) {
  const services = testServices();
  services.control(...CONFIGURED, ...lines);
  const launcher = services.provider.resolve(ConversationLauncher);
  const conversations = await Promise.all(Array.from({ length: count }, (_, n) => launcher.launch(request(n))));
  for (const launch of services.claudeCode.launches) {
    launch.start();
  }
  const children = services.processes.spawns.map((spawn) => spawn.child);
  const launches = services.claudeCode.launches;
  const shutdown = services.provider.resolve(Shutdown);
  return { ...services, conversations, children, launches, shutdown };
}

function exitAll(children: FakeChild[]): void {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.exit(0);
    }
  }
}

/** Whether the conversation's input has been closed: the fake's reader ends when it is. */
async function inputClosed(done: Promise<void>): Promise<boolean> {
  let closed = false;
  void done.then(() => {
    closed = true;
  });
  await settle();
  return closed;
}

describe('Shutdown', () => {
  describe('stage 1: graceful', () => {
    it('interrupts every conversation, with or without a turn of its own', async () => {
      const { shutdown, launches } = await serving(2);
      shutdown.trigger('SIGINT');
      await settle();
      expect(launches.map((launch) => launch.interrupts.length)).toEqual([1, 1]);
    });

    it('interrupts before closing the input', async () => {
      const { shutdown, launches } = await serving(1);
      shutdown.trigger('SIGINT');
      await settle();
      expect(launches[0]?.interrupts).toEqual([false]);
    });

    it('closes the input once the interrupt has answered', async () => {
      const { shutdown, launches } = await serving(1);
      shutdown.trigger('SIGINT');
      expect(await inputClosed(launches[0]?.done ?? Promise.reject())).toBe(true);
    });

    it('keeps the input open while the interrupt is unanswered', async () => {
      const { shutdown, launches } = await serving(1);
      const [launch] = launches;
      if (launch === undefined) {
        throw new Error('nothing was launched');
      }
      launch.interruptBehaviour = 'hang';
      shutdown.trigger('SIGINT');
      expect(await inputClosed(launch.done)).toBe(false);
    });

    it('does not hold one conversation back for another whose interrupt is unanswered', async () => {
      const { shutdown, launches } = await serving(2);
      const [hung, other] = launches;
      if (hung === undefined || other === undefined) {
        throw new Error('nothing was launched');
      }
      hung.interruptBehaviour = 'hang';
      shutdown.trigger('SIGINT');
      expect(await inputClosed(other.done)).toBe(true);
    });

    it('closes the input when the interrupt fails, as it does against a Claude Code already gone', async () => {
      const { shutdown, launches } = await serving(1);
      const [launch] = launches;
      if (launch === undefined) {
        throw new Error('nothing was launched');
      }
      launch.interruptBehaviour = new Error('Query closed before response received');
      shutdown.trigger('SIGINT');
      expect(await inputClosed(launch.done)).toBe(true);
    });

    it('logs a failed interrupt with its underlying cause', async () => {
      const { shutdown, launches, host, conversations } = await serving(1);
      const [launch] = launches;
      if (launch === undefined) {
        throw new Error('nothing was launched');
      }
      launch.interruptBehaviour = new Error('interrupt refused', { cause: new Error('Cannot write to terminated process') });
      shutdown.trigger('SIGINT');
      await settle();
      expect(host.logs).toContain(`shutdown: interrupting conversation ${conversations[0]?.id} failed: interrupt refused: Cannot write to terminated process`);
    });

    it('lets the process end by itself', async () => {
      const { shutdown, host } = await serving(1);
      shutdown.trigger('SIGINT');
      expect(host.letEndCalls).toBe(1);
    });

    it('never exits the process itself', async () => {
      const { shutdown, host, children } = await serving(2);
      shutdown.trigger('SIGINT');
      await settle();
      exitAll(children);
      await settle();
      expect(host.exits).toEqual([]);
    });

    it('says so once every Claude Code has exited', async () => {
      const { shutdown, host, children } = await serving(2);
      shutdown.trigger('SIGINT');
      await settle();
      exitAll(children);
      await settle();
      expect(host.logs).toContain('shutdown stage 1: every Claude Code has exited');
    });

    it('keeps waiting while a Claude Code still runs', async () => {
      const { shutdown, host, children } = await serving(2);
      shutdown.trigger('SIGINT');
      await settle();
      children[0]?.exit(0);
      await settle();
      expect(host.logs).not.toContain('shutdown stage 1: every Claude Code has exited');
    });

    it('leaves alone a conversation whose Claude Code has already exited', async () => {
      const { shutdown, launches, children } = await serving(1);
      children[0]?.exit(0);
      await settle();
      shutdown.trigger('SIGINT');
      await settle();
      expect(launches[0]?.interrupts).toEqual([]);
    });

    it('names the trigger', async () => {
      const { shutdown, host } = await serving(0);
      shutdown.trigger('SIGHUP');
      expect(host.logs[0]).toBe('shutdown stage 1 (SIGHUP): interrupting every turn and waiting up to 30000 ms for everything to finish');
    });

    it('arms a deadline of 30 s by default', async () => {
      const { shutdown, host } = await serving(1);
      shutdown.trigger('SIGINT');
      expect(host.deadlines.map((deadline) => deadline.ms)).toEqual([30000]);
    });

    it('arms the deadline the shutdown line set', async () => {
      const { shutdown, host } = await serving(1, [{ shutdown: { gracefulMs: 5000, teardownMs: 2000 } }]);
      shutdown.trigger('SIGINT');
      expect(host.deadlines.map((deadline) => deadline.ms)).toEqual([5000]);
    });

    it('keeps its deadline armed once every Claude Code has exited, in case something else never finishes', async () => {
      const { shutdown, host, children } = await serving(1);
      shutdown.trigger('SIGINT');
      await settle();
      exitAll(children);
      await settle();
      expect(host.deadlines[0]?.cancelled).toBe(false);
    });
  });

  describe('escalating from stage 1', () => {
    it('starts stage 2 at once on a second trigger', async () => {
      const { shutdown, processes } = await serving(1);
      shutdown.trigger('SIGINT');
      shutdown.trigger('SIGINT');
      expect(processes.signals).toEqual([{ pid: 4001, signal: 'SIGTERM' }]);
    });

    it('starts stage 2 when its deadline passes', async () => {
      const { shutdown, processes, host } = await serving(1);
      shutdown.trigger('SIGTERM');
      host.deadlines[0]?.expire();
      expect(processes.signals).toEqual([{ pid: 4001, signal: 'SIGTERM' }]);
    });

    it('says the deadline passed', async () => {
      const { shutdown, host } = await serving(1);
      shutdown.trigger('SIGTERM');
      host.deadlines[0]?.expire();
      expect(host.logs[1]).toBe('shutdown stage 2 (stage 1 took longer than 30000 ms): killing every Claude Code and waiting up to 10000 ms');
    });

    it('cancels its deadline when a trigger escalates first', async () => {
      const { shutdown, host } = await serving(1);
      shutdown.trigger('SIGINT');
      shutdown.trigger('stdin closed');
      expect(host.deadlines[0]?.cancelled).toBe(true);
    });

    it('does not report stage 1 finished once stage 2 has started', async () => {
      const { shutdown, host, children } = await serving(1);
      shutdown.trigger('SIGINT');
      await settle();
      shutdown.trigger('SIGINT');
      exitAll(children);
      await settle();
      expect(host.logs).not.toContain('shutdown stage 1: every Claude Code has exited');
    });
  });

  describe('stage 2: teardown', () => {
    it("sends SIGTERM to every running Claude Code's process group", async () => {
      const { shutdown, processes } = await serving(2);
      shutdown.trigger('SIGINT');
      shutdown.trigger('SIGINT');
      expect(processes.signals).toEqual([
        { pid: 4001, signal: 'SIGTERM' },
        { pid: 4002, signal: 'SIGTERM' },
      ]);
    });

    it('signals no process group once its Claude Code has exited', async () => {
      const { shutdown, processes, children } = await serving(2);
      shutdown.trigger('SIGINT');
      await settle();
      children[0]?.exit(0);
      await settle();
      shutdown.trigger('SIGINT');
      expect(processes.signals).toEqual([{ pid: 4002, signal: 'SIGTERM' }]);
    });

    it('signals nothing for a conversation whose Claude Code never started', async () => {
      const services = testServices();
      services.control(...CONFIGURED);
      await services.provider.resolve(ConversationLauncher).launch(request(0));
      const shutdown = services.provider.resolve(Shutdown);
      shutdown.trigger('SIGINT');
      shutdown.trigger('SIGINT');
      expect(services.processes.signals).toEqual([]);
    });

    it('exits with 1 once every Claude Code it signalled has exited', async () => {
      const { shutdown, host, children } = await serving(2);
      shutdown.trigger('SIGINT');
      shutdown.trigger('SIGINT');
      exitAll(children);
      await settle();
      expect(host.exits).toEqual([1]);
    });

    it('keeps waiting while a signalled Claude Code still runs', async () => {
      const { shutdown, host, children } = await serving(2);
      shutdown.trigger('SIGINT');
      shutdown.trigger('SIGINT');
      children[0]?.exit(null, 'SIGTERM');
      await settle();
      expect(host.exits).toEqual([]);
    });

    it('logs a group it could not signal', async () => {
      const { shutdown, processes, host, conversations } = await serving(2);
      processes.signalFailures.set(4001, new Error('kill EPERM'));
      shutdown.trigger('SIGINT');
      shutdown.trigger('SIGINT');
      expect(host.logs.at(-1)).toBe(`shutdown: signalling conversation ${conversations[0]?.id}'s Claude Code failed: kill EPERM`);
    });

    it('still signals the rest after one fails', async () => {
      const { shutdown, processes } = await serving(2);
      processes.signalFailures.set(4001, new Error('kill EPERM'));
      shutdown.trigger('SIGINT');
      shutdown.trigger('SIGINT');
      expect(processes.signals).toEqual([{ pid: 4002, signal: 'SIGTERM' }]);
    });

    it('arms a deadline of 10 s by default', async () => {
      const { shutdown, host } = await serving(1);
      shutdown.trigger('SIGINT');
      shutdown.trigger('SIGINT');
      expect(host.deadlines.map((deadline) => deadline.ms)).toEqual([30000, 10000]);
    });

    it('arms the deadline the shutdown line set', async () => {
      const { shutdown, host } = await serving(1, [{ shutdown: { gracefulMs: 5000, teardownMs: 2000 } }]);
      shutdown.trigger('SIGINT');
      shutdown.trigger('SIGINT');
      expect(host.deadlines.map((deadline) => deadline.ms)).toEqual([5000, 2000]);
    });
  });

  describe('stage 3: exit', () => {
    it('exits with 1 at once on a third trigger', async () => {
      const { shutdown, host } = await serving(1);
      shutdown.trigger('SIGINT');
      shutdown.trigger('SIGINT');
      shutdown.trigger('SIGINT');
      expect(host.exits).toEqual([1]);
    });

    it('exits with 1 when the stage 2 deadline passes', async () => {
      const { shutdown, host } = await serving(1);
      shutdown.trigger('SIGHUP');
      host.deadlines[0]?.expire();
      host.deadlines[1]?.expire();
      expect(host.exits).toEqual([1]);
    });

    it('cancels the stage 2 deadline when a trigger escalates first', async () => {
      const { shutdown, host } = await serving(1);
      shutdown.trigger('SIGINT');
      shutdown.trigger('SIGINT');
      shutdown.trigger('SIGINT');
      expect(host.deadlines[1]?.cancelled).toBe(true);
    });

    it('does not exit a second time when stage 2 finishes after it', async () => {
      const { shutdown, host, children } = await serving(1);
      shutdown.trigger('SIGINT');
      shutdown.trigger('SIGINT');
      shutdown.trigger('SIGINT');
      exitAll(children);
      await settle();
      expect(host.exits).toEqual([1]);
    });
  });
});

describe('Conversations', () => {
  it('holds each launched conversation', async () => {
    const { provider, conversations } = await serving(2);
    expect(provider.resolve(Conversations).all()).toEqual(conversations);
  });

  it('drops a conversation once its Claude Code exits', async () => {
    const { provider, conversations, children } = await serving(2);
    children[0]?.exit(0);
    await settle();
    expect(provider.resolve(Conversations).all()).toEqual([conversations[1]]);
  });

  it('drops a conversation whose Claude Code failed to start', async () => {
    const services = testServices();
    services.control(...CONFIGURED);
    await services.provider.resolve(ConversationLauncher).launch(request(0));
    services.processes.failNextStart = true;
    services.claudeCode.launches[0]?.start();
    await settle();
    expect(services.provider.resolve(Conversations).all()).toEqual([]);
  });
});
