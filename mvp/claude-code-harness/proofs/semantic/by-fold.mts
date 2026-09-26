// Approach B: the form predicted from the entries alone, by reimplementing
// the part of Claude Code's fold (claude 2.1.282, the message normaliser
// `Pw` and its passes) that decides where each entry's text goes.
//
// This module never reads a request body. The verifier (semantic-form.mts
// --corpus) compares what it predicts with the bodies Claude Code logged.
//
// Every rule is listed in RULES with where it came from; the code below
// cites them by number.

import { type Block, blocksOf, type CcEntry, type FormMessage, isCarrier, type Json, renderedTexts, type Span, textOf } from './form.mts';

export const RULES: Record<string, string> = {
  R1: 'A request adds the messages built from the entries written since the previous response. (observed: every run; code: Pw walks the whole transcript, the thread `continue` body carries only what follows the last assistant message)',
  R2: 'Main-thread user entries become a user message; consecutive user entries merge into one. (code: Pw case "user", SM merge into BD(Qt) when it is a user message; observed)',
  R3: 'In a user message, tool_result blocks come first. (code: i5t puts tool_result blocks ahead of the rest; observed)',
  R4: 'Attachment types session_context, instructions, remote_session_change, dir_sync_notice, unknown_command_fallback, coordinator_context, context_sections, fork_briefing, poll_events, cowork_memory_context, artifact_opening_prefetch fold into the user message; with system turns every other attachment with rendered text goes to the system buffer. (code: the type list in Pw case "attachment", guarded by w = iee(model))',
  R5: 'A queued_command goes to the system buffer unless it is a human-turn prompt (humanTurn true, commandMode "prompt", not isMeta, not forwarded), which folds into the user message. (code: Pw `Ts` path and the queued_command exclusions; only the system case observed)',
  R6: 'Folded reminders and isMeta user text sit ahead of the prompt text in the user message. (observed: session_context, remote_session_change and the cwd notice; the code pass that moves them was not pinned down)',
  R7: 'The system buffer becomes one role "system" message after the user message, one text block, each reminder its `rendered` text, joined by a blank line. (observed; code: $o flush, SUe unwrap and join, per-reminder rewrap for claude-sonnet-5 via AWn)',
  R8: 'The system buffer is flushed before the next assistant message, so each request carries at most one system message after its user message. (code: $o called from case "assistant" and at the end)',
  R9: 'A system message with no user message before it becomes an isMeta user message. (code: o7o; not observed)',
  R10: 'Without system turns for the model (iee false) every reminder folds into the user message. (code: w guard in Pw; order within the message not pinned down)',
  R11: 'An attachment is sent as its `rendered` text verbatim; one without `rendered` is not sent. (observed, proof 15; code: Xle/r8 use rendered when present)',
  R13: 'Which models take system turns: claude-sonnet-5, claude-opus-5-5, claude-fable-5-1 yes; claude-haiku-4-5 no. (observed per model in the runs on disk; code: iee(model) reads a capability `midConversationSystem`)',
  R14: 'In a system message claude-sonnet-5 keeps each reminder wrapped; other models get the wrapper stripped. (code: AWn(model) is model === "claude-sonnet-5", SUe/owe unwrap; observed on opus-5-5 and fable-5-1)',
  R12: 'When a user entry\'s own text (a prompt, or an unflagged marker such as "[Request interrupted by user for tool use]") joins a user message after a text block, that block gets a trailing newline. (observed: remote_session_change, the isMeta cwd notice and the interrupt marker blocks end with an extra "\\n"; code not pinned down)',
};

// R4
export const USER_FOLD = new Set([
  'session_context',
  'instructions',
  'remote_session_change',
  'dir_sync_notice',
  'unknown_command_fallback',
  'coordinator_context',
  'context_sections',
  'fork_briefing',
  'poll_events',
  'cowork_memory_context',
  'artifact_opening_prefetch',
]);

export interface FoldSettings {
  // iee(model): the model takes role "system" messages mid-conversation.
  systemTurns: boolean;
  // AWn(model): claude-sonnet-5 keeps each reminder's <system-reminder>
  // wrapper inside a system message; other system-turn models get it
  // stripped (owe) and the texts joined bare.
  keepWrappers: boolean;
}

// R13, R14. TODO: from the code's capability table once resolved; until then
// from what the runs on disk show per model.
export const MODELS: Record<string, FoldSettings> = {
  'claude-sonnet-5': { systemTurns: true, keepWrappers: true },
  'claude-opus-5-5': { systemTurns: true, keepWrappers: false },
  'claude-fable-5-1': { systemTurns: true, keepWrappers: false },
  'claude-haiku-4-5': { systemTurns: false, keepWrappers: false },
};

export function settingsForModel(model: string): FoldSettings & { known: boolean } {
  const s = MODELS[model.replace(/-\d{8}$/, '')];
  return s ? { ...s, known: true } : { systemTurns: false, keepWrappers: false, known: false };
}

// owe(): strip one <system-reminder> wrapper and the newline inside each tag.
export const OPEN = '<system-reminder>';
export const CLOSE = '</system-reminder>';
export function unwrap(t: string): string {
  if (!t.startsWith(OPEN) || !t.endsWith(CLOSE)) {
    return t;
  }
  let start = OPEN.length;
  if (t.charCodeAt(start) === 10) {
    start += 1;
  }
  let end = t.length - CLOSE.length;
  if (end > start && t.charCodeAt(end - 1) === 10) {
    end -= 1;
  }
  return t.slice(start, end);
}

// R5
function queuedFoldsIntoUser(att: Json): boolean {
  return att.type === 'queued_command' && att.humanTurn === true && att.commandMode === 'prompt' && att.isMeta !== true && att.forwardedIntent === undefined;
}

function goesToSystem(att: Json, s: FoldSettings): boolean {
  if (!s.systemTurns) {
    return false; // R10
  }
  const type = String(att.type);
  if (USER_FOLD.has(type)) {
    return false; // R4
  }
  if (type === 'queued_command') {
    return !queuedFoldsIntoUser(att); // R5
  }
  return true;
}

interface Piece {
  entry: Json;
  kind: 'tool' | 'reminder' | 'prompt';
  blocks: Block[];
}

export interface Prediction {
  messages: FormMessage[];
  rules: string[];
}

// The messages one request adds, from the entries written since the previous
// response (R1), in record order.
export function predict(pending: Json[], s: FoldSettings): Prediction {
  const used = new Set<string>();
  const pieces: Piece[] = [];
  const system: { entry: Json; texts: string[] }[] = [];
  for (const e of pending.filter(isCarrier)) {
    if (e.type === 'user') {
      used.add('R2');
      const blocks = blocksOf((e.message as Json).content);
      const tools = blocks.filter((b) => b.type === 'tool_result');
      const rest = blocks.filter((b) => b.type !== 'tool_result');
      if (tools.length > 0) {
        used.add('R3');
        pieces.push({ entry: e, kind: 'tool', blocks: tools });
      }
      if (rest.length > 0) {
        pieces.push({ entry: e, kind: e.isMeta === true ? 'reminder' : 'prompt', blocks: rest });
      }
      continue;
    }
    const att = e.attachment as Json;
    const texts = renderedTexts(e) ?? [];
    used.add('R11');
    if (goesToSystem(att, s)) {
      used.add(att.type === 'queued_command' ? 'R5' : 'R4');
      system.push({ entry: e, texts });
    } else {
      used.add(s.systemTurns ? (att.type === 'queued_command' ? 'R5' : 'R4') : 'R10');
      pieces.push({ entry: e, kind: 'reminder', blocks: texts.map((t) => ({ type: 'text', text: t })) });
    }
  }
  const messages: FormMessage[] = [];
  if (pieces.length > 0) {
    // R3, R6
    const ordered = [...pieces.filter((p) => p.kind === 'tool'), ...pieces.filter((p) => p.kind === 'reminder'), ...pieces.filter((p) => p.kind === 'prompt')];
    if (ordered.some((p) => p.kind === 'reminder')) {
      used.add('R6');
    }
    const content: Block[] = [];
    const spans = new Map<Json, Span[]>();
    const owner: { entry: Json; span: Span }[] = [];
    for (const p of ordered) {
      p.blocks.forEach((b, bi) => {
        // R12: a user entry's own text joining after a text block puts a
        // newline on the end of that block.
        const prev = owner[content.length - 1];
        const prevBlock = content[content.length - 1];
        if (bi === 0 && p.kind === 'prompt' && b.type === 'text' && prev && prevBlock?.type === 'text') {
          used.add('R12');
          const t = textOf(prevBlock);
          content[content.length - 1] = { ...prevBlock, text: `${t}\n` };
          if (prev.span.start === undefined) {
            prev.span.start = 0;
            prev.span.length = t.length;
          }
        }
        content.push(b);
        const span: Span = { block: content.length - 1 };
        owner.push({ entry: p.entry, span });
        spans.set(p.entry, [...(spans.get(p.entry) ?? []), span]);
      });
    }
    messages.push({ role: 'user', content, ccEntries: toCc(pending, spans) });
  }
  if (system.length > 0) {
    used.add('R7');
    used.add('R8');
    const spans = new Map<Json, Span[]>();
    let text = '';
    used.add('R14');
    for (const { entry, texts: raw } of system) {
      const texts = s.keepWrappers ? raw : raw.map(unwrap);
      for (const t of texts) {
        if (text !== '') {
          text += '\n\n';
        }
        spans.set(entry, [...(spans.get(entry) ?? []), { block: 0, start: text.length, length: t.length, ...(s.keepWrappers ? {} : { unwrapped: true }) }]);
        text += t;
      }
    }
    // A single reminder fills the block: no span needed.
    if (system.length === 1 && system[0]?.texts.length === 1) {
      spans.set(system[0].entry, [{ block: 0, ...(s.keepWrappers ? {} : { unwrapped: true }) }]);
    }
    const role = messages.length > 0 ? 'system' : 'user'; // R9
    if (role === 'user') {
      used.add('R9');
    }
    messages.push({ role, content: [{ type: 'text', text }], ccEntries: toCc(pending, spans) });
  }
  return { messages, rules: [...used].sort() };
}

function toCc(pending: Json[], spans: Map<Json, Span[]>): CcEntry[] {
  return pending
    .filter((e) => spans.has(e))
    .map((e) => ({
      uuid: String(e.uuid),
      type: e.type === 'attachment' ? 'attachment' : 'user',
      ...(e.type === 'attachment' ? { attachment: e.attachment as Json } : {}),
      ...(e.isMeta === true ? { isMeta: true } : {}),
      spans: spans.get(e) as Span[],
    }));
}
