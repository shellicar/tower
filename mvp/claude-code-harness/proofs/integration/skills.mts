// Integration proof: the participant's skills (proofs 22 and 26). The
// declared skill folders are linked, one symlink per skill, into
// <config dir>/skills/ of every config dir a Claude Code of this participant
// is given: the agent's own dir, and whatever /tmp/claude-resume-* the SDK
// gives a store-resumed one (from the spawn hook). Claude Code's own watcher
// does the rest; the participant never calls reloadSkills()
// (.claude/tasks/code-read-reload-skills.md). A live change (add, remove) is
// a change to the links, applied to every linked dir that still exists; an
// edit goes through the link untouched.
//
// Taken from proof 22's desiredLinks/syncLinks (skills-user-level.mts), which
// can't be imported (it runs on import).

import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

// TODO: undecided. Which entries of a declared dir are linked. Built: a
// folder with SKILL.md at its root, skipping one that also holds
// .claude-plugin (proposed by Claude, not confirmed: proof 22 found such a
// folder is adopted as a plugin, hooks and MCP included). The alternative is
// every folder with SKILL.md.
//
// TODO: undecided. Two declared dirs holding the same skill name: the first
// declared wins here.
export function desiredLinks(declared: string[]): Map<string, string> {
  const want = new Map<string, string>();
  for (const d of declared) {
    let names: string[] = [];
    try {
      names = readdirSync(d);
    } catch {
      continue;
    }
    for (const name of names) {
      const p = join(d, name);
      try {
        if (!statSync(p).isDirectory()) {
          continue;
        }
      } catch {
        continue;
      }
      if (!existsSync(join(p, 'SKILL.md')) || existsSync(join(p, '.claude-plugin'))) {
        continue;
      }
      if (!want.has(name)) {
        want.set(name, p);
      }
    }
  }
  return want;
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

// Makes <configDir>/skills a directory holding exactly the wanted per-skill
// links. Idempotent. Never touches an entry that isn't a symlink.
export function syncLinks(configDir: string, want: Map<string, string>): string[] {
  const skills = join(configDir, 'skills');
  if (existsSync(skills) && isLink(skills)) {
    throw new Error(`${skills} is a symlink, expected a directory`);
  }
  mkdirSync(skills, { recursive: true });
  const changes: string[] = [];
  for (const e of readdirSync(skills)) {
    const p = join(skills, e);
    if (!isLink(p)) {
      changes.push(`kept non-link ${e}`);
      continue;
    }
    if (want.get(e) !== readlinkSync(p)) {
      unlinkSync(p);
      changes.push(`-${e}`);
    }
  }
  for (const [name, target] of want) {
    const p = join(skills, name);
    if (!existsSync(p) && !isLink(p)) {
      symlinkSync(target, p);
      changes.push(`+${name}`);
    }
  }
  return changes;
}

// The participant's skills: declared dirs, and every config dir it linked.
//
// TODO: undecided. Keeping links in step: built as a list of every dir the
// hook linked, each re-synced on a change while it exists (proof 22's
// per-dir). The alternative is proof 22's dir-link (a resume dir's skills/
// is one link to the agent dir's).
export class Skills {
  declared: string[];
  readonly linked = new Set<string>();
  readonly log: (s: string) => void;
  constructor(declared: string[], log: (s: string) => void) {
    this.declared = declared;
    this.log = log;
  }
  linkInto(configDir: string, why: string): void {
    this.linked.add(configDir);
    const changes = syncLinks(configDir, desiredLinks(this.declared));
    this.log(`skills [${why}] ${configDir}/skills: ${changes.length ? changes.join(' ') : 'no change'}`);
  }
  set(declared: string[], why: string): void {
    this.declared = declared;
    this.resync(why);
  }
  resync(why: string): void {
    for (const d of this.linked) {
      if (existsSync(d)) {
        this.linkInto(d, why);
      } else {
        this.linked.delete(d);
      }
    }
  }
}
