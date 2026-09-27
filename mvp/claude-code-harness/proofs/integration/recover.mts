// Integration proof: blind recovery on every serve (proof 17's check(),
// proofs/recovery.mts and orphan-tag.mts, adapted: both run on import).
// Before serving, whatever Claude Code's record holds for the conversation
// that the recording lacks is found, whatever ended the last run. Knowing
// only the session id and the participant's own config.
//
// Differences from proof 17 (TODO: undecided, each the easiest):
//   - Where it looks: the agent's own config dir, and the /tmp/claude-resume-*
//     dirs this agent's Claude Codes were given (recorded durably by the spawn
//     hook), rather than every config dir and every resume dir: another
//     participant's resume of the same conversation (a handover, a check) is
//     not this machine's record.
//   - How it reads: the transcript JSONL directly (proof 17 went through
//     importSessionToStore, which reads CLAUDE_CONFIG_DIR from process.env; a
//     participant serving several conversations at once can't swap that).
//     Main transcript only (subagent files are not in the recording either).
//   - What it does with them: nothing here. The participant appends what's
//     missing to the recording, through the committer (join 1), and only
//     when tower hasn't moved on past the local record (join 2).

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type Json, readJsonl } from './lib.mts';
import { entryId } from './lineage.mts';

export interface Transcript {
  root: string;
  file: string;
  lines: number;
  unparseable: number;
  mtime: string;
  entries: Json[];
}

export function transcripts(roots: string[], sessionId: string): Transcript[] {
  const out: Transcript[] = [];
  for (const root of roots) {
    let projects: string[] = [];
    try {
      projects = readdirSync(join(root, 'projects'));
    } catch {
      continue;
    }
    for (const p of projects) {
      const file = join(root, 'projects', p, `${sessionId}.jsonl`);
      if (!existsSync(file)) {
        continue;
      }
      const raw = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
      const entries: Json[] = [];
      let unparseable = 0;
      for (const l of raw) {
        try {
          entries.push(JSON.parse(l) as Json);
        } catch {
          unparseable += 1;
        }
      }
      out.push({ root, file, lines: raw.length, unparseable, mtime: statSync(file).mtime.toISOString(), entries });
    }
  }
  return out.sort((a, b) => a.mtime.localeCompare(b.mtime));
}

// Oldest transcript first, file order, first sighting wins.
export function union(ts: Transcript[]): Json[] {
  const seen = new Set<string>();
  const out: Json[] = [];
  for (const t of ts) {
    for (const e of t.entries) {
      const id = entryId(e);
      if (!seen.has(id)) {
        seen.add(id);
        out.push(e);
      }
    }
  }
  return out;
}

// The resume dirs this agent's Claude Codes were given (spawn hook record).
export function recordedResumeDirs(agentState: string): string[] {
  return [...new Set(readJsonl(join(agentState, 'resume-dirs.jsonl')).map((l) => String(l.dir)))];
}

// A recovered entry's instant: its own timestamp (Claude Code's clock, the
// same wall clock as the recording), so it lands in the request windows it
// was written in; else the entry before it.
//
// TODO: undecided. The alternative is the recovery instant, which keeps
// every recovered commit after what was already published but puts a
// recovered prompt outside its own request's window.
export function instantOf(e: Json, fallback: number): number {
  const t = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : Number.NaN;
  return Number.isFinite(t) ? t : fallback;
}
