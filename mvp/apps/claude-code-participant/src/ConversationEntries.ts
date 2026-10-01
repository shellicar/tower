// Which of the entries Claude Code writes to its record are the
// conversation's messages on tower: the prompts, every piece of each reply,
// the tool results, and Claude Code's system entries. Reminders, compaction
// summaries, attachments, interrupt markers, bookkeeping and subagent entries
// stay in Claude Code's own record.

/** One line of Claude Code's record, as the session store and the transcript file both hold it. */
export type RecordEntry = { type: string; uuid?: string; [field: string]: unknown };

export type Role = 'user' | 'assistant' | 'system';

// The texts Claude Code writes as a user entry to mark an interruption, a
// refusal, or a tool call that never finished, read from Claude Code 2.1.283
// (the list its own check for them uses).
const MARKERS: readonly string[] = [
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]',
  '[Tool call did not complete: the turn was ended to deliver the message that follows. Nothing refused it; re-run it if still needed.]',
  "[Tool call interrupted: the session ended before this call's result was recorded, so its outcome is unknown. Check whether it took effect before relying on it or running it again.]",
  "[Tool call result not in this copy: this session was copied from another session before that session recorded this call's result. The call may have finished there, may still be running there, or may never have run. Check whether it took effect before relying on it or running it again.]",
  "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.",
  '[Tool call skipped: the turn was stopped before this call ran, by the check whose denial is on another call in this batch. Nothing refused this call and it had no effects; re-run it if still needed.]',
  '[Tool call skipped: the turn ended to deliver the message that follows before this call ran. Nothing refused it; re-run it if still needed.]',
];

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageContent(entry: RecordEntry): unknown {
  return isObject(entry.message) ? entry.message.content : undefined;
}

function isMarkerText(text: unknown): boolean {
  return typeof text === 'string' && MARKERS.some((marker) => text.startsWith(marker));
}

function isMarker(content: unknown): boolean {
  if (typeof content === 'string') {
    return isMarkerText(content);
  }
  return Array.isArray(content) && content.length > 0 && content.every((block) => isObject(block) && block.type === 'text' && isMarkerText(block.text));
}

function isToolResult(entry: RecordEntry): boolean {
  const content = messageContent(entry);
  return Array.isArray(content) && content.some((block) => isObject(block) && block.type === 'tool_result');
}

/** Part of the main conversation, not a subagent's. */
export function isMainChain(entry: RecordEntry): boolean {
  return entry.isSidechain !== true;
}

/** A user entry that is something said: not a tool result, a reminder, a compaction summary or a marker. */
export function isPrompt(entry: RecordEntry): boolean {
  if (entry.type !== 'user' || entry.isMeta === true || entry.isCompactSummary === true || isToolResult(entry)) {
    return false;
  }
  return !isMarker(messageContent(entry));
}

/** The role a published entry has on tower, or undefined for an entry tower never gets. */
export function roleOf(entry: RecordEntry): Role | undefined {
  if (typeof entry.uuid !== 'string' || !isMainChain(entry)) {
    return undefined;
  }
  switch (entry.type) {
    case 'assistant':
      return 'assistant';
    case 'system':
      return 'system';
    case 'user':
      return isPrompt(entry) || isToolResult(entry) ? 'user' : undefined;
    default:
      return undefined;
  }
}

/** The id of the API response an assistant piece belongs to, which every piece of that response shares. */
export function responseIdOf(entry: RecordEntry): string | undefined {
  return isObject(entry.message) && typeof entry.message.id === 'string' ? entry.message.id : entry.uuid;
}

export function contentBlocksOf(entry: RecordEntry): unknown[] {
  const content = entry.type === 'system' ? entry.content : messageContent(entry);
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  return Array.isArray(content) ? content : [];
}
