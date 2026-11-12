import type { Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeCodeProcess } from './ClaudeCodeProcess.js';
import type { MessageChannel } from './MessageChannel.js';

/** Subagents and workflows: the tasks an interrupt leaves running, which shutdown stops one by one. Shells are left to Claude Code. */
const STOPPED_TASK_TYPES: ReadonlySet<string> = new Set(['local_agent', 'local_workflow']);

/** A task's statuses once it has ended. */
const ENDED_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'killed']);

/** The context line's text, as its own block on the opening user message, as bridge does it. */
export function contextBlock(context: string): string {
  return `<system-reminder>\n${context}\n</system-reminder>\n\n`;
}

/**
 * One served conversation: a single long-lived Claude Code, fed a stream of
 * user messages, so it keeps running (background tasks included) between
 * them.
 */
export class Conversation {
  public readonly id: string;
  /** What Claude Code sends back, for as long as it runs. */
  public readonly messages: Query;
  /** The Claude Code serving it. */
  public readonly claudeCode: ClaudeCodeProcess;
  private readonly input: MessageChannel<SDKUserMessage>;
  /** Set only for a new conversation, and spent on its first message. */
  private pendingContext: string | undefined;
  /** Task ids of the subagents and workflows running now. */
  private readonly tasks = new Set<string>();

  public constructor(id: string, input: MessageChannel<SDKUserMessage>, messages: Query, claudeCode: ClaudeCodeProcess, context: string | undefined) {
    this.id = id;
    this.input = input;
    this.messages = messages;
    this.claudeCode = claudeCode;
    this.pendingContext = context;
  }

  public send(text: string): void {
    const content: { type: 'text'; text: string }[] = [];
    if (this.pendingContext !== undefined) {
      content.push({ type: 'text', text: contextBlock(this.pendingContext) });
    }
    content.push({ type: 'text', text });
    this.input.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null });
    this.pendingContext = undefined;
  }

  /**
   * Stops whatever turn is running, whoever started it, and its foreground
   * subagents; Claude Code keeps the partial reply. Background tasks keep
   * running. Idle, there's nothing to stop.
   */
  public async interrupt(): Promise<void> {
    await this.messages.interrupt();
  }

  /**
   * Notes the subagents and workflows Claude Code reports starting and
   * ending, at any depth, foreground or background, so they can be stopped.
   */
  public observe(message: SDKMessage): void {
    if (message.type !== 'system') {
      return;
    }
    if (message.subtype === 'task_started' && message.task_type !== undefined && STOPPED_TASK_TYPES.has(message.task_type)) {
      this.tasks.add(message.task_id);
      return;
    }
    if (message.subtype === 'task_notification') {
      this.tasks.delete(message.task_id);
      return;
    }
    if (message.subtype === 'task_updated' && message.patch.status !== undefined && ENDED_STATUSES.has(message.patch.status)) {
      this.tasks.delete(message.task_id);
    }
  }

  /** The subagents and workflows Claude Code has started and not yet reported ending. */
  public get runningTasks(): string[] {
    return [...this.tasks];
  }

  /** Stops one task. Must come before `close`: the stop travels on Claude Code's input. */
  public async stopTask(taskId: string): Promise<void> {
    await this.messages.stopTask(taskId);
  }

  /** Ends the input; Claude Code exits once it has finished what it's doing. */
  public close(): void {
    this.input.close();
  }
}
