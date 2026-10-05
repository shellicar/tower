import { contentBlocksOf, isMainChain, isObject, isPrompt, isToolResult, markerOf, messageContent, originKind, type RecordEntry } from './ConversationEntries.js';

export type Role = 'user' | 'assistant' | 'system';

/** Who a message is for: whether the model is sent it and whether the person is shown it. */
type Audience = { model: boolean; user: boolean };

/** What a published entry is on tower: its role and, for an extra, the kind and structured values the message carries beside its content. */
export type Classified = {
  role: Role;
  kind?: string;
  fields?: Record<string, unknown>;
  audience?: Audience;
  /** What the person is shown when it differs from `content` and the message is for both. */
  userContent?: unknown[];
  /** Messages the model is no longer sent: everything before this one, except `except`. */
  scope?: { replaces: 'before'; except: string[] };
  from?: Record<string, unknown>;
  /** Replaces the entry's own content blocks. */
  content?: unknown[];
};

/** The metadata of each compaction boundary seen, by the boundary's uuid; the summary entry names its boundary as its parent. */
export type Compactions = ReadonlyMap<string, Record<string, unknown>>;

// TODO(claude): undecided: `audience` restates what each declared kind
// implies, against the rule that a message's type is stated once. Sent with
// every kind that has one for now, so a reader that does not know the kind
// can still tell who it is for.
const MODEL_ONLY: Audience = { model: true, user: false };
const USER_ONLY: Audience = { model: false, user: true };

function text(value: string): unknown[] {
  return [{ type: 'text', text: value }];
}

function textOf(entry: RecordEntry): string {
  return contentBlocksOf(entry)
    .map((block) => (isObject(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('');
}

function tag(source: string, name: string): string | undefined {
  return new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(source)?.[1];
}

function numberTag(source: string, name: string): number | undefined {
  const value = Number(tag(source, name));
  return Number.isFinite(value) && tag(source, name) !== undefined ? value : undefined;
}

function defined(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

/** `2s`, `1m 5s`: whole seconds, the way a turn's length reads. */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function classifyAssistant(entry: RecordEntry): Classified {
  const synthetic = isObject(entry.message) && entry.message.model === '<synthetic>';
  if (synthetic && entry.isApiErrorMessage === true) {
    return { role: 'assistant', kind: 'api-error', fields: defined({ error: entry.error, status: entry.apiErrorStatus }), audience: USER_ONLY };
  }
  if (synthetic && textOf(entry) === 'No response requested.') {
    return { role: 'assistant', kind: 'no-response', fields: {}, audience: MODEL_ONLY };
  }
  return { role: 'assistant' };
}

function classifySystem(entry: RecordEntry): Classified {
  if (entry.subtype === 'turn_duration' && typeof entry.durationMs === 'number') {
    // TODO(claude): undecided: `endedAt` holds the same time as the
    // message's `at`. Both are sent for now.
    return {
      role: 'system',
      kind: 'turn-finished',
      fields: defined({ durationMs: entry.durationMs, endedAt: entry.timestamp }),
      audience: USER_ONLY,
      content: text(`Worked for ${formatDuration(entry.durationMs)}`),
    };
  }
  return { role: 'system' };
}

function classifyCompactionSummary(entry: RecordEntry, compactions: Compactions): Classified {
  const metadata = compactions.get(String(entry.parentUuid));
  // TODO(claude): undecided: `preservedIds` holds the same ids as
  // `scope.except`. Both are sent for now.
  const preserved = isObject(metadata?.preservedMessages) && Array.isArray(metadata.preservedMessages.uuids) ? metadata.preservedMessages.uuids.filter((id) => typeof id === 'string') : [];
  return {
    role: 'user',
    kind: 'compaction',
    fields: defined({ trigger: metadata?.trigger, durationMs: metadata?.durationMs, preTokens: metadata?.preTokens, postTokens: metadata?.postTokens, preservedIds: preserved }),
    scope: { replaces: 'before', except: preserved },
  };
}

function classifyTaskNotice(entry: RecordEntry): Classified {
  const body = textOf(entry);
  const summary = tag(body, 'summary');
  const durationMs = numberTag(body, 'duration_ms');
  const name = summary === undefined ? undefined : /^(?:Agent|Background command) "(.*)" (?:finished|completed|failed)/.exec(summary)?.[1];
  const shown = summary ?? 'Task finished';
  return {
    role: 'user',
    kind: 'task-finished',
    // TODO(claude): undecided: `from` on a task-finished notice is the
    // orchestrator, while the spec says a message the harness generated has
    // no `from`. Orchestrator for now.
    from: { kind: 'orchestrator' },
    fields: defined({ taskId: tag(body, 'task-id'), toolUseId: tag(body, 'tool-use-id'), status: tag(body, 'status'), summary, name, durationMs, toolUses: numberTag(body, 'tool_uses'), tokens: numberTag(body, 'subagent_tokens') }),
    userContent: text(durationMs === undefined ? shown : `${shown} · ${formatDuration(durationMs)}`),
  };
}

function classifySubagentReport(entry: RecordEntry): Classified {
  const agentType = /<agent-message from="([^"]*)"/.exec(textOf(entry))?.[1];
  // TODO(claude): undecided: `from` on a subagent's hand-back is
  // `{ kind: agent }` bare, with no id naming which agent. Bare for now.
  return { role: 'user', kind: 'subagent-report', from: { kind: 'agent' }, fields: defined({ agentType }) };
}

function classifyUser(entry: RecordEntry, compactions: Compactions): Classified | undefined {
  if (isToolResult(entry)) {
    return { role: 'user' };
  }
  if (entry.isCompactSummary === true) {
    return classifyCompactionSummary(entry, compactions);
  }
  const origin = originKind(entry);
  if (origin === 'task-notification') {
    return classifyTaskNotice(entry);
  }
  if (origin === 'peer') {
    return classifySubagentReport(entry);
  }
  if (entry.isMeta === true) {
    return undefined;
  }
  const marker = markerOf(messageContent(entry));
  if (marker !== undefined) {
    return { role: 'user', kind: marker.kind, fields: marker.fields, userContent: text(marker.userText) };
  }
  return { role: 'user' };
}

/** A reminder is an attachment Claude Code sends the model: its `rendered` blocks, in the role it records as `renderedRole`. An attachment with none is bookkeeping. */
function classifyAttachment(entry: RecordEntry): Classified | undefined {
  const attachment = entry.attachment;
  if (!isObject(attachment) || typeof attachment.type !== 'string' || !Array.isArray(entry.rendered)) {
    return undefined;
  }
  const blocks = entry.rendered.flatMap((block) => (isObject(block) && typeof block.content === 'string' ? text(block.content) : []));
  if (blocks.length === 0) {
    return undefined;
  }
  const role = entry.renderedRole === 'system' ? 'system' : 'user';
  // TODO(claude): undecided: whether a reminder's kind is Claude Code's
  // attachment type, an open set the spec cannot list (as now), or one
  // declared kind with the attachment type in its fields.
  return { role, kind: attachment.type.replaceAll('_', '-'), fields: reminderFields(attachment), audience: MODEL_ONLY, content: blocks };
}

function reminderFields(attachment: Record<string, unknown>): Record<string, unknown> {
  if (attachment.type === 'date') {
    return defined({ date: attachment.date });
  }
  if (attachment.type === 'total_tokens_reminder' && typeof attachment.text === 'string') {
    return defined({ tokensLeft: numberTagOf(attachment.text) });
  }
  return {};
}

function numberTagOf(source: string): number | undefined {
  const match = /(\d+) tokens left/.exec(source);
  return match === null ? undefined : Number(match[1]);
}

/**
 * What an entry is on tower, or undefined for an entry tower never gets:
 * bookkeeping, a subagent's sidechain, an attachment with nothing rendered,
 * and a reminder-like user entry not named here.
 */
export function classify(entry: RecordEntry, compactions: Compactions = new Map()): Classified | undefined {
  if (typeof entry.uuid !== 'string' || !isMainChain(entry)) {
    return undefined;
  }
  switch (entry.type) {
    case 'assistant':
      return classifyAssistant(entry);
    case 'system':
      return classifySystem(entry);
    case 'user':
      return classifyUser(entry, compactions);
    case 'attachment':
      return classifyAttachment(entry);
    default:
      return undefined;
  }
}

/** The role a published entry has on tower, or undefined for an entry tower never gets. */
export function roleOf(entry: RecordEntry): Role | undefined {
  return classify(entry)?.role;
}

/** Whether a published entry is plain chat: no kind, so a say's `from` may be given to it. */
export function isPlainPrompt(entry: RecordEntry, classified: Classified): boolean {
  return classified.kind === undefined && isPrompt(entry);
}
