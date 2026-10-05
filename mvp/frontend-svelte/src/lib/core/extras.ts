// What a message's extra fields mean to the reader: its kind and values, who
// sees it, what is shown, how each kind is drawn, and which messages a
// compaction took out of the model's view. Every field arrives as the
// producer sent it, so each reader below checks its shape and reads a
// misshaped value as absent. Pure, so the rules are tested without a
// component. frontend-leptos/src/extras.rs is the same model in Rust.

import type { ContentBlock, ConversationMessage } from '../types';

type Fields = Record<string, unknown>;

function isRecord(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBlocks(value: unknown): value is ContentBlock[] {
  return Array.isArray(value) && value.every((b) => isRecord(b) && typeof b.type === 'string');
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The message's kind, when it carries one as a string. */
export function kindOf(message: ConversationMessage): string | undefined {
  return text(message.kind);
}

/** The message's `fields`, or none when it has no object there. */
export function fieldsOf(message: ConversationMessage): Fields {
  return isRecord(message.fields) ? message.fields : {};
}

/** `userContent`, when it is a list of blocks. */
export function userContentOf(message: ConversationMessage): ContentBlock[] | undefined {
  return isBlocks(message.userContent) ? message.userContent : undefined;
}

/** The ids `scope` keeps for the model, when it replaces what came before. */
export function scopeOf(message: ConversationMessage): { except: string[] } | undefined {
  const scope = message.scope;
  if (!isRecord(scope) || scope.replaces !== 'before') return undefined;
  const except = Array.isArray(scope.except) ? scope.except.filter((id): id is string => typeof id === 'string') : [];
  return { except };
}

/** `at`, when it is a time. */
export function atOf(message: ConversationMessage): string | undefined {
  const at = text(message.at);
  return at !== undefined && !Number.isNaN(new Date(at).getTime()) ? at : undefined;
}

function audienceSide(message: ConversationMessage, side: 'model' | 'user'): boolean {
  return !(isRecord(message.audience) && message.audience[side] === false);
}

/** False only when the message says the person is not shown it. */
export function shownToUser(message: ConversationMessage): boolean {
  return audienceSide(message, 'user');
}

/** False only when the message says the model is not sent it. */
function sentToModel(message: ConversationMessage): boolean {
  return audienceSide(message, 'model');
}

/** What the person is shown for a message: `userContent` when it has it, else `content`. */
export function userBlocks(message: ConversationMessage): ContentBlock[] {
  return userContentOf(message) ?? message.content;
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
    const scope = scopeOf(message);
    if (scope === undefined) return;
    const except = new Set(scope.except);
    for (const earlier of messages.slice(0, index)) {
      if (sentToModel(earlier) && earlier.role !== 'system' && !except.has(earlier.id)) {
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

const TOOL_CALL_NOTES: Record<string, string> = {
  incomplete: 'Tool call did not complete',
  interrupted: 'Tool call interrupted',
  'result-missing': 'Tool call result missing',
  denied: 'Tool call denied',
  skipped: 'Tool call skipped',
};

/** How a message is drawn. */
export type Row =
  /** Plain chat, or a kind this reader does not know: a message with its header. */
  | { variant: 'message'; blocks: ContentBlock[] }
  /** A message only the model is sent, shown when the reader asks to see those. */
  | { variant: 'model-only'; label: string; blocks: ContentBlock[] }
  /** One dim line. */
  | { variant: 'line'; text: string }
  /** A dot and a line; `failed` colours the dot. */
  | { variant: 'notice'; failed: boolean; text: string }
  /** A folded message: its label and detail, its blocks inside. */
  | { variant: 'folded'; tone: 'agent' | 'compaction'; label: string; detail: string; blocks: ContentBlock[] }
  /** An error from the service, with its class and status. */
  | { variant: 'error'; detail: string; blocks: ContentBlock[] };

function joined(...parts: (string | undefined)[]): string {
  return parts.filter((part) => part !== undefined && part !== '').join(' · ');
}

/** How `message` is drawn, given `fallbackLabel` for a model-only message with no kind and `now` for the clock. */
export function rowOf(message: ConversationMessage, fallbackLabel: string, now: number = Date.now()): Row {
  const kind = kindOf(message);
  const fields = fieldsOf(message);
  const blocks = userBlocks(message);
  if (!shownToUser(message)) {
    return { variant: 'model-only', label: kind ?? fallbackLabel, blocks: message.content };
  }
  const duration = number(fields.durationMs);
  switch (kind) {
    case 'turn-finished': {
      const ended = clockLabel(text(fields.endedAt) ?? atOf(message) ?? message.ts, now);
      return { variant: 'line', text: joined(duration === undefined ? blocksText(blocks) : `Worked for ${formatDuration(duration)}`, ended && `done ${ended}`) };
    }
    case 'interrupted':
      return { variant: 'line', text: joined('Interrupted', fields.during === 'tool-use' ? 'during tool use' : undefined) };
    case 'tool-call-note':
      return { variant: 'line', text: TOOL_CALL_NOTES[text(fields.reason) ?? ''] ?? blocksText(blocks) };
    case 'task-finished': {
      const summary = text(fields.summary);
      return {
        variant: 'notice',
        failed: fields.status === 'failed',
        text: summary === undefined ? blocksText(blocks) : joined(summary, duration === undefined ? undefined : formatDuration(duration)),
      };
    }
    case 'subagent-report':
      return { variant: 'folded', tone: 'agent', label: `Message from @${text(fields.agentType) ?? 'agent'}`, detail: '', blocks };
    case 'compaction':
      return { variant: 'folded', tone: 'compaction', label: 'Conversation compacted', detail: joined(text(fields.trigger), duration === undefined ? undefined : formatDuration(duration)), blocks };
    case 'api-error': {
      const status = number(fields.status);
      return { variant: 'error', detail: joined(text(fields.error), status === undefined ? undefined : String(status)), blocks };
    }
    default:
      return { variant: 'message', blocks };
  }
}
