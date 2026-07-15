import { describe, expect, it } from 'vitest';
import { age, approvalVoid, heat, livenessVerdict } from './time';

// The point of Decision 1: verdicts against the client's own clock are pure
// functions of `now`, so they test deterministically without any clock.

describe('livenessVerdict', () => {
  const now = 100_000;
  it('is alive within three declared intervals', () => {
    expect(livenessVerdict(now, now - 30_000, 30)).toBe('alive'); // 30s < 90s
  });
  it('is stranded past three declared intervals', () => {
    expect(livenessVerdict(now, now - 100_000, 30)).toBe('stranded'); // 100s > 90s
  });
  it('never strands without a declared interval — there is no verdict input', () => {
    expect(livenessVerdict(now, now - 10_000_000, undefined)).toBe('alive');
  });
});

describe('approvalVoid', () => {
  it('is not void within 45s', () => {
    expect(approvalVoid(50_000, 50_000 - 44_000)).toBe(false);
  });
  it('is void past 45s', () => {
    expect(approvalVoid(50_000, 50_000 - 46_000)).toBe(true);
  });
});

describe('age', () => {
  const now = 1_000_000_000;
  it('reads seconds, minutes, hours, days', () => {
    expect(age(now, now - 5_000)).toBe('5s');
    expect(age(now, now - 90_000)).toBe('1m');
    expect(age(now, now - 3_600_000)).toBe('1h');
    expect(age(now, now - 2 * 86_400_000)).toBe('2d');
  });
  it('never goes negative under clock skew', () => {
    expect(age(now, now + 5_000)).toBe('0s');
  });
});

describe('heat', () => {
  const now = 1_000_000_000;
  it('is green fresh, yellow cooling, grey cold', () => {
    expect(heat(now, now - 60_000)).toBe('text-green-400');
    expect(heat(now, now - 2 * 3_600_000)).toBe('text-yellow-500');
    expect(heat(now, now - 10 * 3_600_000)).toBe('text-neutral-500');
  });
});
