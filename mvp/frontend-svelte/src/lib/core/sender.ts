import type { ConversationMessage } from '../types';

/**
 * How a message's header presents its author. A message with a `from` is
 * labelled by its `userId`, else its `kind`. A message with no `from` is
 * labelled by what it is: "tool" when it carries a tool result, "system"
 * when its role is `system`, and "unknown" otherwise. The label belongs to
 * the message, not to its blocks: one tool result anywhere in it makes the
 * whole message "tool".
 */
export function senderLabel(message: ConversationMessage): string {
  if (message.from) {
    return message.from.userId ?? message.from.kind;
  }
  if (message.content.some((b) => b.type === 'tool_result')) {
    return 'tool';
  }
  return message.role === 'system' ? 'system' : 'unknown';
}
