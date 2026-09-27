// Reconcile: whether a run reached its cell's ending.

import type { Json } from './holding.mts';

export function reached(r: Json): boolean {
  const e = r.ending as Json;
  switch (e.cell) {
    case 'normal':
      return e.keptReply === true;
    case 'thinking-only':
      return Number(e.droppedThinking) > 0 && e.keptReply !== true;
    case 'limit':
    case 'api-error':
      return Number(e.apiErrors) > 0;
    default:
      return e.stopped !== null && e.stopped !== 'after the result';
  }
}
