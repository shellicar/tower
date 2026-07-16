// core/pricing.ts — display policy: per-model $/token rates and context
// windows, and the derivations towerd deliberately does not ship ($ and %).
// towerd ships facts (token totals incl. the 5m/1h cache-creation split, the
// latest turn's context size and model); the price table and the window are
// the client's, exactly as the CLI keeps them in the app, not on the wire.
//
// Ported from the SC's claude-cli pricing table. Cache-creation is priced by
// its 5m/1h split at each TTL's own write rate (calculateCostSplit). The
// bridge writes 1h caches today, so in practice the 1h column carries it —
// but the split is priced honestly, not assumed, so a mixed producer prices
// right too.

import type { UsageSnapshot } from '../types';

const M = 1_000_000;

interface ModelRates {
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
  contextWindow: number;
}

// Each family in release order, newest at the tail — position encodes recency.
// An unknown model in a known family resolves to the tail. Rates are $/token
// (the published per-million figure divided by 1e6).
const FAMILIES: Record<string, { id: string; rates: ModelRates }[]> = {
  fable: [
    { id: 'claude-fable-5', rates: { input: 10 / M, cacheWrite5m: 12.5 / M, cacheWrite1h: 20 / M, cacheRead: 1 / M, output: 50 / M, contextWindow: 1_000_000 } },
  ],
  opus: [
    { id: 'claude-opus-3', rates: { input: 15 / M, cacheWrite5m: 18.75 / M, cacheWrite1h: 30 / M, cacheRead: 1.5 / M, output: 75 / M, contextWindow: 200_000 } },
    { id: 'claude-opus-4', rates: { input: 15 / M, cacheWrite5m: 18.75 / M, cacheWrite1h: 30 / M, cacheRead: 1.5 / M, output: 75 / M, contextWindow: 200_000 } },
    { id: 'claude-opus-4-1', rates: { input: 15 / M, cacheWrite5m: 18.75 / M, cacheWrite1h: 30 / M, cacheRead: 1.5 / M, output: 75 / M, contextWindow: 200_000 } },
    { id: 'claude-opus-4-5', rates: { input: 5 / M, cacheWrite5m: 6.25 / M, cacheWrite1h: 10 / M, cacheRead: 0.5 / M, output: 25 / M, contextWindow: 200_000 } },
    { id: 'claude-opus-4-6', rates: { input: 5 / M, cacheWrite5m: 6.25 / M, cacheWrite1h: 10 / M, cacheRead: 0.5 / M, output: 25 / M, contextWindow: 1_000_000 } },
    { id: 'claude-opus-4-7', rates: { input: 5 / M, cacheWrite5m: 6.25 / M, cacheWrite1h: 10 / M, cacheRead: 0.5 / M, output: 25 / M, contextWindow: 1_000_000 } },
    { id: 'claude-opus-4-8', rates: { input: 5 / M, cacheWrite5m: 6.25 / M, cacheWrite1h: 10 / M, cacheRead: 0.5 / M, output: 25 / M, contextWindow: 1_000_000 } },
  ],
  sonnet: [
    { id: 'claude-sonnet-3-7', rates: { input: 3 / M, cacheWrite5m: 3.75 / M, cacheWrite1h: 6 / M, cacheRead: 0.3 / M, output: 15 / M, contextWindow: 200_000 } },
    { id: 'claude-sonnet-4', rates: { input: 3 / M, cacheWrite5m: 3.75 / M, cacheWrite1h: 6 / M, cacheRead: 0.3 / M, output: 15 / M, contextWindow: 1_000_000 } },
    { id: 'claude-sonnet-4-5', rates: { input: 3 / M, cacheWrite5m: 3.75 / M, cacheWrite1h: 6 / M, cacheRead: 0.3 / M, output: 15 / M, contextWindow: 1_000_000 } },
    { id: 'claude-sonnet-4-6', rates: { input: 3 / M, cacheWrite5m: 3.75 / M, cacheWrite1h: 6 / M, cacheRead: 0.3 / M, output: 15 / M, contextWindow: 1_000_000 } },
    { id: 'claude-sonnet-5', rates: { input: 3 / M, cacheWrite5m: 3.75 / M, cacheWrite1h: 6 / M, cacheRead: 0.3 / M, output: 15 / M, contextWindow: 1_000_000 } },
  ],
  haiku: [
    { id: 'claude-haiku-3', rates: { input: 0.25 / M, cacheWrite5m: 0.3 / M, cacheWrite1h: 0.5 / M, cacheRead: 0.03 / M, output: 1.25 / M, contextWindow: 200_000 } },
    { id: 'claude-haiku-3-5', rates: { input: 0.8 / M, cacheWrite5m: 1 / M, cacheWrite1h: 1.6 / M, cacheRead: 0.08 / M, output: 4 / M, contextWindow: 200_000 } },
    { id: 'claude-haiku-4-5', rates: { input: 1 / M, cacheWrite5m: 1.25 / M, cacheWrite1h: 2 / M, cacheRead: 0.1 / M, output: 5 / M, contextWindow: 200_000 } },
  ],
};

// Exact-id lookup, derived from the family lists so there is one source of truth.
const BY_ID: Record<string, ModelRates> = Object.fromEntries(
  Object.values(FAMILIES).flatMap((entries) => entries.map((e) => [e.id, e.rates] as const)),
);

// An unknown family: no rates (cost reads 0, not NaN) and the common window.
const UNKNOWN: ModelRates = { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, contextWindow: 200_000 };

function stripDateSuffix(model: string): string {
  return model.replace(/-\d{8}$/, '');
}

function resolveRates(model: string): ModelRates {
  const exact = BY_ID[model] ?? BY_ID[stripDateSuffix(model)];
  if (exact) return exact;
  const family = /^claude-(fable|opus|sonnet|haiku)-/.exec(model)?.[1];
  if (family && family in FAMILIES) {
    const entries = FAMILIES[family];
    return entries[entries.length - 1].rates; // an unknown model resolves to the newest
  }
  return UNKNOWN;
}

export interface PricedUsage {
  costUsd: number;
  /** The current prompt's occupancy of the window (the latest turn's context). */
  contextUsed: number;
  contextMax: number;
  /** 0..100. */
  contextPct: number;
}

export function priceUsage(u: UsageSnapshot): PricedUsage {
  const r = resolveRates(u.model);
  // Price cache-creation by its 5m/1h split, each at its own write rate. When
  // the producer sent no split (both 0 but a non-zero total), fall back to the
  // 1h rate — the bridge writes 1h caches, so that is the honest assumption.
  const split = u.cacheCreation5mTokens + u.cacheCreation1hTokens;
  const cacheCreationCost =
    split > 0
      ? u.cacheCreation5mTokens * r.cacheWrite5m + u.cacheCreation1hTokens * r.cacheWrite1h
      : u.cacheCreationTokens * r.cacheWrite1h;
  const costUsd =
    u.inputTokens * r.input +
    cacheCreationCost +
    u.cacheReadTokens * r.cacheRead +
    u.outputTokens * r.output;
  const contextMax = r.contextWindow;
  const contextPct = contextMax > 0 ? (u.contextTokens / contextMax) * 100 : 0;
  return { costUsd, contextUsed: u.contextTokens, contextMax, contextPct };
}

/** Compact token count: 9700 → "9.7k", 2_100_000 → "2.1M", 512 → "512". */
export function formatTokens(n: number): string {
  if (n < 1_000) return `${n}`;
  if (n < M) return `${(n / 1_000).toFixed(1)}k`;
  return `${(n / M).toFixed(1)}M`;
}

/** The dollar cost, four decimals — matches the SC's TUI ("$64.4029"). */
export function formatUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}
