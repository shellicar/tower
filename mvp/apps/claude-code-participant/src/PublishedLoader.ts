import type { SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import { dependsOn } from '@shellicar/core-di';
import { isObject } from './ConversationEntries.js';
import { IPublishedHistory, type PublishedChange } from './PublishedHistory.js';
import type { ISessionLoader } from './SessionStore.js';

/**
 * Prototype (resume-from-published). What `load()` rebuilds a conversation's
 * entries from.
 *
 * - `raw`: the entries published on `changes.entry`, as Claude Code wrote them.
 *   The most the published data can give; a difference from the local resume
 *   here comes from the resume mechanism, not from missing data.
 * - `messages`: an entry per `changes.message`, built from the message's own
 *   fields (id, role, content, ts) plus the envelope a resume needs, with the
 *   `add` fields taken back from the raw entry one at a time.
 *
 * TODO(claude): undecided: every choice of which published fields `load()`
 * uses, and what it supplies itself, is the experiment's; none is decided.
 */
export type LoadMode =
  | { source: 'raw' }
  /** A control, not a design: Claude Code's own record, line for line, given back through `load()`, so only the store mechanism differs from a local resume. */
  | { source: 'file'; lines: SessionStoreEntry[] }
  | {
      source: 'messages';
      add: ReadonlySet<LoadField>;
      /** Raw entries `extras` leaves out: an attachment's type (`environment`) or a system entry's subtype (`system:compact_boundary`). */
      exclude: ReadonlySet<string>;
      cwd: string;
    };

/** A field of a raw entry that `messages` mode can take back, one at a time. */
export type LoadField =
  /** `parentUuid`: otherwise each entry is chained to the one before it. */
  | 'parent'
  /** `timestamp`: otherwise the message's publish time `ts`. */
  | 'time'
  /** `message.id` on assistant entries. */
  | 'msgid'
  /** `message.model` on assistant entries. */
  | 'model'
  /** `requestId` on assistant entries. */
  | 'reqid'
  /** `turnPosition` on user entries. */
  | 'turnpos'
  /** `promptId`, `promptSource`, `turnOrigin` and `permissionMode` on user entries. */
  | 'promptmeta'
  /** `entrypoint`, `version` and `gitBranch` on every entry. */
  | 'envelope'
  /** `message.stop_reason`, `stop_sequence`, `usage` and `type` on assistant entries. */
  | 'msgmeta'
  /** `origin` and `queueSkipAttachments` on user entries. */
  | 'origin'
  /** `toolUseResult`, `serverClassifierContext` and `sourceToolAssistantUUID` on user entries that are tool results. */
  | 'toolresult'
  /** `wireToolInputs` on assistant entries: the tool inputs as sent, in their original key order. */
  | 'wire'
  /** `serverClassifierRequest`, `apiBlockIndex`, `effort` and `perTurnEffort` on assistant entries. */
  | 'asstmeta'
  /** A user entry whose content was a string rather than an array of blocks. */
  | 'strcontent'
  /** A system message's whole raw entry (subtype, compactMetadata, level, ...), not only its content. */
  | 'system'
  /** The raw entries that are not messages: attachments, compaction boundary and summary, meta users. */
  | 'extras';

export const LOAD_FIELDS: readonly LoadField[] = ['parent', 'time', 'msgid', 'model', 'reqid', 'turnpos', 'promptmeta', 'envelope', 'msgmeta', 'origin', 'toolresult', 'wire', 'asstmeta', 'strcontent', 'system', 'extras'];

type Json = Record<string, unknown>;

function entryOf(change: PublishedChange): SessionStoreEntry | undefined {
  const { entry } = change.body;
  return isObject(entry) && typeof entry.type === 'string' ? (entry as SessionStoreEntry) : undefined;
}

/** What an entry is, for leaving kinds out: an attachment's type, `system:<subtype>`, or the entry's type (`user:meta` for a meta user entry). */
function kindOf(entry: SessionStoreEntry): string {
  if (entry.type === 'attachment' && isObject(entry.attachment) && typeof entry.attachment.type === 'string') {
    return entry.attachment.type;
  }
  if (entry.type === 'system') {
    return `system:${String(entry.subtype)}`;
  }
  return entry.type === 'user' && entry.isMeta === true ? 'user:meta' : entry.type === 'user' && entry.isCompactSummary === true ? 'user:compact_summary' : entry.type;
}

/** The first entry for each uuid, in published order: an entry Claude Code appended again is not repeated. */
function distinct(entries: SessionStoreEntry[]): SessionStoreEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (entry.uuid === undefined) {
      return true;
    }
    if (seen.has(entry.uuid)) {
      return false;
    }
    seen.add(entry.uuid);
    return true;
  });
}

/** The mode a proof run loads with. */
export class LoadSetting {
  public readonly mode: LoadMode;

  public constructor(mode: LoadMode) {
    this.mode = mode;
  }
}

export class PublishedLoader implements ISessionLoader {
  @dependsOn(IPublishedHistory) private readonly history!: IPublishedHistory;
  @dependsOn(LoadSetting) private readonly setting!: LoadSetting;
  /** What the last `load` returned, for the proof to save. */
  public last: SessionStoreEntry[] = [];
  /** How many published messages the last `load` read. */
  public lastRead = 0;

  public async load(sessionId: string): Promise<SessionStoreEntry[] | null> {
    const { mode } = this.setting;
    if (mode.source === 'file') {
      this.last = mode.lines;
      return mode.lines;
    }
    const changes = await this.history.read(sessionId);
    this.lastRead = changes.length;
    if (changes.length === 0) {
      return null;
    }
    const entries = mode.source === 'raw' ? this.raw(changes) : this.fromMessages(changes, sessionId, mode);
    this.last = entries;
    return entries;
  }

  private raw(changes: PublishedChange[]): SessionStoreEntry[] {
    return distinct(changes.filter((change) => change.leaf === 'entry').flatMap((change) => entryOf(change) ?? []));
  }

  private fromMessages(changes: PublishedChange[], sessionId: string, mode: Extract<LoadMode, { source: 'messages' }>): SessionStoreEntry[] {
    const messageIds = new Set(changes.filter((change) => change.leaf === 'message').map((change) => String(change.body.id)));
    const rawById = new Map<string, SessionStoreEntry>();
    for (const change of changes) {
      const entry = change.leaf === 'entry' ? entryOf(change) : undefined;
      if (entry?.uuid !== undefined && !rawById.has(entry.uuid)) {
        rawById.set(entry.uuid, entry);
      }
    }
    const built: SessionStoreEntry[] = [];
    const seen = new Set<string>();
    for (const change of changes) {
      if (change.leaf === 'message') {
        const id = String(change.body.id);
        if (!seen.has(id)) {
          seen.add(id);
          built.push(this.fromMessage(change.body, rawById.get(id), sessionId, mode));
        }
      } else if (change.leaf === 'entry' && mode.add.has('extras')) {
        const entry = entryOf(change);
        if (entry?.uuid !== undefined && !messageIds.has(entry.uuid) && !seen.has(entry.uuid) && !mode.exclude.has(kindOf(entry))) {
          seen.add(entry.uuid);
          built.push(entry);
        }
      }
    }
    if (mode.add.has('parent')) {
      return built;
    }
    // Without the published parents, each entry follows the one before it.
    let previous: string | null = null;
    return built.map((entry) => {
      const chained = { ...entry, parentUuid: previous };
      previous = entry.uuid ?? previous;
      return chained;
    });
  }

  private fromMessage(body: Json, raw: SessionStoreEntry | undefined, sessionId: string, mode: Extract<LoadMode, { source: 'messages' }>): SessionStoreEntry {
    const id = String(body.id);
    const role = String(body.role);
    const rawMessage: Json = raw !== undefined && isObject(raw.message) ? raw.message : {};
    const envelope: Json = {
      uuid: id,
      timestamp: mode.add.has('time') && typeof raw?.timestamp === 'string' ? raw.timestamp : body.ts,
      ...(mode.add.has('parent') && raw !== undefined ? { parentUuid: raw.parentUuid } : {}),
      sessionId,
      cwd: mode.cwd,
      isSidechain: false,
      userType: 'external',
    };
    const take = (field: LoadField, names: string[]) => {
      if (mode.add.has(field) && raw !== undefined) {
        for (const name of names) {
          if (raw[name] !== undefined) {
            envelope[name] = raw[name];
          }
        }
      }
    };
    take('envelope', ['entrypoint', 'version', 'gitBranch']);
    if (role === 'user') {
      take('turnpos', ['turnPosition']);
      take('promptmeta', ['promptId', 'promptSource', 'turnOrigin', 'permissionMode']);
      take('origin', ['origin', 'queueSkipAttachments']);
      take('toolresult', ['toolUseResult', 'serverClassifierContext', 'sourceToolAssistantUUID']);
    }
    if (role === 'assistant') {
      take('wire', ['wireToolInputs']);
      take('asstmeta', ['serverClassifierRequest', 'apiBlockIndex', 'effort', 'perTurnEffort']);
    }
    if (role === 'system') {
      // The whole raw entry: its subtype and compaction metadata are not in the message.
      if (mode.add.has('system') && raw !== undefined) {
        return { ...raw, parentUuid: envelope.parentUuid ?? null } as SessionStoreEntry;
      }
      return { type: 'system', subtype: 'informational', level: 'info', content: body.content, ...envelope } as SessionStoreEntry;
    }
    if (role === 'user') {
      // A string content is published as a one-block array; the entry had a string.
      const content = mode.add.has('strcontent') && typeof rawMessage.content === 'string' ? rawMessage.content : body.content;
      return { type: 'user', ...envelope, message: { role: 'user', content } } as SessionStoreEntry;
    }
    const message: Json = { role: 'assistant', content: body.content };
    if (mode.add.has('msgid') && rawMessage.id !== undefined) {
      message.id = rawMessage.id;
    }
    if (mode.add.has('model') && rawMessage.model !== undefined) {
      message.model = rawMessage.model;
    }
    if (mode.add.has('msgmeta')) {
      for (const field of ['type', 'stop_reason', 'stop_sequence', 'usage']) {
        if (rawMessage[field] !== undefined) {
          message[field] = rawMessage[field];
        }
      }
    }
    const requestId = mode.add.has('reqid') && raw?.requestId !== undefined ? { requestId: raw.requestId } : {};
    return { type: 'assistant', ...envelope, ...requestId, message } as SessionStoreEntry;
  }
}
