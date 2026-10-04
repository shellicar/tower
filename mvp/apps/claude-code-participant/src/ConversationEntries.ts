// Which of the entries Claude Code writes to its record are published as the
// conversation's messages on tower: the prompts, every piece of each reply,
// the tool results, background agents' reports and Claude Code's system
// entries. Reminders, compaction summaries, attachments and interrupt markers
// are not published yet, although the model sees them; what the model sees is
// to be published (the Goal in docs/design/claude-code-participant.md).
// Bookkeeping entries and subagent entries are not published.

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

/**
 * A background agent's report, handed back to the session that started it:
 * Claude Code writes it as a meta user entry with
 * `origin: { kind: "peer", handback: true, ... }`, its content framing the
 * agent's result as the model received it.
 */
function isHandback(entry: RecordEntry): boolean {
  return entry.type === 'user' && isObject(entry.origin) && entry.origin.kind === 'peer' && entry.origin.handback === true;
}

/** The role a published entry has on tower, or undefined for an entry that isn't published. */
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
      return isPrompt(entry) || isToolResult(entry) || isHandback(entry) ? 'user' : undefined;
    default:
      return undefined;
  }
}

/**
 * What a published entry is, which decides who wrote it. Claude Code stamps
 * user text it writes itself with an `origin` (Claude Code 2.1.285); text that
 * came in through the SDK carries none.
 * - `prompt`: something said through a say (no origin, or a `human` one);
 * - `reply`: a piece of Claude's reply, written by the model;
 * - `toolResult`: a tool's result;
 * - `claudeCodeText`: an assistant entry Claude Code wrote itself, such as an API error;
 * - `backgroundTask`: the notice that a background task (a command or an agent) has ended;
 * - `backgroundAgentReport`: a background agent's report, handed back (a meta entry, published all the same);
 * - `scheduledTrigger`, `peerSendMessage`, `projectsRelay`, `sessionInbox`:
 *   a task notification with that `subkind`;
 * - `goalCheckin`, `workerCheckin`, `artifactEvent`: a task notification
 *   with that `source`;
 * - `peer`, `channel`, `coordinator`, `plugin`, `autoContinuation`,
 *   `observer`, `observerActivity`, `slackPing`, `unclassified`: user text
 *   with that origin kind;
 * - `unknownOrigin`: user text with an origin none of the above recognise;
 * - `system`: one of Claude Code's system entries.
 */
export type MessageKind =
  | 'prompt'
  | 'reply'
  | 'toolResult'
  | 'claudeCodeText'
  | 'backgroundTask'
  | 'backgroundAgentReport'
  | 'scheduledTrigger'
  | 'peerSendMessage'
  | 'projectsRelay'
  | 'sessionInbox'
  | 'goalCheckin'
  | 'workerCheckin'
  | 'artifactEvent'
  | 'peer'
  | 'channel'
  | 'coordinator'
  | 'plugin'
  | 'autoContinuation'
  | 'observer'
  | 'observerActivity'
  | 'slackPing'
  | 'unclassified'
  | 'unknownOrigin'
  | 'system';

/**
 * An assistant entry Claude Code wrote itself rather than the model, such as
 * an API error or "No response requested.": its model is "<synthetic>".
 */
function isSynthetic(entry: RecordEntry): boolean {
  return entry.type === 'assistant' && isObject(entry.message) && entry.message.model === '<synthetic>';
}

/**
 * Which task notification an origin of kind `task-notification` is: by its
 * `subkind`, else its `source`, else its `producer`. A background task's
 * notice has producer "session-task" and neither of the others.
 */
function taskNotificationKind(origin: Record<string, unknown>): MessageKind {
  switch (origin.subkind) {
    case 'scheduled-trigger':
      return 'scheduledTrigger';
    case 'peer-send-message':
      return 'peerSendMessage';
    case 'projects-relay':
      return 'projectsRelay';
    case 'session-inbox':
      return 'sessionInbox';
    default:
      break;
  }
  switch (origin.source) {
    case 'goal-checkin':
      return 'goalCheckin';
    case 'worker-checkin':
      return 'workerCheckin';
    default:
      break;
  }
  if (typeof origin.source === 'string' && origin.source.startsWith('artifact-')) {
    // TODO(claude): undecided: whether each artifact source (artifact-changed, artifact-auto-react, artifact-watch-lifecycle, artifact-auto-react-stop-disclosure and any other) is a case of its own. One case for every source starting "artifact-" for now.
    return 'artifactEvent';
  }
  if (origin.producer === 'session-task') {
    return 'backgroundTask';
  }
  // TODO(claude): undecided: what a task notification with no recognised subkind, source or producer is (Claude Code writes a bare { kind: "task-notification" } for some deliveries, such as webhooks). The catch-all for now.
  return 'unknownOrigin';
}

/** The kind of a prompt-shaped user entry, from the `origin` Claude Code stamps on it. */
function promptKind(entry: RecordEntry): MessageKind {
  if (entry.origin === undefined) {
    return 'prompt';
  }
  if (!isObject(entry.origin)) {
    return 'unknownOrigin';
  }
  switch (entry.origin.kind) {
    case 'human':
      return 'prompt';
    case 'task-notification':
      return taskNotificationKind(entry.origin);
    case 'peer':
      return 'peer';
    case 'channel':
      return 'channel';
    case 'coordinator':
      return 'coordinator';
    case 'plugin':
      return 'plugin';
    case 'auto-continuation':
      return 'autoContinuation';
    case 'observer':
      return 'observer';
    case 'observer-activity':
      return 'observerActivity';
    case 'slack-ping':
      return 'slackPing';
    case 'unclassified':
      return 'unclassified';
    default:
      return 'unknownOrigin';
  }
}

/** The kind of a published entry, or undefined for an entry that isn't published. */
export function kindOf(entry: RecordEntry): MessageKind | undefined {
  switch (roleOf(entry)) {
    case 'assistant':
      return isSynthetic(entry) ? 'claudeCodeText' : 'reply';
    case 'system':
      return 'system';
    case 'user':
      if (isHandback(entry)) {
        return 'backgroundAgentReport';
      }
      return isToolResult(entry) ? 'toolResult' : promptKind(entry);
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
