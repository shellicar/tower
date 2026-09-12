// Copied from mvp/frontend-svelte/src/lib/core/time.ts: the spike shares no
// code with the frontend, and these two decide how a row reads.

export function age(now: number, ts: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export const DEFAULT_STRANDED_AFTER_MS = 60_000;

/** Silence past ~3 of the instance's own declared intervals reads as stranded.
 *  No declared interval falls back to a flat threshold rather than an automatic
 *  'alive'. */
export function livenessVerdict(
  now: number,
  lastPulse: number,
  intervalS: number | undefined,
): 'alive' | 'stranded' {
  const strandedAfter = intervalS ? 3 * intervalS * 1000 : DEFAULT_STRANDED_AFTER_MS;
  return now - lastPulse > strandedAfter ? 'stranded' : 'alive';
}

export function heat(now: number, ts: number): string {
  const d = now - ts;
  return d < 3_600_000 ? 'text-green-400' : d < 21_600_000 ? 'text-yellow-500' : 'text-neutral-500';
}
