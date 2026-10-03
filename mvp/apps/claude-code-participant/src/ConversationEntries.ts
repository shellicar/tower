// Which of the entries Claude Code writes to its record are messages on tower,
// and what each one is published as: the prompts, every piece of each reply,
// the tool results, Claude Code's system entries, and the extras around them
// (reminders, task-finished notices, subagent hand-backs, interrupt markers,
// the compaction summary, the turn-finished line, synthetic replies). An extra
// says who sees it: `audience` names the model and the person separately.
// Bookkeeping, subagent entries and attachments without a rendered form stay
// in Claude Code's own record.

/** One line of Claude Code's record, as the session store and the transcript file both hold it. */
export type RecordEntry = { type: string; uuid?: string; [field: string]: unknown };

export type Role = 'user' | 'assistant' | 'system';

/** Whether the model is sent a message, and whether the person is shown it. */
type Audience = { model: boolean; user: boolean };

/** A message that replaces, for the model, every message before it except those listed. */
type Scope = { replaces: 'before'; except: string[] };

/** What a message carries beyond a plain chat message. */
type Extras = {
  audience: Audience;
  /** The entry's own time. */
  at?: string;
  /** What the person is shown in place of `content`. */
  userContent?: unknown[];
  scope?: Scope;
};

/** What an entry is published as. */
export type Classified = {
  role: Role;
  /** Overrides the say's `from`; absent leaves the message to take it. */
  from?: unknown;
  /** Overrides the entry's own content blocks. */
  content?: unknown[];
  extras?: Extras;
};

/** What classifying an entry reads from outside the entry. */
export type ClassifyContext = {
  now: Date;
  /** An IANA zone; undefined is the machine's own. */
  timeZone?: string;
  /** The uuids a compaction boundary keeps, by the boundary's own uuid. */
  preservedBy(boundaryUuid: string): readonly string[] | undefined;
};

// The texts Claude Code writes as a user entry to mark an interruption, a
// refusal, or a tool call that never finished, read from Claude Code 2.1.283
// (the list its own check for them uses).
const INTERRUPTS: readonly string[] = ['[Request interrupted by user]', '[Request interrupted by user for tool use]'];

const MARKERS: readonly string[] = [
  ...INTERRUPTS,
  '[Tool call did not complete: the turn was ended to deliver the message that follows. Nothing refused it; re-run it if still needed.]',
  "[Tool call interrupted: the session ended before this call's result was recorded, so its outcome is unknown. Check whether it took effect before relying on it or running it again.]",
  "[Tool call result not in this copy: this session was copied from another session before that session recorded this call's result. The call may have finished there, may still be running there, or may never have run. Check whether it took effect before relying on it or running it again.]",
  "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.",
  '[Tool call skipped: the turn was stopped before this call ran, by the check whose denial is on another call in this batch. Nothing refused this call and it had no effects; re-run it if still needed.]',
  '[Tool call skipped: the turn ended to deliver the message that follows before this call ran. Nothing refused it; re-run it if still needed.]',
];

const NO_RESPONSE = 'No response requested.';
const INTERRUPTED_TEXT = 'Interrupted · What should Claude do instead?';

const BOTH: Audience = { model: true, user: true };
const MODEL_ONLY: Audience = { model: true, user: false };
const USER_ONLY: Audience = { model: false, user: true };

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageContent(entry: RecordEntry): unknown {
  return isObject(entry.message) ? entry.message.content : undefined;
}

function textOf(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content) && content.length > 0 && content.every((block) => isObject(block) && block.type === 'text' && typeof block.text === 'string')) {
    return content.map((block) => (block as { text: string }).text).join('');
  }
  return undefined;
}

function startsWithAny(text: string | undefined, texts: readonly string[]): boolean {
  return text !== undefined && texts.some((candidate) => text.startsWith(candidate));
}

function isMarker(content: unknown): boolean {
  return startsWithAny(textOf(content), MARKERS);
}

function isToolResult(entry: RecordEntry): boolean {
  const content = messageContent(entry);
  return Array.isArray(content) && content.some((block) => isObject(block) && block.type === 'tool_result');
}

function originKind(entry: RecordEntry): unknown {
  return isObject(entry.origin) ? entry.origin.kind : undefined;
}

/** Part of the main conversation, not a subagent's. */
export function isMainChain(entry: RecordEntry): boolean {
  return entry.isSidechain !== true;
}

/** A user entry that is something said: not a tool result, a notice, a hand-back, a compaction summary or a marker. */
export function isPrompt(entry: RecordEntry): boolean {
  if (entry.type !== 'user' || entry.isMeta === true || entry.isCompactSummary === true || isToolResult(entry)) {
    return false;
  }
  const origin = originKind(entry);
  return origin !== 'task-notification' && origin !== 'peer' && !isMarker(messageContent(entry));
}

/** The uuids a `compact_boundary` entry says the compaction kept. */
export function preservedUuidsOf(entry: RecordEntry): string[] {
  const { compactMetadata } = entry;
  const kept = isObject(compactMetadata) && isObject(compactMetadata.preservedMessages) ? compactMetadata.preservedMessages.uuids : undefined;
  return Array.isArray(kept) ? kept.filter((uuid): uuid is string => typeof uuid === 'string') : [];
}

function textBlock(text: string): unknown[] {
  return [{ type: 'text', text }];
}

/** `1m 5s` for 65000. */
function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** `Worked for 2s · done 14:22`, with the weekday in front of the time when it isn't today. */
function formatTurnFinished(entry: RecordEntry, context: ClassifyContext): string {
  const { timeZone, now } = context;
  const parsed = typeof entry.timestamp === 'string' ? new Date(entry.timestamp) : now;
  const ended = Number.isNaN(parsed.getTime()) ? now : parsed;
  const time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(ended);
  const day = (date: Date) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(date);
  const when = day(ended) === day(now) ? time : `${new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long' }).format(ended)} ${time}`;
  const took = typeof entry.durationMs === 'number' ? ` for ${formatDuration(entry.durationMs)}` : '';
  return `Worked${took} · done ${when}`;
}

/** A task-finished notice's summary line with its duration, from the notice's XML text. */
function noticeText(content: unknown): string | undefined {
  const text = textOf(content);
  const summary = text?.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim();
  if (summary === undefined || summary === '') {
    return undefined;
  }
  const duration = text?.match(/<duration_ms>\s*(\d+)\s*<\/duration_ms>/)?.[1];
  return duration === undefined ? summary : `${summary} · ${formatDuration(Number(duration))}`;
}

function extrasOf(entry: RecordEntry, audience: Audience, more: Omit<Extras, 'audience' | 'at'> = {}): Extras {
  return { audience, ...(typeof entry.timestamp === 'string' ? { at: entry.timestamp } : {}), ...more };
}

function renderedBlocks(entry: RecordEntry): unknown[] | undefined {
  if (!Array.isArray(entry.rendered)) {
    return undefined;
  }
  const blocks = entry.rendered.flatMap((item) => {
    const content = isObject(item) ? item.content : undefined;
    if (typeof content === 'string') {
      return textBlock(content);
    }
    return Array.isArray(content) ? content : [];
  });
  return blocks.length === 0 ? undefined : blocks;
}

function classifyAssistant(entry: RecordEntry): Classified {
  if (entry.isApiErrorMessage === true) {
    return { role: 'system', extras: extrasOf(entry, USER_ONLY) };
  }
  const synthetic = isObject(entry.message) && entry.message.model === '<synthetic>';
  if (synthetic && textOf(messageContent(entry))?.trim() === NO_RESPONSE) {
    return { role: 'assistant', extras: extrasOf(entry, MODEL_ONLY) };
  }
  return { role: 'assistant' };
}

function classifySystem(entry: RecordEntry, context: ClassifyContext): Classified {
  if (entry.subtype === 'turn_duration') {
    return { role: 'system', content: textBlock(formatTurnFinished(entry, context)), extras: extrasOf(entry, USER_ONLY) };
  }
  if (entry.subtype === 'compact_boundary') {
    return { role: 'system', extras: extrasOf(entry, USER_ONLY) };
  }
  return { role: 'system' };
}

function classifyUser(entry: RecordEntry, context: ClassifyContext): Classified | undefined {
  const content = messageContent(entry);
  if (isToolResult(entry)) {
    return { role: 'user' };
  }
  if (entry.isCompactSummary === true) {
    const boundary = typeof entry.parentUuid === 'string' ? entry.parentUuid : undefined;
    const except = [...((boundary === undefined ? undefined : context.preservedBy(boundary)) ?? [])];
    return { role: 'user', extras: extrasOf(entry, BOTH, { scope: { replaces: 'before', except } }) };
  }
  const origin = originKind(entry);
  if (origin === 'task-notification') {
    const userText = noticeText(content);
    return { role: 'user', from: { kind: 'orchestrator' }, extras: extrasOf(entry, BOTH, userText === undefined ? {} : { userContent: textBlock(userText) }) };
  }
  if (origin === 'peer') {
    return { role: 'user', from: { kind: 'agent' }, extras: extrasOf(entry, BOTH) };
  }
  if (entry.isMeta === true) {
    return undefined;
  }
  if (isMarker(content)) {
    return { role: 'user', extras: startsWithAny(textOf(content), INTERRUPTS) ? extrasOf(entry, BOTH, { userContent: textBlock(INTERRUPTED_TEXT) }) : extrasOf(entry, MODEL_ONLY) };
  }
  return { role: 'user' };
}

/** What a published entry is published as, or undefined for an entry tower never gets. */
export function classify(entry: RecordEntry, context: ClassifyContext): Classified | undefined {
  if (typeof entry.uuid !== 'string' || !isMainChain(entry)) {
    return undefined;
  }
  switch (entry.type) {
    case 'assistant':
      return classifyAssistant(entry);
    case 'system':
      return classifySystem(entry, context);
    case 'user':
      return classifyUser(entry, context);
    case 'attachment': {
      const content = renderedBlocks(entry);
      if (content === undefined) {
        return undefined;
      }
      const role = entry.renderedRole === 'user' || entry.renderedRole === 'assistant' ? entry.renderedRole : 'system';
      return { role, content, extras: extrasOf(entry, MODEL_ONLY) };
    }
    default:
      return undefined;
  }
}

const NO_CONTEXT: ClassifyContext = { now: new Date(0), preservedBy: () => undefined };

/** The role a published entry has on tower, or undefined for an entry tower never gets. */
export function roleOf(entry: RecordEntry): Role | undefined {
  return classify(entry, NO_CONTEXT)?.role;
}

/** The id of the API response an assistant piece belongs to, which every piece of that response shares. */
export function responseIdOf(entry: RecordEntry): string | undefined {
  return isObject(entry.message) && typeof entry.message.id === 'string' ? entry.message.id : entry.uuid;
}

export function contentBlocksOf(entry: RecordEntry): unknown[] {
  const content = entry.type === 'system' ? entry.content : messageContent(entry);
  if (typeof content === 'string') {
    return textBlock(content);
  }
  return Array.isArray(content) ? content : [];
}
