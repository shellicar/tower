import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeCodeProcess } from './ClaudeCodeProcess.js';
import type { MessageChannel } from './MessageChannel.js';

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
   * Stops whatever turn is running, whoever started it; Claude Code keeps the
   * partial reply. Idle, there's nothing to stop.
   */
  public async interrupt(): Promise<void> {
    await this.messages.interrupt();
  }

  /** Ends the input; Claude Code exits once it has finished what it's doing. */
  public close(): void {
    this.input.close();
  }
}
