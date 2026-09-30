import type { Conversation } from './Conversation.js';

/** The conversations being served: each one from its launch until its Claude Code exits. */
export class Conversations {
  private readonly live = new Set<Conversation>();

  public add(conversation: Conversation): void {
    this.live.add(conversation);
    void conversation.claudeCode.exited.then(() => this.live.delete(conversation));
  }

  public all(): Conversation[] {
    return [...this.live];
  }
}
