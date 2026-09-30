import { dependsOn } from '@shellicar/core-di';
import { PARTICIPANT_TAG } from './ClaudeCodeSpawner.js';
import type { Conversation } from './Conversation.js';
import { Conversations } from './Conversations.js';
import { EXITS } from './ExitCodes.js';
import { IHost } from './Host.js';
import { ParticipantConfig } from './ParticipantConfig.js';
import { ParticipantSettings } from './ParticipantSettings.js';
import { IProcessSpawner } from './ProcessSpawner.js';
import { IProcessTable, type TaggedProcess } from './ProcessTable.js';
import { ITimer } from './Timer.js';

/** How often a wait for processes to go looks again. */
const POLL_MS = 50;

/** Someone asking the participant to stop: each one moves shutdown on a stage. */
export const ASKING_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/** Whoever drove the participant is gone, as stdin closing also says: shutdown starts, and never moves on for it. */
export const DRIVER_GONE_SIGNALS = ['SIGHUP'] as const;

/** An error with each of its causes, so the underlying one is never dropped. */
function identify(process: TaggedProcess): string {
  return `${process.pid}:${process.startTime}`;
}

function listed(processes: readonly TaggedProcess[]): string {
  return processes.map((process) => `${process.pid} (${process.commandLine === '' ? 'no command line' : process.commandLine})`).join(', ');
}

export function describeError(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  while (current !== undefined) {
    parts.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(': ');
}

/**
 * How the participant stops, in three stages.
 *
 * The triggers split by what they mean. SIGINT and SIGTERM are someone
 * asking: each one moves shutdown on a stage, so a quick second Ctrl-C still
 * means "exit now". SIGHUP and stdin closing (or failing) say whoever drove
 * the participant is gone: they start shutdown if it hasn't started and
 * never move it on, because one departure often arrives as several of them
 * at once (a closing terminal gives stdin's end, then SIGHUP 3 ms later).
 *
 * A stage's deadline running out also moves it on: a trigger that arrives
 * only once (a service manager's SIGTERM, a closed terminal) must not leave
 * the process waiting forever on something that hangs.
 *
 * 1. Graceful: interrupt every turn, close every conversation's input, wait
 *    for every Claude Code to exit, then send SIGTERM to whatever it started
 *    that outlived it and wait for that too. The process then ends by itself.
 * 2. Teardown: kill every Claude Code (SIGTERM to its process group), wait for
 *    them to go, and exit.
 * 3. Exit at once.
 */
export class Shutdown {
  @dependsOn(Conversations) private readonly conversations!: Conversations;
  @dependsOn(ParticipantSettings) private readonly settings!: ParticipantSettings;
  @dependsOn(IProcessSpawner) private readonly processes!: IProcessSpawner;
  @dependsOn(IHost) private readonly host!: IHost;
  @dependsOn(ParticipantConfig) private readonly config!: ParticipantConfig;
  @dependsOn(IProcessTable) private readonly processTable!: IProcessTable;
  @dependsOn(ITimer) private readonly timer!: ITimer;

  private stage = 0;
  private cancelDeadline: (() => void) | undefined;
  private readonly beginning = new AbortController();
  /** Aborted once shutdown begins, whatever began it: the leftover scan stops where it is. */
  public readonly begun: AbortSignal = this.beginning.signal;

  /** Someone asking the participant to stop (SIGINT, SIGTERM): starts shutdown, or moves it on a stage. */
  public ask(cause: string): void {
    this.escalate(cause);
  }

  /** Whoever drove the participant is gone (SIGHUP, stdin closing): starts shutdown, and never moves it on. */
  public driverGone(cause: string): void {
    if (this.stage === 0) {
      this.escalate(cause);
      return;
    }
    this.host.log(`shutdown: ${cause} during stage ${this.stage}, which it doesn't move on`);
  }

  private escalate(cause: string): void {
    this.cancelDeadline?.();
    this.cancelDeadline = undefined;
    this.stage += 1;
    if (this.stage === 1) {
      this.beginning.abort();
      const { gracefulMs } = this.settings.shutdownPolicy;
      this.host.log(`shutdown stage 1 (${cause}): interrupting every turn and waiting up to ${gracefulMs} ms for everything to finish`);
      this.cancelDeadline = this.host.deadline(gracefulMs, () => this.escalate(`stage 1 took longer than ${gracefulMs} ms`));
      void this.graceful();
      return;
    }
    if (this.stage === 2) {
      const { teardownMs } = this.settings.shutdownPolicy;
      this.host.log(`shutdown stage 2 (${cause}): killing every Claude Code and waiting up to ${teardownMs} ms`);
      this.cancelDeadline = this.host.deadline(teardownMs, () => this.escalate(`stage 2 took longer than ${teardownMs} ms`));
      void this.teardown();
      return;
    }
    this.host.log(`shutdown stage 3 (${cause}): exiting now`);
    this.host.exit(EXITS.instant.code);
  }

  private async graceful(): Promise<void> {
    // Stdin stays open and read, so control lines are still answered, but it no
    // longer keeps the process alive: once everything below is done, the
    // process ends when nothing else runs. That includes work nobody can
    // await, such as the SDK's own clean-up once a Claude Code has exited,
    // which it starts and never hands back. The deadline stays armed (it
    // holds nothing open) in case something never finishes.
    this.host.letEnd();
    // A conversation launched after this point isn't stopped here: refusing
    // new work during shutdown belongs with the requests that bring it.
    await Promise.all(this.conversations.all().map((conversation) => this.stop(conversation)));
    if (this.stage !== 1) {
      return;
    }
    this.host.log('shutdown stage 1: every Claude Code has exited');
    if (!(await this.stopWhatOutlivedThem())) {
      return;
    }
    // Publishing what's left, releasing each conversation (`detached`) and
    // draining NATS go here, once they exist.
  }

  /**
   * SIGTERM to every process still carrying this config dir's tag, then a
   * wait until none is left or the stage moves on. Only once every Claude
   * Code has exited: while one runs, it stops its own commands when
   * interrupted and records that it did, which a signal from outside would
   * bypass. What is left then is what outlived its Claude Code (a command
   * started in the background, say): Claude Code runs each command in a
   * session of its own, and once its Claude Code has gone nothing but the
   * inherited tag ties it back here.
   *
   * @returns whether nothing is left, false when the stage moved on first.
   */
  private async stopWhatOutlivedThem(): Promise<boolean> {
    const entry = `${PARTICIPANT_TAG}=${this.config.configDir}`;
    const signalled = new Set<string>();
    for (;;) {
      if (this.stage !== 1) {
        return false;
      }
      const left = this.processTable.tagged(entry);
      if (left.length === 0) {
        this.host.log(`shutdown stage 1: nothing it started is still running`);
        return true;
      }
      const unsignalled = left.filter((process) => !signalled.has(identify(process)));
      if (unsignalled.length > 0) {
        this.host.log(`shutdown stage 1: SIGTERM to what outlived its Claude Code: ${listed(unsignalled)}`);
        for (const process of unsignalled) {
          signalled.add(identify(process));
          this.processTable.signal(process, 'SIGTERM');
        }
      }
      await this.timer.sleep(POLL_MS);
    }
  }

  private async stop(conversation: Conversation): Promise<void> {
    // Every conversation is interrupted, idle or not: a turn Claude Code
    // started by itself (a background task finishing) is running too.
    // Interrupting first and closing after keeps the partial reply; with the
    // input closed first, the SDK would drop the interrupt.
    try {
      await conversation.interrupt();
    } catch (err) {
      // Expected from a Claude Code that is already stopping or gone, for
      // instance one signalled directly.
      this.host.log(`shutdown: interrupting conversation ${conversation.id} failed: ${describeError(err)}`);
    }
    conversation.close();
    await conversation.claudeCode.exited;
  }

  private async teardown(): Promise<void> {
    const signalled: Conversation[] = [];
    for (const conversation of this.conversations.all()) {
      const pid = conversation.claudeCode.runningPid;
      if (pid === undefined) {
        continue;
      }
      // Claude Code's whole process group. That doesn't hold the commands it
      // starts: Claude Code runs each Bash command in a session and group of
      // its own, and stops them itself when it gets SIGTERM. Claude Code
      // keeps no partial reply on SIGTERM, unlike an interrupt.
      // TODO: undecided: whether this stage also reaches the commands of a
      // Claude Code that doesn't act on SIGTERM (hung or stopped), which
      // otherwise keep running after the participant exits. Nothing short of
      // walking its descendants, or finding them by the TOWER_AGENT tag they
      // inherit, reaches them.
      try {
        this.processes.signalGroup(pid, 'SIGTERM');
        signalled.push(conversation);
      } catch (err) {
        this.host.log(`shutdown: signalling conversation ${conversation.id}'s Claude Code failed: ${describeError(err)}`);
      }
    }
    // Closing NATS without draining goes here, once it exists.
    await Promise.all(signalled.map((conversation) => conversation.claudeCode.exited));
    if (this.stage !== 2) {
      return;
    }
    this.host.log('shutdown stage 2: every Claude Code has exited');
    this.host.exit(EXITS.forced.code);
  }
}
