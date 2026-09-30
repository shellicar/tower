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
export function describeError(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  while (current !== undefined) {
    parts.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(': ');
}

function identify(process: TaggedProcess): string {
  return `${process.pid}:${process.startTime}`;
}

function listed(processes: readonly TaggedProcess[]): string {
  return processes.map((process) => `${process.pid} (${process.commandLine === '' ? 'no command line' : process.commandLine})`).join(', ');
}

/**
 * How the participant stops, in three stages that mirror SIGINT, SIGTERM and
 * SIGKILL: two graceful, then hard.
 *
 * 1. Interrupt every turn and close every conversation's input; each Claude
 *    Code stops its own commands, records that it did, and exits. Then
 *    SIGTERM to whatever still carries this config dir's tag, and a wait for
 *    it to go. The process then ends by itself.
 * 2. SIGTERM to every Claude Code, which still records a command it was
 *    running (as "Exit code 137"), and a wait for them to exit. Then SIGTERM
 *    to whatever tagged is left, a wait for it to go, and exit.
 * 3. SIGKILL to every tagged process, Claude Codes and commands alike, and
 *    exit at once: a process that has had SIGKILL runs none of its own code
 *    again, so there is nothing to wait for.
 *
 * While a Claude Code runs, its commands are left to it: it stops them
 * itself and records it, which a signal from outside would bypass. Once it
 * has gone, only the tag it handed them ties them back here: Claude Code
 * runs each command in a session of its own.
 *
 * The triggers split by what they mean. SIGINT and SIGTERM are someone
 * asking: each one moves shutdown on a stage, however quickly they come.
 * SIGHUP and stdin closing (or failing) say whoever drove the participant is
 * gone: they start shutdown if it hasn't started and never move it on,
 * because one departure often arrives as several of them at once (a closing
 * terminal gives stdin's end, then SIGHUP 3 ms later).
 *
 * A stage's deadline running out also moves it on: a trigger that arrives
 * only once (a service manager's SIGTERM, a closed terminal) must not leave
 * the process waiting forever on something that hangs.
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

  private get tag(): string {
    return `${PARTICIPANT_TAG}=${this.config.configDir}`;
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
      this.host.log(`shutdown stage 2 (${cause}): SIGTERM to every Claude Code, then to whatever is left, waiting up to ${teardownMs} ms`);
      this.cancelDeadline = this.host.deadline(teardownMs, () => this.escalate(`stage 2 took longer than ${teardownMs} ms`));
      void this.teardown();
      return;
    }
    this.hardExit(cause);
  }

  private async graceful(): Promise<void> {
    // Stdin stays open and read, so control lines are still answered, but it
    // no longer keeps the process alive: once everything below is done, the
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
    // Every Claude Code has gone, so nothing tagged still descends from this
    // process: what is left outlived its Claude Code.
    if (!(await this.endTagged(1, { withOwnDescendants: false }))) {
      return;
    }
    // Publishing what's left, releasing each conversation (`detached`) and
    // draining NATS belong here.
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
      // Claude Code's whole process group. Its commands run in sessions of
      // their own, so this reaches Claude Code and not them. Claude Code
      // keeps no partial reply on SIGTERM, unlike an interrupt.
      try {
        this.processes.signalGroup(pid, 'SIGTERM');
        signalled.push(conversation);
      } catch (err) {
        this.host.log(`shutdown: signalling conversation ${conversation.id}'s Claude Code failed: ${describeError(err)}`);
      }
    }
    // Closing NATS without draining belongs here.
    await Promise.all(signalled.map((conversation) => conversation.claudeCode.exited));
    if (this.stage !== 2) {
      return;
    }
    this.host.log('shutdown stage 2: every Claude Code it signalled has exited');
    // This process's own descendants are included: a Claude Code that
    // couldn't be signalled above is still one, and gets SIGTERM here.
    if (!(await this.endTagged(2, { withOwnDescendants: true }))) {
      return;
    }
    this.host.exit(EXITS.forced.code);
  }

  /**
   * SIGTERM to every process carrying this config dir's tag, each once, and a
   * wait until none is left. One that appears meanwhile is signalled too.
   *
   * @returns whether none is left, false when the stage moved on first.
   */
  private async endTagged(stage: number, options: { withOwnDescendants: boolean }): Promise<boolean> {
    const signalled = new Set<string>();
    for (;;) {
      if (this.stage !== stage) {
        return false;
      }
      const left = this.processTable.tagged(this.tag, options);
      if (left.length === 0) {
        this.host.log(`shutdown stage ${stage}: nothing it started is still running`);
        return true;
      }
      const unsignalled = left.filter((process) => !signalled.has(identify(process)));
      if (unsignalled.length > 0) {
        this.host.log(`shutdown stage ${stage}: SIGTERM to ${listed(unsignalled)}`);
        for (const process of unsignalled) {
          signalled.add(identify(process));
          this.send(process, 'SIGTERM');
        }
      }
      await this.timer.sleep(POLL_MS);
    }
  }

  private hardExit(cause: string): void {
    const left = this.processTable.tagged(this.tag, { withOwnDescendants: true });
    this.host.log(`shutdown stage 3 (${cause}): ${left.length > 0 ? `SIGKILL to ${listed(left)}, then exiting now` : 'exiting now'}`);
    for (const process of left) {
      this.send(process, 'SIGKILL');
    }
    this.host.exit(EXITS.instant.code);
  }

  /** A signal that fails is reported and never stops shutdown. */
  private send(process: TaggedProcess, signal: NodeJS.Signals): void {
    try {
      this.processTable.signal(process, signal);
    } catch (err) {
      this.host.log(`shutdown: ${signal} to ${process.pid} failed: ${describeError(err)}`);
    }
  }
}
