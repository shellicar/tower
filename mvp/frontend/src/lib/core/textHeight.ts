// Exact-enough row height for plain-text messages, computed ahead of
// mounting the row (CLAUDE.md "Known follow-up") via @chenglou/pretext's
// canvas measurement + line-break arithmetic (prepare/layout) — no DOM
// read, no forced layout.
//
// Verification spike found the hand-rolled ceil(width/maxWidth) version
// this replaced was a MODEL error, not a tunable one: break-anywhere CSS
// still prefers word boundaries in real browsers, falling back to a
// mid-word break only when a whole word can't fit — so "perfect packing"
// arithmetic undercounts the line count itself on wrapped prose (measured
// off by up to 32px on real content vs pretext's 14px). Ties the hand-
// rolled version on short/simple text, wins by a wide margin on wrapped
// prose and long unbroken tokens.
//
// This is a prediction, not the truth. Verified line-by-line against
// Chrome (22 Jul): pretext occasionally disagrees with the engine about
// whether one more word fits at a wrap boundary, shifting the total by a
// line — and any snapshot of engine behaviour drifts as browsers update.
// The mounted row's ResizeObserver correction is load-bearing for exactly
// this reason; it is not vestigial and must not be removed.
//
// Scope: only covers a message whose content is ALL `text` blocks — no
// code fences, thinking, tool_use, tool_result, image or document. Those
// return `undefined` and the caller falls back to measuring the mounted
// row, unchanged.
import { layout, prepare } from '@chenglou/pretext';
import type { ConversationMessage } from '../types';

const FONT = '13px ui-monospace, "SF Mono", Menlo, monospace';
// Matches BlockView's text block: whitespace-pre-wrap (\n and runs of
// spaces are significant, same as a textarea) + wrap-anywhere.
//
// Calibrated by solving corrected = BASE_HEIGHT + lines * LINE_HEIGHT
// against real mounted-row measurements (not the CSS box model's assumed
// 21px header + 12px padding = 33px) — real line-height is 19.5px, real
// base is 35.5px; the previous 18/33 guess was a consistent ~8% underseed
// across every measured message.
const LINE_HEIGHT = 19.5;
const BASE_HEIGHT = 35.5; // header row + its margin + article's vertical padding

function blockHeight(text: string, maxWidth: number): number {
  if (maxWidth <= 0) return LINE_HEIGHT;
  const prepared = prepare(text, FONT, { whiteSpace: 'pre-wrap' });
  return layout(prepared, maxWidth, LINE_HEIGHT).height;
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
  const textHeight = message.content.reduce(
    (sum, b) => sum + blockHeight(String((b as { text?: unknown }).text ?? ''), maxWidth),
    0,
  );
  return BASE_HEIGHT + textHeight;
}

