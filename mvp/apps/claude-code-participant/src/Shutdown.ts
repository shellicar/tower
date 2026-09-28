import { dependsOn } from '@shellicar/core-di';
import type { Conversation } from './Conversation.js';
import { Conversations } from './Conversations.js';
import { IHost } from './Host.js';
import { ParticipantSettings } from './ParticipantSettings.js';
import { IProcessSpawner } from './ProcessSpawner.js';

/** The signals that start shutdown or move it on; stdin closing is the fourth trigger. */
export const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/** An error with each of its causes, so the underlying one is never dropped. */
function describeError(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  while (current !== undefined) {
    parts.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(': ');
}

/**
 * How the participant stops, in three stages. Every trigger (SIGINT, SIGTERM,
 * SIGHUP or stdin closing) moves it one stage on, and so does a stage's
 * deadline running out: a trigger that only ever arrives once (a service
 * manager's SIGTERM, a closed terminal's SIGHUP, a dead parent's stdin) must
 * not leave the process waiting forever on a Claude Code that hangs.
 *
 * 1. Graceful: interrupt every turn, close every conversation's input, and
 *    wait for everything to finish. The process then ends by itself.
 * 2. Teardown: kill every Claude Code with the commands it started, wait for
 *    them to go, and exit.
 * 3. Exit at once.
 */
export class Shutdown {
  @dependsOn(Conversations) private readonly conversations!: Conversations;
  @dependsOn(ParticipantSettings) private readonly settings!: ParticipantSettings;
  @dependsOn(IProcessSpawner) private readonly processes!: IProcessSpawner;
  @dependsOn(IHost) private readonly host!: IHost;

  private stage = 0;
  private cancelDeadline: (() => void) | undefined;

  /** One trigger, named by what it was: the first starts shutdown, each later one escalates. */
  public trigger(cause: string): void {
    this.escalate(cause);
  }

  private escalate(cause: string): void {
    this.cancelDeadline?.();
    this.cancelDeadline = undefined;
    this.stage += 1;
    if (this.stage === 1) {
      const { gracefulMs } = this.settings.shutdown;
      this.host.log(`shutdown stage 1 (${cause}): interrupting every turn and waiting up to ${gracefulMs} ms for everything to finish`);
      this.cancelDeadline = this.host.deadline(gracefulMs, () => this.escalate(`stage 1 took longer than ${gracefulMs} ms`));
      void this.graceful();
      return;
    }
    if (this.stage === 2) {
      const { teardownMs } = this.settings.shutdown;
      this.host.log(`shutdown stage 2 (${cause}): killing every Claude Code and waiting up to ${teardownMs} ms`);
      this.cancelDeadline = this.host.deadline(teardownMs, () => this.escalate(`stage 2 took longer than ${teardownMs} ms`));
      void this.teardown();
      return;
    }
    this.host.log(`shutdown stage 3 (${cause}): exiting now`);
    this.host.exit(1);
  }

  private async graceful(): Promise<void> {
    // Stdin stays open and read, so closing it still escalates, but it no
    // longer keeps the process alive: once everything below is done, the
    // process ends when nothing else runs. That includes work nobody can
    // await, such as the SDK removing a resumed conversation's temporary
    // copy after its Claude Code exits. The deadline stays armed (it holds
    // nothing open) in case something never finishes.
    this.host.letEnd();
    // A conversation launched after this point isn't stopped here: refusing
    // new work during shutdown belongs with the requests that bring it.
    await Promise.all(this.conversations.all().map((conversation) => this.stop(conversation)));
    if (this.stage !== 1) {
      return;
    }
    this.host.log('shutdown stage 1: every Claude Code has exited');
    // Publishing what's left, releasing each conversation (`detached`) and
    // draining NATS go here, once they exist.
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
      // The whole group: Claude Code and the commands it started. Claude
      // Code keeps no partial reply on SIGTERM, unlike an interrupt.
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
    this.host.exit(1);
  }
}
