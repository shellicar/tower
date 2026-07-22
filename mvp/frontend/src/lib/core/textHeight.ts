// Exact-enough row height for plain-text messages, computed via canvas
// measureText + line-break arithmetic ahead of mounting the row (spike 2:
// CLAUDE.md "Known follow-up" / docs/planning, pretext technique). Hand-
// rolled rather than the pretext library: the body font is monospace and
// BlockView wraps text with `wrap-anywhere` (break anywhere, not
// word-break), so every character is the same width and line count is
// `ceil(textWidth / maxWidth)` per explicit line — simpler than pretext's
// word/grapheme-boundary wrap model, which doesn't match this CSS anyway.
//
// Scope: only covers a message whose content is ALL `text` blocks — no
// code fences, thinking, tool_use, tool_result, image or document. Those
// return `undefined` and the caller falls back to measuring the mounted
// row, unchanged.
import type { ConversationMessage } from '../types';
import { hasMarkdownConstructs } from './markdown';

const FONT = '13px ui-monospace, "SF Mono", Menlo, monospace';
// Calibrated against this body's line-height/spacing at 13px monospace;
// approximate by construction (see module comment) — the row's
// ResizeObserver corrects any drift once mounted, without a forced read.
const LINE_HEIGHT = 18;
const HEADER_HEIGHT = 21; // header row (13px text) + its mb-1 (4px)
const VERTICAL_PADDING = 12; // article's py-1.5, top + bottom

let ctx: CanvasRenderingContext2D | null | undefined;

function measureCtx(): CanvasRenderingContext2D | undefined {
  if (ctx !== undefined) return ctx ?? undefined;
  ctx = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  if (ctx) ctx.font = FONT;
  return ctx ?? undefined;
}

function linesFor(text: string, maxWidth: number): number {
  const c = measureCtx();
  if (!c || maxWidth <= 0) return 1;
  let lines = 0;
  for (const paragraph of text.split('\n')) {
    if (paragraph === '') {
      lines += 1;
      continue;
    }
    const width = c.measureText(paragraph).width;
    lines += Math.max(1, Math.ceil(width / maxWidth));
  }
  return Math.max(1, lines);
}

/** `undefined` means this message has a block type the technique doesn't
 *  cover — measure the mounted row instead, unchanged. */
export function measurePlainTextHeight(
  message: ConversationMessage,
  maxWidth: number,
): number | undefined {
  if (message.content.length === 0 || message.content.some((b) => b.type !== 'text')) {
    return undefined;
  }
  // Assistant text renders as markdown, whose non-uniform line heights
  // (headings, lists, code fences, tables) the plain-line model below
  // doesn't cover — bail to measure-after-mount rather than teach it.
  if (
    message.role === 'assistant' &&
    message.content.some((b) => hasMarkdownConstructs(String((b as { text?: unknown }).text ?? '')))
  ) {
    return undefined;
  }
  const textLines = message.content.reduce(
    (sum, b) => sum + linesFor(String((b as { text?: unknown }).text ?? ''), maxWidth),
    0,
  );
  return HEADER_HEIGHT + VERTICAL_PADDING + textLines * LINE_HEIGHT;
}
