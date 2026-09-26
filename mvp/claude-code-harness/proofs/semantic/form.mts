// Proof 16: the conversation as the model received it, on conv.v2
// changes.message, and load() back into Claude Code's entries.
//
// Shared by approach A (by-body.mts: attribute the request body's blocks to
// entries) and approach B (by-fold.mts: predict the blocks from the entries).
// Both produce the same shape, so one load() serves both.
//
// Decided (brief, 26-27 Sep): tower carries Claude Code's typed `attachment`
// objects as a field on the changes.message they belong to; each assistant
// piece is its own changes.message with Claude Code's id and a turnId per API
// response.
//
// TODO: undecided, each the easiest thing that runs, for this proof only:
//   - The field's name and shape: `ccEntries`, one item per Claude Code entry
//     the message contains, in record order, each naming the blocks (and, in
//     a block several entries share, the character span) it produced. It also
//     lists entries that are not attachments (the prompt, a tool_result, an
//     isMeta user entry), so load() can put them back in record order; those
//     carry no payload of their own, their text is the message content.
//   - The id of a message built from several entries: the prompt's uuid,
//     else the first tool_result's, else the first entry's (a joined system
//     message takes its first reminder's uuid).
//   - `from` on system messages: omitted. On prompts: { kind: "human" }, as
//     proof 14 did; on assistant pieces { kind: "agent" }; on tool results
//     none. Carried forward from proof 14, not decided.
//   - turnId of user and system messages: the turn of the response to the
//     request that first carries them (proof 14).
//   - Content shape: a request re-sends an earlier system message as a plain
//     string where it first went as one text block with cache_control; tower
//     gets the first sending, as blocks, with cache_control stripped.

export type Json = Record<string, unknown>;
export type Block = Json & { type: string };

export interface ApiMessage {
  role: string;
  content: string | Block[];
}

// Where an entry's output sits in the message content. `start`/`length` only
// when the text is a part of the block (several reminders joined into one
// block, or text Claude Code added around it).
export interface Span {
  block: number;
  start?: number;
  length?: number;
  // The text went out without the <system-reminder> wrapper its entry has
  // (non-Sonnet-5 system messages); load() puts it back. TODO: undecided.
  unwrapped?: boolean;
  // Proof 20: start/length index into the tool_result block's content (its
  // string, or the text of content[part]), not the block's own text:
  // reminders Claude Code folded into a tool_result, and the result's own
  // (trimmed) content before them. TODO: undecided.
  inResult?: boolean;
  part?: number;
}

export interface CcEntry {
  uuid: string;
  type: 'user' | 'attachment';
  // attachment entries: Claude Code's typed object, verbatim.
  attachment?: Json;
  // user entries: the flags that decide how Claude Code folds them.
  isMeta?: boolean;
  // The entry's content was a string, not blocks: Claude Code sends such an
  // entry, when it stands alone, as a string. TODO: undecided.
  contentString?: boolean;
  spans: Span[];
}

export interface FormMessage {
  role: 'user' | 'system';
  content: Block[];
  ccEntries: CcEntry[];
  // Proof 20: a message no entry accounts for gets an id of its own.
  // TODO: undecided (a fresh uuid here).
  id?: string;
}

export function blocksOf(content: unknown): Block[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  return Array.isArray(content) ? (content as Block[]) : [];
}

export function stripCacheControl(b: Block): Block {
  const { cache_control: _c, ...kept } = b;
  return kept as Block;
}

// A request message as a comparable value: string content as one text block,
// cache_control stripped (it moves between requests).
export function normalise(m: ApiMessage): { role: string; content: Block[] } {
  return { role: m.role, content: blocksOf(m.content).map(stripCacheControl) };
}

export function isToolResults(content: unknown): boolean {
  return blocksOf(content).some((b) => b.type === 'tool_result');
}

// Attachment types with no `rendered` whose text Claude Code sends from the
// payload by a path of its own (proof 20): batching_reminder_sent is the
// stored record of Fable's "First privately list..." system message (kept
// delivery, `attachment.text`, re-sent from the record on every request).
// load() must not give these a `rendered` field.
export const PAYLOAD_TEXT_TYPES = new Set(['batching_reminder_sent']);

// An attachment entry's `rendered` texts (claude 2.1.282 sends these
// verbatim instead of re-rendering the attachment; proof 14).
export function renderedTexts(e: Json): string[] | undefined {
  const att = e.attachment as Json | undefined;
  if (e.type === 'attachment' && att && PAYLOAD_TEXT_TYPES.has(String(att.type)) && typeof att.text === 'string') {
    return [att.text];
  }
  const r = e.rendered;
  if (!Array.isArray(r) || r.length === 0) {
    return undefined;
  }
  return (r as Json[]).map((x) => (typeof x.content === 'string' ? x.content : blocksOf(x.content).map((b) => String(b.text ?? '')).join('')));
}

// The entries that can put something into a request: main-thread user
// entries, and attachment entries with a `rendered` field (proof 15: the
// ones without never reached the model).
export function isCarrier(e: Json): boolean {
  if (e.isSidechain === true) {
    return false;
  }
  if (e.type === 'user') {
    return true;
  }
  return e.type === 'attachment' && renderedTexts(e) !== undefined;
}

export function textOf(b: Block): string {
  return String(b.text ?? '');
}

export function spanText(content: Block[], s: Span): string {
  const b = content[s.block] as Block;
  if (s.inResult) {
    const c = b.content;
    const t = typeof c === 'string' ? c : textOf(blocksOf(c)[s.part ?? 0] as Block);
    return t.slice(s.start ?? 0, (s.start ?? 0) + (s.length ?? t.length));
  }
  if (b.type !== 'text') {
    return '';
  }
  const t = textOf(b);
  return s.start === undefined ? t : t.slice(s.start, s.start + (s.length ?? 0));
}

// The id of a message built from several entries (TODO above).
export function messageId(m: FormMessage): string {
  if (m.id !== undefined) {
    return m.id;
  }
  const prompt = m.ccEntries.find((c) => c.type === 'user' && !c.isMeta && c.spans.some((s) => (m.content[s.block] as Block).type !== 'tool_result'));
  const tool = m.ccEntries.find((c) => c.type === 'user' && c.spans.some((s) => (m.content[s.block] as Block).type === 'tool_result'));
  return (prompt ?? tool ?? (m.ccEntries[0] as CcEntry)).uuid;
}

// ---------------------------------------------------------------------------
// load(): tower's changes.message back into Claude Code's entries.
//
// Each user or system message becomes the entries it lists, in record order:
// an attachment entry gets its typed object back and, as `rendered`, the text
// it produced; a user entry gets the blocks it produced as its content. An
// assistant message becomes an assistant entry (proof 9's `derived`: message
// id from turnId so the pieces of one response join, model from
// telemetry.usage). Nothing else is carried: not the entries the model never
// saw (prompt_snapshot, credential_org, ...), not the raw entries' other
// fields (cwd, version, gitBranch, ...).

export interface TowerMessage extends Json {
  id: string;
  ts: string;
  turnId: string;
  role: string;
  content: Block[];
  ccEntries?: CcEntry[];
}

export function rebuild(messages: TowerMessage[], modelByTurn: Map<string, string>, cwd: string, sessionId: string, withSilent: boolean | Set<string> = false): Json[] {
  const out: Json[] = [];
  for (const m of messages) {
    const common: Json = { timestamp: m.ts, isSidechain: false, sessionId, cwd };
    if (m.role === 'assistant') {
      // The API's own message id when tower has it (ccResponse, TODO in
      // publish.mts), else the turnId, so the pieces of one response join.
      const r = m.ccResponse as Json | undefined;
      const message: Json = { id: typeof r?.messageId === 'string' ? r.messageId : m.turnId, type: 'message', role: 'assistant', content: m.content };
      const model = modelByTurn.get(m.turnId);
      if (model) {
        message.model = model;
      }
      out.push({ ...common, uuid: m.id, type: 'assistant', ...(typeof r?.requestId === 'string' ? { requestId: r.requestId } : {}), message });
      continue;
    }
    // Strict: only the entries that produced something the model saw.
    // Or only the no-block entries of the types named.
    const entries = (m.ccEntries ?? []).filter((c) => c.spans.length > 0 || withSilent === true || (withSilent instanceof Set && withSilent.has(String(c.attachment?.type))));
    if (Array.isArray(m.ccEntries) && m.ccEntries.length === 0) {
      // Proof 20: the participant published it as sent with no entry behind
      // it (an empty ccEntries). Claude Code builds such a message itself
      // when it sends a request, so it is not put back.
      // TODO: undecided (skip, or put back as an isMeta user entry).
      continue;
    }
    if (entries.length === 0) {
      // A message with nothing behind it: put back as tower has it.
      out.push({ ...common, uuid: m.id, type: 'user', isMeta: m.role === 'system' ? true : undefined, message: { role: 'user', content: m.content } });
      continue;
    }
    for (const c of entries) {
      // Only text: a tool_addition block's entry is its deferred_tools_delta,
      // which Claude Code turns back into the block itself.
      const texts = c.spans.filter((s) => s.inResult || (m.content[s.block] as Block | undefined)?.type === 'text').map((s) => (s.unwrapped ? `<system-reminder>\n${spanText(m.content, s)}\n</system-reminder>` : spanText(m.content, s)));
      if (c.type === 'attachment') {
        const payloadText = PAYLOAD_TEXT_TYPES.has(String(c.attachment?.type));
        out.push({ ...common, uuid: c.uuid, type: 'attachment', attachment: c.attachment, ...(texts.length > 0 && !payloadText ? { rendered: texts.map((t) => ({ content: t })) } : {}) });
      } else {
        const blocks = c.spans.map((s) => {
          const b = m.content[s.block] as Block;
          if (s.inResult) {
            // The tool_result's own content, without the reminders folded in.
            // Claude Code trimmed it when it folded; that trim is not undone.
            const own = spanText(m.content, s);
            if (typeof b.content === 'string') {
              return { ...b, content: own };
            }
            const parts = blocksOf(b.content).slice(0, (s.part ?? 0) + 1);
            parts[s.part ?? 0] = { ...(parts[s.part ?? 0] as Block), text: own };
            return { ...b, content: parts };
          }
          return s.start === undefined ? b : { type: 'text', text: spanText(m.content, s) };
        });
        const content = c.contentString && blocks.length === 1 && blocks[0]?.type === 'text' ? textOf(blocks[0]) : blocks;
        out.push({ ...common, uuid: c.uuid, type: 'user', ...(c.isMeta ? { isMeta: true } : {}), message: { role: 'user', content } });
      }
    }
  }
  let prev: string | null = null;
  for (const e of out) {
    e.parentUuid = prev;
    prev = String(e.uuid);
  }
  return out;
}
