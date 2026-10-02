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
export type LoadMode = { source: 'raw' } | { source: 'messages'; add: ReadonlySet<LoadField>; cwd: string };

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
  /** `message.stop_reason`, `stop_sequence`, `usage` and `type` on assistant entries. */
  | 'msgmeta'
  /** The raw entries that are not messages: attachments, compaction boundary and summary, meta users. */
  | 'extras';

export const LOAD_FIELDS: readonly LoadField[] = ['parent', 'time', 'msgid', 'model', 'msgmeta', 'extras'];

type Json = Record<string, unknown>;

function entryOf(change: PublishedChange): SessionStoreEntry | undefined {
  const { entry } = change.body;
  return isObject(entry) && typeof entry.type === 'string' ? (entry as SessionStoreEntry) : undefined;
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
    const changes = await this.history.read(sessionId);
    this.lastRead = changes.length;
    if (changes.length === 0) {
      return null;
    }
    const { mode } = this.setting;
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
        if (entry?.uuid !== undefined && !messageIds.has(entry.uuid) && !seen.has(entry.uuid)) {
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
    if (role === 'system') {
      return { type: 'system', subtype: 'informational', level: 'info', content: body.content, ...envelope } as SessionStoreEntry;
    }
    if (role === 'user') {
      return { type: 'user', ...envelope, message: { role: 'user', content: body.content } } as SessionStoreEntry;
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
    return { type: 'assistant', ...envelope, message } as SessionStoreEntry;
  }
}
