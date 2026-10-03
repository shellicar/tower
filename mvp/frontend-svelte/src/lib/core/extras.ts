// What a message's extra fields mean to the reader: who sees it, what is shown,
// and which messages a compaction took out of the model's view. Pure, so the
// rules are tested without a component.

import type { ContentBlock, ConversationMessage } from '../types';

/** False only when the message says the person is not shown it. */
export function shownToUser(message: ConversationMessage): boolean {
  return message.audience?.user !== false;
}

/** What the person is shown for a message: `userContent` when it has it, else `content`. */
export function userBlocks(message: ConversationMessage): ContentBlock[] {
  return message.userContent ?? message.content;
}

/** The text of the text blocks, joined. */
export function blocksText(blocks: ContentBlock[]): string {
  return blocks.map((b) => (b.type === 'text' ? String(b.text ?? '') : '')).join('');
}

/**
 * The ids of messages the model is no longer sent: everything before a message
 * whose `scope` replaces what came before, except the ids it names. A message
 * the model was never sent, and a system message, is not replaced by anything.
 */
export function replacedForModel(messages: ConversationMessage[]): Set<string> {
  const replaced = new Set<string>();
  messages.forEach((message, index) => {
    if (message.scope?.replaces !== 'before') return;
    const except = new Set(message.scope.except);
    for (const earlier of messages.slice(0, index)) {
      if (earlier.audience?.model !== false && earlier.role !== 'system' && !except.has(earlier.id)) {
        replaced.add(earlier.id);
      }
    }
  });
  return replaced;
}

/** `2s`, `1m 5s`: whole seconds, the way a turn's length reads. */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** `19:01`, with the weekday in front when the moment is not on the same day as `now`. */
export function clockLabel(moment: string | number, now: number = Date.now()): string {
  const date = new Date(moment);
  if (Number.isNaN(date.getTime())) return '';
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  const sameDay = date.toDateString() === new Date(now).toDateString();
  return sameDay ? time : `${date.toLocaleDateString(undefined, { weekday: 'long' })} ${time}`;
}
