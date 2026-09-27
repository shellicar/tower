// Integration proof: the leftover stop before serving (proofs 21, 25;
// stopTagged in proofs/orphan-tag.mts, adapted: that file runs on import).
//
// Settled (design.md): leftovers of earlier runs are found by the tag
// (TOWER_AGENT=<agent>, proofs/tag-scan.mts), interrupted (SIGINT), waited
// for (the Claude Codes, not their commands), and forced if they won't exit
// (SIGTERM, then SIGKILL), then recovered, before serving.
//
// Test-only (design.md, allowed): the safety gate. A signal goes only to a
// pid on the `ours` list the driver passes in (Claude Codes this proof
// started), its start time checked against /proc just before sending.
// Refusals are logged and the process is still waited for.

import { cmdline, gone, iso, type Known, signalChecked, sleep } from './lib.mts';
import { scanTag, type TaggedProc } from '../tag-scan.mts';

// TODO: undecided. The waits in the escalation: built as SIGINT, wait 30 s
// (proof 25's value), SIGTERM, wait 10 s, SIGKILL, wait 5 s, then serve
// anyway (logged). Values picked for this proof.
export const WAITS = { SIGINT: 30_000, SIGTERM: 10_000, SIGKILL: 5_000 } as const;
const ROUNDS = 5;

// A Claude Code, as opposed to one of its commands: its command line starts
// with the bundled binary (setpriv execs it in place). Read in full: the
// scan's own copy is cut at 100 characters, shorter than the binary's path.
//
// TODO: undecided. How a Claude Code is told from its commands: built by the
// command line's first word ending in /claude. The alternative is the live
// pid file (proof 25), which a Claude Code already shutting down no longer
// has.
export const isClaudeCode = (p: { cmd: string }): boolean => /(^|\/)claude$/.test(p.cmd.split(' ')[0] ?? '');

export interface StopReport {
  agent: string;
  startedAt: string;
  endedAt: string;
  ms: number;
  rounds: {
    found: { pid: number; starttime: string; claudeCode: boolean; pidFileLive: boolean; cmd: string }[];
    excluded: number;
    unreadable: number;
    signals: { pid: number; sig: string; at: string; sent: boolean; why?: string }[];
    waited: { pid: number; goneAt: string | null; ms: number | null; after: string }[];
  }[];
  outcome: string;
}

export async function stopLeftovers(agent: string, own: Set<number>, ours: Known[], log: (s: string) => void): Promise<StopReport> {
  const t0 = Date.now();
  const report: StopReport = { agent, startedAt: iso(), endedAt: '', ms: 0, rounds: [], outcome: '' };
  for (let round = 1; round <= ROUNDS; round += 1) {
    const scan = scanTag(agent, own);
    const found = scan.found.map((p: TaggedProc) => ({ pid: p.pid, starttime: p.starttime, claudeCode: isClaudeCode({ cmd: cmdline(p.pid) || p.cmd }), pidFileLive: p.pidFileLive, cmd: p.cmd.slice(0, 80) }));
    const r: StopReport['rounds'][number] = { found, excluded: scan.excluded.length, unreadable: scan.ownUidUnreadable.length, signals: [], waited: [] };
    report.rounds.push(r);
    const ccs = found.filter((f) => f.claudeCode);
    log(`leftover stop round ${round}: scan ${scan.ms} ms, found ${JSON.stringify(found.map((f) => [f.pid, f.claudeCode ? 'claude' : f.cmd.slice(0, 20)]))}, excluded ${scan.excluded.length}`);
    if (ccs.length === 0) {
      report.outcome = round === 1 ? 'none found' : `all exited after ${round - 1} round(s)`;
      break;
    }
    const waiting = new Map<number, Known>(ccs.map((c) => [c.pid, { pid: c.pid, starttime: c.starttime }]));
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGKILL'] as const) {
      const left = [...waiting.values()].filter((k) => !gone(k));
      if (left.length === 0) {
        break;
      }
      for (const k of left) {
        if (!ours.some((o) => o.pid === k.pid && o.starttime === k.starttime)) {
          r.signals.push({ pid: k.pid, sig, at: iso(), sent: false, why: 'not on the driver list (proof safety gate)' });
          log(`leftover stop: ${k.pid} is not on this proof's list; ${sig} not sent`);
          continue;
        }
        const sent = signalChecked(k, sig, log);
        r.signals.push({ pid: k.pid, sig, at: iso(), sent });
        if (sent) {
          log(`leftover stop: ${sig} to ${k.pid}`);
        }
      }
      const tw = Date.now();
      const deadline = tw + WAITS[sig];
      while (Date.now() < deadline && [...waiting.values()].some((k) => !gone(k))) {
        await sleep(5);
      }
      for (const k of waiting.values()) {
        if (gone(k) && !r.waited.some((w) => w.pid === k.pid)) {
          r.waited.push({ pid: k.pid, goneAt: iso(), ms: Date.now() - tw, after: sig });
          waiting.delete(k.pid);
        }
      }
    }
    for (const k of waiting.values()) {
      r.waited.push({ pid: k.pid, goneAt: null, ms: null, after: 'SIGKILL' });
    }
    if (waiting.size > 0) {
      report.outcome = `still running after SIGKILL: ${JSON.stringify([...waiting.keys()])}; served anyway (TODO: undecided)`;
      break;
    }
    if (round === ROUNDS) {
      report.outcome = `still finding Claude Codes after ${ROUNDS} rounds; served anyway (TODO: undecided)`;
    }
  }
  report.endedAt = iso();
  report.ms = Date.now() - t0;
  log(`leftover stop: ${report.outcome}; ${report.ms} ms`);
  return report;
}
