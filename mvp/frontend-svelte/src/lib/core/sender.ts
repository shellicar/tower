import type { ConversationMessage } from '../types';

/**
 * How a message's header presents who it is from: the `from`'s `userId`,
 * else its `kind`. A message with no `from` is labelled by what it is:
 * "tool" when it carries a tool result, "system" for any other user-role
 * message (something the harness generated), and its role otherwise, so a
 * reply reads "assistant" and a system message "system". The label belongs
 * to the message, not to its blocks: one tool result anywhere in it makes
 * the whole message "tool".
 */
export function senderLabel(message: ConversationMessage): string {
  if (message.from) {
    return message.from.userId ?? message.from.kind;
  }
  if (message.content.some((b) => b.type === 'tool_result')) {
    return 'tool';
  }
  // TODO: undecided how a role outside user, assistant and system is labelled; it shows the role as it arrives.
  return message.role === 'user' ? 'system' : message.role;
}
