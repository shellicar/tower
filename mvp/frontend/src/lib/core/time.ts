// Time verdicts, pure and injectable — Decision 1 of docs/mvp/frontend-architecture.md.
// The two hardest folds (liveness, approval void) are verdicts against the
// client's OWN clock. Kept pure here so they test with a fixed `now`, and
// shared by every concern instead of re-derived per component (they are today
// duplicated across the store, RowList, ConversationPanel, and ApprovalsView).

/** The injectable time source. Production reads the wall clock; a test passes
 *  a fixed value. The verdicts below take `now` as an argument, so they need
 *  no clock to test at all — the clock is for the *ticking* that feeds them,
 *  which is a per-concern cadence (Decision 1: ticker ≠ clock). */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** Liveness is a fold, never declared (agent-spec): the facts are the pulse
 *  and the instance's own declared interval; the verdict is the reader's,
 *  against its own clock. Stranded = silence past ~3 declared intervals; no
 *  declared interval yet = no verdict to pass. */
export function livenessVerdict(
  now: number,
  lastPulse: number,
  intervalS: number | undefined,
): 'alive' | 'stranded' {
  if (intervalS && now - lastPulse > 3 * intervalS * 1000) return 'stranded';
  return 'alive';
}

/** The pulse is ~15s while an approval pends, so ~3 missed (>45s) reads as a
 *  dead holder — the ask is void. The client's derivation, never a wire fact. */
export const VOID_AFTER_MS = 45_000;
export function approvalVoid(now: number, lastPulse: number): boolean {
  return now - lastPulse > VOID_AFTER_MS;
}

/** "How long ago", coarse — the staleness read shared by rail, panel, view. */
export function age(now: number, ts: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Staleness heat: fresh green, cooling yellow, cold grey. */
export function heat(now: number, ts: number): string {
  const d = now - ts;
  return d < 3_600_000
    ? 'text-green-400'
    : d < 21_600_000
      ? 'text-yellow-500'
      : 'text-neutral-500';
}
