import { describe, expect, it } from 'vitest';
import { ConversationLauncher, type LaunchRequest } from '../src/ConversationLauncher.js';
import { Conversations } from '../src/Conversations.js';
import { EXITS } from '../src/ExitCodes.js';
import { Shutdown } from '../src/Shutdown.js';
import { CONFIGURED, type FakeChild, taskEnded, taskStarted, taskUpdated, testServices } from './support.js';

const TAG = 'TOWER_PARTICIPANT=/agents/alpha/config';

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
  // Each Claude Code carries the tag, as a process this one started.
  for (const child of children) {
    if (child.pid !== undefined) {
      const pid = child.pid;
      services.processTable.add(pid, TAG, ['SIGKILL'], true);
      child.once('exit', () => services.processTable.remove(pid));
    }
  }
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

type Services = ReturnType<typeof testServices>;

/** The deadline in force: the latest one no escalation has cancelled. */
function current(host: Services['host']) {
  return host.deadlines.filter((deadline) => !deadline.cancelled).at(-1);
}

/**
 * Every second of fake time, the deadline in force expires, so shutdown
 * reaches stage 3 and exits whatever ignores its signals, instead of waiting
 * on it for ever.
 */
function expireDeadlinesInTurn(timer: Services['timer'], host: Services['host']): void {
  let next = 1000;
  timer.onSleep = (now) => {
    if (now >= next) {
      next += 1000;
      current(host)?.expire();
    }
  };
}

/** As expireDeadlinesInTurn, and returns the signals sent before the first deadline expired. */
function signalsBeforeTheDeadline(timer: Services['timer'], host: Services['host'], table: Services['processTable']): () => unknown[] | undefined {
  let seen: unknown[] | undefined;
  let next = 1000;
  timer.onSleep = (now) => {
    if (now >= next) {
      next += 1000;
      seen ??= [...table.signals];
      current(host)?.expire();
    }
  };
  return () => seen;
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
      shutdown.ask('SIGINT');
      await settle();
      expect(launches.map((launch) => launch.interrupts.length)).toEqual([1, 1]);
    });

    it('interrupts before closing the input', async () => {
      const { shutdown, launches } = await serving(1);
      shutdown.ask('SIGINT');
      await settle();
      expect(launches[0]?.interrupts).toEqual([false]);
    });

    it('closes the input once the interrupt has answered', async () => {
      const { shutdown, launches } = await serving(1);
      shutdown.ask('SIGINT');
      expect(await inputClosed(launches[0]?.done ?? Promise.reject())).toBe(true);
    });

    it('keeps the input open while the interrupt is unanswered', async () => {
      const { shutdown, launches } = await serving(1);
      const [launch] = launches;
      if (launch === undefined) {
        throw new Error('nothing was launched');
      }
      launch.interruptBehaviour = 'hang';
      shutdown.ask('SIGINT');
      expect(await inputClosed(launch.done)).toBe(false);
    });

    it('does not hold one conversation back for another whose interrupt is unanswered', async () => {
      const { shutdown, launches } = await serving(2);
      const [hung, other] = launches;
      if (hung === undefined || other === undefined) {
        throw new Error('nothing was launched');
      }
      hung.interruptBehaviour = 'hang';
      shutdown.ask('SIGINT');
      expect(await inputClosed(other.done)).toBe(true);
    });

    it('closes the input when the interrupt fails, as it does against a Claude Code already gone', async () => {
      const { shutdown, launches } = await serving(1);
      const [launch] = launches;
      if (launch === undefined) {
        throw new Error('nothing was launched');
      }
      launch.interruptBehaviour = new Error('Query closed before response received');
      shutdown.ask('SIGINT');
      expect(await inputClosed(launch.done)).toBe(true);
    });

    it('logs a failed interrupt with its underlying cause', async () => {
      const { shutdown, launches, host, conversations } = await serving(1);
      const [launch] = launches;
      if (launch === undefined) {
        throw new Error('nothing was launched');
      }
      launch.interruptBehaviour = new Error('interrupt refused', { cause: new Error('Cannot write to terminated process') });
      shutdown.ask('SIGINT');
      await settle();
      expect(host.logs).toContain(`shutdown: interrupting conversation ${conversations[0]?.id} failed: interrupt refused: Cannot write to terminated process`);
    });

    it('stops every subagent and workflow Claude Code has started', async () => {
      const { shutdown, launches, conversations } = await serving(1);
      conversations[0]?.observe(taskStarted('agent-1', 'local_agent'));
      conversations[0]?.observe(taskStarted('workflow-1', 'local_workflow'));
      shutdown.ask('SIGINT');
      await settle();
      expect(launches[0]?.stops.map((stop) => stop.taskId)).toEqual(['agent-1', 'workflow-1']);
    });

    it('stops them after the interrupt and before closing the input', async () => {
      const { shutdown, launches, conversations } = await serving(1);
      conversations[0]?.observe(taskStarted('agent-1', 'local_agent'));
      shutdown.ask('SIGINT');
      await settle();
      expect({ interrupts: launches[0]?.interrupts, stops: launches[0]?.stops }).toEqual({ interrupts: [false], stops: [{ taskId: 'agent-1', inputClosed: false }] });
    });

    it('leaves out a subagent that has ended', async () => {
      const { shutdown, launches, conversations } = await serving(1);
      conversations[0]?.observe(taskStarted('agent-1', 'local_agent'));
      conversations[0]?.observe(taskEnded('agent-1'));
      shutdown.ask('SIGINT');
      await settle();
      expect(launches[0]?.stops).toEqual([]);
    });

    it.each(['completed', 'failed', 'killed'])('leaves out a subagent updated to %s', async (status) => {
      const { shutdown, launches, conversations } = await serving(1);
      conversations[0]?.observe(taskStarted('agent-1', 'local_agent'));
      conversations[0]?.observe(taskUpdated('agent-1', status));
      shutdown.ask('SIGINT');
      await settle();
      expect(launches[0]?.stops).toEqual([]);
    });

    it('leaves shells to Claude Code', async () => {
      const { shutdown, launches, conversations } = await serving(1);
      conversations[0]?.observe(taskStarted('shell-1', 'local_bash'));
      shutdown.ask('SIGINT');
      await settle();
      expect(launches[0]?.stops).toEqual([]);
    });

    it('closes the input when stopping a subagent fails', async () => {
      const { shutdown, launches, conversations } = await serving(1);
      const [launch] = launches;
      if (launch === undefined) {
        throw new Error('nothing was launched');
      }
      launch.stopBehaviour = new Error('Query closed before response received');
      conversations[0]?.observe(taskStarted('agent-1', 'local_agent'));
      shutdown.ask('SIGINT');
      expect(await inputClosed(launch.done)).toBe(true);
    });

    it('logs a failed stop with its underlying cause', async () => {
      const { shutdown, launches, host, conversations } = await serving(1);
      const [launch] = launches;
      if (launch === undefined) {
        throw new Error('nothing was launched');
      }
      launch.stopBehaviour = new Error('stop refused', { cause: new Error('Cannot write to terminated process') });
      conversations[0]?.observe(taskStarted('agent-1', 'local_agent'));
      shutdown.ask('SIGINT');
      await settle();
      expect(host.logs).toContain(`shutdown: stopping task agent-1 of conversation ${conversations[0]?.id} failed: stop refused: Cannot write to terminated process`);
    });

    it('lets the process end by itself', async () => {
      const { shutdown, host } = await serving(1);
      shutdown.ask('SIGINT');
      expect(host.letEndCalls).toBe(1);
    });

    it('never exits the process itself', async () => {
      const { shutdown, host, children } = await serving(2);
      shutdown.ask('SIGINT');
      await settle();
      exitAll(children);
      await settle();
      expect(host.exits).toEqual([]);
    });

    it('says so once every Claude Code has exited', async () => {
      const { shutdown, host, children } = await serving(2);
      shutdown.ask('SIGINT');
      await settle();
      exitAll(children);
      await settle();
      expect(host.logs).toContain('shutdown stage 1: every Claude Code has exited');
    });

    it('keeps waiting while a Claude Code still runs', async () => {
      const { shutdown, host, children } = await serving(2);
      shutdown.ask('SIGINT');
      await settle();
      children[0]?.exit(0);
      await settle();
      expect(host.logs).not.toContain('shutdown stage 1: every Claude Code has exited');
    });

    it('leaves alone a conversation whose Claude Code has already exited', async () => {
      const { shutdown, launches, children } = await serving(1);
      children[0]?.exit(0);
      await settle();
      shutdown.ask('SIGINT');
      await settle();
      expect(launches[0]?.interrupts).toEqual([]);
    });

    it('names the trigger', async () => {
      const { shutdown, host } = await serving(0);
      shutdown.driverGone('SIGHUP');
      expect(host.logs[0]).toBe('shutdown stage 1 (SIGHUP): interrupting every turn and waiting up to 30000 ms for everything to finish');
    });

    it('arms a deadline of 30 s by default', async () => {
      const { shutdown, host } = await serving(1);
      shutdown.ask('SIGINT');
      expect(host.deadlines.map((deadline) => deadline.ms)).toEqual([30000]);
    });

    it('arms the deadline the shutdownPolicy line set', async () => {
      const { shutdown, host } = await serving(1, [{ shutdownPolicy: { gracefulMs: 5000, teardownMs: 2000 } }]);
      shutdown.ask('SIGINT');
      expect(host.deadlines.map((deadline) => deadline.ms)).toEqual([5000]);
    });

    it('keeps its deadline armed once every Claude Code has exited, in case something else never finishes', async () => {
      const { shutdown, host, children } = await serving(1);
      shutdown.ask('SIGINT');
      await settle();
      exitAll(children);
      await settle();
      expect(host.deadlines[0]?.cancelled).toBe(false);
    });
  });
  describe('stage 1: what outlived its Claude Code', () => {
    it('signals nothing while a Claude Code still runs', async () => {
      const { shutdown, processTable } = await serving(1);
      processTable.add(9001, TAG);
      shutdown.ask('SIGINT');
      await settle();
      expect(processTable.signals).toEqual([]);
    });

    it('sends SIGTERM to what is left once every Claude Code has exited', async () => {
      const { shutdown, processTable, children } = await serving(1);
      processTable.add(9001, TAG);
      shutdown.ask('SIGINT');
      await settle();
      exitAll(children);
      await settle();
      expect(processTable.signals).toEqual([{ pid: 9001, signal: 'SIGTERM' }]);
    });

    it('leaves alone a process tagged for another config dir', async () => {
      const { shutdown, processTable } = await serving(0);
      processTable.add(9001, 'TOWER_PARTICIPANT=/agents/beta/config');
      shutdown.ask('SIGINT');
      await settle();
      expect(processTable.signals).toEqual([]);
    });

    it('says so once nothing it started is left', async () => {
      const { shutdown, processTable, host } = await serving(0);
      processTable.add(9001, TAG);
      shutdown.ask('SIGINT');
      await settle();
      expect(host.logs).toContain('shutdown stage 1: nothing it started is still running');
    });

    it('reads a process list that cannot be read as nothing left, without throwing', async () => {
      const { shutdown, processTable, host } = await serving(0);
      processTable.add(9001, TAG);
      processTable.unreadable = true;
      shutdown.ask('SIGINT');
      await settle();
      expect(host.logs).toContain('shutdown stage 1: nothing it started is still running');
    });

    it('names what it signals', async () => {
      const { shutdown, processTable, host } = await serving(0);
      processTable.add(9001, TAG);
      shutdown.ask('SIGINT');
      await settle();
      expect(host.logs).toContain('shutdown stage 1: SIGTERM to 9001 (cmd-9001)');
    });

    it('keeps waiting, without signalling again, for a process that ignores SIGTERM', async () => {
      const { shutdown, processTable, timer, host } = await serving(0);
      processTable.add(9001, TAG, ['SIGKILL']);
      const inStage1 = signalsBeforeTheDeadline(timer, host, processTable);
      shutdown.ask('SIGINT');
      await settle();
      expect(inStage1()).toEqual([{ pid: 9001, signal: 'SIGTERM' }]);
    });

    it('does not say nothing is left while something is', async () => {
      const { shutdown, processTable, timer, host } = await serving(0);
      processTable.add(9001, TAG, ['SIGKILL']);
      expireDeadlinesInTurn(timer, host);
      shutdown.ask('SIGINT');
      await settle();
      expect(host.logs).not.toContain('shutdown stage 1: nothing it started is still running');
    });

    it('signals a process that appears while it waits', async () => {
      const { shutdown, processTable, timer } = await serving(0);
      processTable.add(9001, TAG, ['SIGKILL']);
      timer.onSleep = (now) => {
        if (now === 100) {
          processTable.add(9002, TAG);
        }
        if (now >= 1000) {
          processTable.processes = [];
        }
      };
      shutdown.ask('SIGINT');
      await settle();
      expect(processTable.signals).toEqual([
        { pid: 9001, signal: 'SIGTERM' },
        { pid: 9002, signal: 'SIGTERM' },
      ]);
    });

    it('carries on when a signal fails', async () => {
      const { shutdown, processTable, timer, host } = await serving(0);
      processTable.add(9001, TAG);
      processTable.add(9002, TAG);
      processTable.signalFailures.set(9001, new Error('kill EPERM'));
      expireDeadlinesInTurn(timer, host);
      shutdown.ask('SIGINT');
      await settle();
      expect(processTable.signals).toContainEqual({ pid: 9002, signal: 'SIGTERM' });
    });
  });

  describe('escalating from stage 1', () => {
    it('starts stage 2 at once on a second trigger', async () => {
      const { shutdown, processes } = await serving(1);
      shutdown.ask('SIGINT');
      shutdown.ask('SIGINT');
      expect(processes.signals).toEqual([{ pid: 4001, signal: 'SIGTERM' }]);
    });

    it('starts stage 2 when its deadline passes', async () => {
      const { shutdown, processes, host } = await serving(1);
      shutdown.ask('SIGTERM');
      host.deadlines[0]?.expire();
      expect(processes.signals).toEqual([{ pid: 4001, signal: 'SIGTERM' }]);
    });

    it('says the deadline passed', async () => {
      const { shutdown, host } = await serving(1);
      shutdown.ask('SIGTERM');
      host.deadlines[0]?.expire();
      expect(host.logs[1]).toBe('shutdown stage 2 (stage 1 took longer than 30000 ms): SIGTERM to every Claude Code, then to whatever is left, waiting up to 10000 ms');
    });

    it('cancels its deadline when a trigger escalates first', async () => {
      const { shutdown, host } = await serving(1);
      shutdown.ask('SIGINT');
      shutdown.ask('SIGTERM');
      expect(host.deadlines[0]?.cancelled).toBe(true);
    });

    it('does not report stage 1 finished once stage 2 has started', async () => {
      const { shutdown, host, children } = await serving(1);
      shutdown.ask('SIGINT');
      await settle();
      shutdown.ask('SIGINT');
      exitAll(children);
      await settle();
      expect(host.logs).not.toContain('shutdown stage 1: every Claude Code has exited');
    });

    it('leaves what outlived its Claude Code to stage 2 once stage 2 has started', async () => {
      const { shutdown, processTable, children, host } = await serving(1);
      processTable.add(9001, TAG);
      shutdown.ask('SIGINT');
      await settle();
      shutdown.ask('SIGINT');
      exitAll(children);
      await settle();
      expect(host.logs.filter((line) => line.startsWith('shutdown stage 1: SIGTERM'))).toEqual([]);
    });
  });

  describe('stage 2: SIGTERM', () => {
    it("sends SIGTERM to every running Claude Code's process group", async () => {
      const { shutdown, processes } = await serving(2);
      shutdown.ask('SIGINT');
      shutdown.ask('SIGINT');
      expect(processes.signals).toEqual([
        { pid: 4001, signal: 'SIGTERM' },
        { pid: 4002, signal: 'SIGTERM' },
      ]);
    });

    it('signals no process group once its Claude Code has exited', async () => {
      const { shutdown, processes, children } = await serving(2);
      shutdown.ask('SIGINT');
      await settle();
      children[0]?.exit(0);
      await settle();
      shutdown.ask('SIGINT');
      expect(processes.signals).toEqual([{ pid: 4002, signal: 'SIGTERM' }]);
    });

    it('signals nothing for a conversation whose Claude Code never started', async () => {
      const services = testServices();
      services.control(...CONFIGURED);
      await services.provider.resolve(ConversationLauncher).launch(request(0));
      const shutdown = services.provider.resolve(Shutdown);
      shutdown.ask('SIGINT');
      shutdown.ask('SIGINT');
      expect(services.processes.signals).toEqual([]);
    });

    it('logs a group it could not signal', async () => {
      const { shutdown, processes, host, conversations } = await serving(2);
      processes.signalFailures.set(4001, new Error('kill EPERM'));
      shutdown.ask('SIGINT');
      shutdown.ask('SIGINT');
      expect(host.logs).toContain(`shutdown: signalling conversation ${conversations[0]?.id}'s Claude Code failed: kill EPERM`);
    });

    it('still signals the rest after one fails', async () => {
      const { shutdown, processes } = await serving(2);
      processes.signalFailures.set(4001, new Error('kill EPERM'));
      shutdown.ask('SIGINT');
      shutdown.ask('SIGINT');
      expect(processes.signals).toEqual([{ pid: 4002, signal: 'SIGTERM' }]);
    });

    it('signals no command while a Claude Code it signalled still runs', async () => {
      const { shutdown, processTable } = await serving(1);
      processTable.add(9001, TAG);
      shutdown.ask('SIGINT');
      shutdown.ask('SIGINT');
      await settle();
      expect(processTable.signals).toEqual([]);
    });

    it('sends SIGTERM to what is left once the Claude Codes have gone', async () => {
      const { shutdown, processTable, children } = await serving(1);
      processTable.add(9001, TAG);
      shutdown.ask('SIGINT');
      shutdown.ask('SIGINT');
      exitAll(children);
      await settle();
      expect(processTable.signals).toEqual([{ pid: 9001, signal: 'SIGTERM' }]);
    });

    it('sends SIGTERM to a Claude Code whose group it could not signal', async () => {
      const { shutdown, processes, processTable, timer, host } = await serving(1);
      processes.signalFailures.set(4001, new Error('kill EPERM'));
      const inStage2 = signalsBeforeTheDeadline(timer, host, processTable);
      shutdown.ask('SIGINT');
      shutdown.ask('SIGINT');
      await settle();
      expect(inStage2()).toEqual([{ pid: 4001, signal: 'SIGTERM' }]);
    });

    it('sends no SIGKILL, however long something ignores SIGTERM', async () => {
      const { shutdown, processTable, timer, host } = await serving(0);
      processTable.add(9001, TAG, ['SIGKILL']);
      const inStage2 = signalsBeforeTheDeadline(timer, host, processTable);
      shutdown.ask('SIGINT');
      shutdown.ask('SIGINT');
      await settle();
      expect(inStage2()).toEqual([{ pid: 9001, signal: 'SIGTERM' }]);
    });

    it('names what it signals', async () => {
      const { shutdown, processTable, host } = await serving(0);
      processTable.add(9001, TAG);
      shutdown.ask('SIGINT');
      shutdown.ask('SIGINT');
      await settle();
      expect(host.logs).toContain('shutdown stage 2: SIGTERM to 9001 (cmd-9001)');
    });

    it('exits as forced once nothing it started is left', async () => {
      const { shutdown, host, children } = await serving(2);
      shutdown.ask('SIGINT');
      shutdown.ask('SIGINT');
      exitAll(children);
      await settle();
      expect(host.exits).toEqual([EXITS.forced.code]);
    });

    it('keeps waiting while a Claude Code it signalled still runs', async () => {
      const { shutdown, host, children } = await serving(2);
      shutdown.ask('SIGINT');
      shutdown.ask('SIGINT');
      children[0]?.exit(null, 'SIGTERM');
      await settle();
      expect(host.exits).toEqual([]);
    });

    it('leaves exiting to the deadline while something ignores SIGTERM', async () => {
      const { shutdown, processTable, timer, host } = await serving(0);
      processTable.add(9001, TAG, ['SIGKILL']);
      expireDeadlinesInTurn(timer, host);
      shutdown.ask('SIGINT');
      shutdown.ask('SIGINT');
      await settle();
      expect(host.exits).toEqual([EXITS.instant.code]);
    });

    it('arms a deadline of 10 s by default', async () => {
      const { shutdown, host } = await serving(1);
      shutdown.ask('SIGINT');
      shutdown.ask('SIGINT');
      expect(host.deadlines.map((deadline) => deadline.ms)).toEqual([30000, 10000]);
    });

    it('arms the deadline the shutdownPolicy line set', async () => {
      const { shutdown, host } = await serving(1, [{ shutdownPolicy: { gracefulMs: 5000, teardownMs: 2000 } }]);
      shutdown.ask('SIGINT');
      shutdown.ask('SIGINT');
      expect(host.deadlines.map((deadline) => deadline.ms)).toEqual([5000, 2000]);
    });
  });

  describe('stage 3: SIGKILL and exit', () => {
    it('exits as instant at once on a third trigger', async () => {
      const { shutdown, host } = await serving(1);
      shutdown.ask('SIGINT');
      shutdown.ask('SIGINT');
      shutdown.ask('SIGINT');
      expect(host.exits).toEqual([EXITS.instant.code]);
    });

    it('still exits as instant when the process list cannot be read', async () => {
      const { shutdown, processTable, host } = await serving(0);
      processTable.add(9001, TAG, ['SIGKILL'], true);
      processTable.unreadable = true;
      shutdown.ask('SIGINT');
      shutdown.ask('SIGINT');
      shutdown.ask('SIGINT');
      expect(host.exits).toEqual([EXITS.instant.code]);
    });

    it('sends SIGKILL to every Claude Code', async () => {
      const { shutdown, processTable } = await serving(2);
      shutdown.ask('SIGINT');
      shutdown.ask('SIGINT');
      shutdown.ask('SIGINT');
      expect(processTable.signals).toEqual([
        { pid: 4001, signal: 'SIGKILL' },
        { pid: 4002, signal: 'SIGKILL' },
      ]);
    });

    it('sends SIGKILL to what a running Claude Code started', async () => {
      const { shutdown, processTable } = await serving(0);
      processTable.add(9001, TAG, ['SIGKILL'], true);
      shutdown.ask('SIGINT');
      shutdown.ask('SIGINT');
      shutdown.ask('SIGINT');
      expect(processTable.signals.filter((sent) => sent.signal === 'SIGKILL')).toEqual([{ pid: 9001, signal: 'SIGKILL' }]);
    });

    it('sends SIGKILL to what outlived its Claude Code', async () => {
      const { shutdown, processTable } = await serving(1);
      processTable.add(9002, TAG, ['SIGKILL']);
      shutdown.ask('SIGINT');
      shutdown.ask('SIGINT');
      shutdown.ask('SIGINT');
      expect(processTable.signals.filter((sent) => sent.pid === 9002)).toEqual([{ pid: 9002, signal: 'SIGKILL' }]);
    });

    it('leaves alone a process tagged for another config dir', async () => {
      const { shutdown, processTable } = await serving(0);
      processTable.add(9001, 'TOWER_PARTICIPANT=/agents/beta/config', ['SIGKILL'], true);
      shutdown.ask('SIGINT');
      shutdown.ask('SIGINT');
      shutdown.ask('SIGINT');
      expect(processTable.signals).toEqual([]);
    });

    it('names what it kills', async () => {
      const { shutdown, host } = await serving(1);
      shutdown.ask('SIGINT');
      shutdown.ask('SIGINT');
      shutdown.ask('SIGINT');
      expect(host.logs.at(-1)).toBe('shutdown stage 3 (SIGINT): SIGKILL to 4001 (cmd-4001), then exiting now');
    });

    it('still exits when a SIGKILL fails', async () => {
      const { shutdown, processTable, host } = await serving(1);
      processTable.signalFailures.set(4001, new Error('kill EPERM'));
      shutdown.ask('SIGINT');
      shutdown.ask('SIGINT');
      shutdown.ask('SIGINT');
      expect(host.exits).toEqual([EXITS.instant.code]);
    });

    it('logs a SIGKILL that failed', async () => {
      const { shutdown, processTable, host } = await serving(1);
      processTable.signalFailures.set(4001, new Error('kill EPERM'));
      shutdown.ask('SIGINT');
      shutdown.ask('SIGINT');
      shutdown.ask('SIGINT');
      expect(host.logs).toContain('shutdown: SIGKILL to 4001 failed: kill EPERM');
    });

    it('exits as instant when the stage 2 deadline passes', async () => {
      const { shutdown, host } = await serving(1);
      shutdown.driverGone('SIGHUP');
      host.deadlines[0]?.expire();
      host.deadlines[1]?.expire();
      expect(host.exits).toEqual([EXITS.instant.code]);
    });

    it('cancels the stage 2 deadline when a trigger escalates first', async () => {
      const { shutdown, host } = await serving(1);
      shutdown.ask('SIGINT');
      shutdown.ask('SIGINT');
      shutdown.ask('SIGINT');
      expect(host.deadlines[1]?.cancelled).toBe(true);
    });

    it('does not exit a second time when stage 2 finishes after it', async () => {
      const { shutdown, host, children } = await serving(1);
      shutdown.ask('SIGINT');
      shutdown.ask('SIGINT');
      shutdown.ask('SIGINT');
      exitAll(children);
      await settle();
      expect(host.exits).toEqual([EXITS.instant.code]);
    });
  });

  describe('whoever drove the participant going', () => {
    it('starts shutdown', async () => {
      const { shutdown, launches } = await serving(1);
      shutdown.driverGone('stdin closed');
      await settle();
      expect(launches[0]?.interrupts).toEqual([false]);
    });

    it('never moves shutdown on', async () => {
      const { shutdown, processes } = await serving(1);
      shutdown.driverGone('stdin closed');
      shutdown.driverGone('SIGHUP');
      expect(processes.signals).toEqual([]);
    });

    it('leaves stage 1 its deadline', async () => {
      const { shutdown, host } = await serving(1);
      shutdown.driverGone('stdin closed');
      shutdown.driverGone('SIGHUP');
      expect(host.deadlines.map((deadline) => deadline.cancelled)).toEqual([false]);
    });

    it('says it did not move shutdown on', async () => {
      const { shutdown, host } = await serving(1);
      shutdown.ask('SIGINT');
      shutdown.driverGone('SIGHUP');
      expect(host.logs).toContain("shutdown: SIGHUP during stage 1, which it doesn't move on");
    });

    it('still lets someone asking move shutdown on', async () => {
      const { shutdown, processes } = await serving(1);
      shutdown.driverGone('SIGHUP');
      shutdown.ask('SIGINT');
      expect(processes.signals).toEqual([{ pid: 4001, signal: 'SIGTERM' }]);
    });
  });

  describe('begun', () => {
    it('is not aborted before shutdown starts', async () => {
      const { shutdown } = await serving(0);
      expect(shutdown.begun.aborted).toBe(false);
    });

    it('is aborted when someone asks', async () => {
      const { shutdown } = await serving(0);
      shutdown.ask('SIGINT');
      expect(shutdown.begun.aborted).toBe(true);
    });

    it('is aborted when the driver goes', async () => {
      const { shutdown } = await serving(0);
      shutdown.driverGone('stdin closed');
      expect(shutdown.begun.aborted).toBe(true);
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
