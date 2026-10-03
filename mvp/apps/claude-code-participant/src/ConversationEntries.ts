// Helpers over the entries Claude Code writes to its record: what an entry's
// content is, and which user entries are prompts, tool results or markers.
// ConversationKinds.ts decides which entries are published, and as what.

/** One line of Claude Code's record, as the session store and the transcript file both hold it. */
export type RecordEntry = { type: string; uuid?: string; [field: string]: unknown };

/** What a marker text says happened, in the kind and fields it is published with. */
export type Marker = { kind: string; fields: Record<string, unknown>; userText: string };

// The texts Claude Code writes as a user entry to mark an interruption, a
// refusal, or a tool call that never finished, read from Claude Code 2.1.283
// (the list its own check for them uses).
const MARKERS: readonly { text: string; marker: Marker }[] = [
  { text: '[Request interrupted by user]', marker: { kind: 'interrupted', fields: { during: 'turn' }, userText: 'Interrupted' } },
  { text: '[Request interrupted by user for tool use]', marker: { kind: 'interrupted', fields: { during: 'tool-use' }, userText: 'Interrupted' } },
  {
    text: '[Tool call did not complete: the turn was ended to deliver the message that follows. Nothing refused it; re-run it if still needed.]',
    marker: { kind: 'tool-call-note', fields: { reason: 'incomplete' }, userText: 'Tool call did not complete' },
  },
  {
    text: "[Tool call interrupted: the session ended before this call's result was recorded, so its outcome is unknown. Check whether it took effect before relying on it or running it again.]",
    marker: { kind: 'tool-call-note', fields: { reason: 'interrupted' }, userText: 'Tool call interrupted' },
  },
  {
    text: "[Tool call result not in this copy: this session was copied from another session before that session recorded this call's result. The call may have finished there, may still be running there, or may never have run. Check whether it took effect before relying on it or running it again.]",
    marker: { kind: 'tool-call-note', fields: { reason: 'result-missing' }, userText: 'Tool call result missing' },
  },
  {
    text: "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.",
    marker: { kind: 'tool-call-note', fields: { reason: 'denied' }, userText: 'Tool call denied' },
  },
  {
    text: '[Tool call skipped: the turn was stopped before this call ran, by the check whose denial is on another call in this batch. Nothing refused this call and it had no effects; re-run it if still needed.]',
    marker: { kind: 'tool-call-note', fields: { reason: 'skipped' }, userText: 'Tool call skipped' },
  },
  {
    text: '[Tool call skipped: the turn ended to deliver the message that follows before this call ran. Nothing refused it; re-run it if still needed.]',
    marker: { kind: 'tool-call-note', fields: { reason: 'skipped' }, userText: 'Tool call skipped' },
  },
];

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function messageContent(entry: RecordEntry): unknown {
  return isObject(entry.message) ? entry.message.content : undefined;
}

function markerOfText(text: unknown): Marker | undefined {
  return typeof text === 'string' ? MARKERS.find((candidate) => text.startsWith(candidate.text))?.marker : undefined;
}

/** The marker a user entry's content is, when all of it is one. */
export function markerOf(content: unknown): Marker | undefined {
  if (typeof content === 'string') {
    return markerOfText(content);
  }
  if (!Array.isArray(content) || content.length === 0) {
    return undefined;
  }
  const markers = content.map((block) => (isObject(block) && block.type === 'text' ? markerOfText(block.text) : undefined));
  return markers.every((marker) => marker !== undefined) ? markers[0] : undefined;
}

export function isToolResult(entry: RecordEntry): boolean {
  const content = messageContent(entry);
  return Array.isArray(content) && content.some((block) => isObject(block) && block.type === 'tool_result');
}

/** Part of the main conversation, not a subagent's. */
export function isMainChain(entry: RecordEntry): boolean {
  return entry.isSidechain !== true;
}

/** The kind of sender Claude Code recorded on a user entry (`origin.kind`), when it recorded one. */
export function originKind(entry: RecordEntry): string | undefined {
  return isObject(entry.origin) && typeof entry.origin.kind === 'string' ? entry.origin.kind : undefined;
}

/** A user entry that is something said: not a tool result, a reminder, a compaction summary, a marker or a message another session or a task sent. */
export function isPrompt(entry: RecordEntry): boolean {
  if (entry.type !== 'user' || entry.isMeta === true || entry.isCompactSummary === true || isToolResult(entry)) {
    return false;
  }
  const origin = originKind(entry);
  return origin !== 'task-notification' && origin !== 'peer' && markerOf(messageContent(entry)) === undefined;
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
