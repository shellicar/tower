import { describe, expect, it } from 'vitest';
import type { UsageSnapshot } from '../types';
import { formatTokens, formatUsd, parseModelName, priceUsage } from './pricing';

const usage = (over: Partial<UsageSnapshot>): UsageSnapshot => ({
  conv: 'c1',
  model: 'claude-sonnet-4-5',
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheCreation5mTokens: 0,
  cacheCreation1hTokens: 0,
  cacheReadTokens: 0,
  turns: 0,
  contextTokens: 0,
  ...over,
});

describe('priceUsage', () => {
  it('prices the 5m/1h cache-creation split at each TTL own write rate', () => {
    // sonnet-4-5: cacheWrite5m 3.75/M, cacheWrite1h 6/M.
    const { costUsd } = priceUsage(
      usage({ cacheCreationTokens: 2_000_000, cacheCreation5mTokens: 1_000_000, cacheCreation1hTokens: 1_000_000 }),
    );
    expect(costUsd).toBeCloseTo(3.75 + 6, 6);
  });

  it('with no split reported, prices the whole cache-creation total at the 1h rate', () => {
    // sonnet-4-5: input 3/M, cacheWrite1h 6/M, cacheRead 0.3/M, output 15/M.
    const { costUsd } = priceUsage(
      usage({ inputTokens: 1_000_000, cacheCreationTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 }),
    );
    expect(costUsd).toBeCloseTo(3 + 6 + 0.3 + 15, 6);
  });

  it('takes the context window from the model and computes the percentage', () => {
    const p = priceUsage(usage({ model: 'claude-sonnet-4-5', contextTokens: 500_000 }));
    expect(p.contextMax).toBe(1_000_000);
    expect(p.contextPct).toBeCloseTo(50, 6);
  });

  it('resolves an unknown model in a known family to the newest', () => {
    // A future sonnet inherits sonnet-5's rates and 1M window.
    const p = priceUsage(usage({ model: 'claude-sonnet-9', contextTokens: 200_000 }));
    expect(p.contextMax).toBe(1_000_000);
  });

  it('strips a date suffix before lookup', () => {
    const p = priceUsage(usage({ model: 'claude-opus-4-1-20250805', contextTokens: 100_000 }));
    expect(p.contextMax).toBe(200_000);
  });

  it('an unknown family costs nothing and falls back to a 200k window, never NaN', () => {
    const p = priceUsage(usage({ model: 'gpt-something', inputTokens: 1_000_000, contextTokens: 100_000 }));
    expect(p.costUsd).toBe(0);
    expect(p.contextMax).toBe(200_000);
  });
});

describe('formatting', () => {
  it('compacts token counts', () => {
    expect(formatTokens(512)).toBe('512');
    expect(formatTokens(9_700)).toBe('9.7k');
    expect(formatTokens(2_100_000)).toBe('2.1M');
  });

  it('shows the dollar cost to four decimals', () => {
    expect(formatUsd(64.4029)).toBe('$64.4029');
  });
});

describe('parseModelName', () => {
  it('parses family and version', () => {
    expect(parseModelName('claude-sonnet-4-6')).toEqual({ name: 'Sonnet', version: '4.6' });
    expect(parseModelName('claude-opus')).toEqual({ name: 'Opus', version: null });
    expect(parseModelName('claude-mrmagoo-4')).toEqual({ name: 'Mrmagoo', version: '4' });
    expect(parseModelName('claude-mrmagoo')).toEqual({ name: 'Mrmagoo', version: null });
  });

  it('a bare model with no family token passes through', () => {
    expect(parseModelName('claude')).toEqual({ name: 'claude', version: null });
  });
});
