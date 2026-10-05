import type { ContentBlock, ConversationMessage } from '../types';

/** One message as the list shows it. `id` is the message id, so rows key
 *  the virtual list exactly as messages did. */
export interface MessageRow {
  id: string;
  message: ConversationMessage;
  /** The blocks to render: `userContent` when the message has it, else `content`. */
  content: ContentBlock[];
  /** True when a later scope message removed this one from the model's context. */
  dimmed: boolean;
  /** True when this message carries a scope. */
  scopeNote: boolean;
  /** True for a user-role message from an agent: shown as a one-line summary. */
  collapsed: boolean;
  /** Epoch millis shown as the message's time: `at` when it parses, else `ts`. */
  time: number;
}

function modelSaw(m: ConversationMessage): boolean {
  return m.audience?.model !== false;
}

function shownToUser(m: ConversationMessage): boolean {
  return m.audience?.user !== false;
}

/** The ids that a scope message in `messages` removed from the model's
 *  context: every earlier message the model saw, except the scope's `except`
 *  ids. */
export function scopedOutIds(messages: ConversationMessage[]): Set<string> {
  const out = new Set<string>();
  messages.forEach((m, i) => {
    if (!m.scope) return;
    const keep = new Set(m.scope.except);
    for (const earlier of messages.slice(0, i)) {
      if (modelSaw(earlier) && !keep.has(earlier.id)) out.add(earlier.id);
    }
  });
  return out;
}

export function messageTime(m: ConversationMessage): number {
  if (m.at === undefined) return m.ts;
  const parsed = Date.parse(m.at);
  return Number.isNaN(parsed) ? m.ts : parsed;
}

/** First line of the first text block; empty when there is none. */
export function firstLine(content: ContentBlock[]): string {
  for (const b of content) {
    if (b.type === 'text') {
      const line = String((b as { text?: unknown }).text ?? '').split('\n')[0];
      return line;
    }
  }
  return '';
}

/** The messages the person sees, in order: messages not meant for the user
 *  are dropped, and each remaining one carries how it is presented. */
export function visibleRows(messages: ConversationMessage[]): MessageRow[] {
  const dimmedIds = scopedOutIds(messages);
  // TODO(claude): undecided: a message the person is not shown takes no row at all, rather than a placeholder or a "model sees" toggle.
  return messages.filter(shownToUser).map((message) => ({
    id: message.id,
    message,
    // TODO(claude): undecided: a `userContent` that is not an array falls back to `content`.
    content: Array.isArray(message.userContent) ? message.userContent : message.content,
    // TODO(claude): undecided: messages a later scope removed from the model are dimmed.
    dimmed: dimmedIds.has(message.id),
    scopeNote: message.scope !== undefined,
    // TODO(claude): undecided: collapsing is keyed on role user with an agent `from`, the only generic sign of a subagent hand-back.
    collapsed: message.role === 'user' && message.from?.kind === 'agent',
    time: messageTime(message),
  }));
}
