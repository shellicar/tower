// concerns/usage.svelte.ts — the per-conversation usage snapshot store
// (docs/mvp/frontend-architecture.md). It folds one wire slice — the `usage`
// frame — into an owned map, keyed by conversation. The frame is an ABSOLUTE
// snapshot (towerd owns the accumulation, precisely because a turn's usage
// streams cumulatively on the wire), so a fold is a replacement, never a sum.
//
// Facts only: the snapshot is what towerd measured. The dollar and the context
// percentage are display policy, derived by core/pricing.ts where they are read
// — this concern holds no derivation.

import type { Transport } from '../core/transport.svelte';
import type { ServerMsg, UsageSnapshot } from '../types';

export class Usage {
  #byConv = $state<Map<string, UsageSnapshot>>(new Map());

  constructor(transport: Transport) {
    transport.subscribe((event) => this.#fold(event));
  }

  /** The conversation's usage, or undefined if none yet (absent = zero). */
  get(conv: string): UsageSnapshot | undefined {
    return this.#byConv.get(conv);
  }

  #fold(event: ServerMsg): void {
    if (event.type !== 'usage') return;
    // Replace, never accumulate: the frame carries the current totals.
    const { type: _type, ...snapshot } = event;
    const next = new Map(this.#byConv);
    next.set(event.conv, snapshot);
    this.#byConv = next;
  }
}
