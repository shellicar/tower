// Reads the snapshot db and prints the spike's fixture as JSON on stdout.
// Input (optional, JSON on stdin): { "db": "<path to snapshot db>" }.
// Writes nothing: redirect stdout to src/fixture/fixture.json.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

let input = '';
try {
  input = readFileSync(0, 'utf8');
} catch {
  input = '';
}
const { db: dbPath = resolve(here, '../.snapshot/tower-v2-snapshot.db') } = input.trim()
  ? JSON.parse(input)
  : {};

const db = new DatabaseSync(dbPath, { readOnly: true });

const tagKeys = Object.fromEntries(
  db.prepare('select key, colour from tag_keys').all().map((r) => [r.key, r.colour]),
);

const titles = new Map(db.prepare('select conv, title from titles').all().map((r) => [r.conv, r.title]));

const stale = new Set(
  db
    .prepare('select conv from unread where stale = 1')
    .all()
    .map((r) => r.conv),
);

const tags = new Map();
for (const { conv, key, value } of db.prepare('select conv, key, value from tags').all()) {
  const held = tags.get(conv) ?? {};
  held[key] = value;
  tags.set(conv, held);
}

const conversations = db
  .prepare('select conv, last_event, last_kind from rows order by last_event desc')
  .all()
  .map(({ conv, last_event, last_kind }) => {
    const row = { conv, lastEvent: last_event, lastKind: last_kind };
    const title = titles.get(conv);
    if (title !== undefined) row.title = title;
    const tag = tags.get(conv);
    if (tag !== undefined) row.tags = tag;
    if (stale.has(conv)) row.stale = true;
    return row;
  });

const known = new Set(conversations.map((r) => r.conv));

// The live layout is the pre-spaces one: tabs, each holding a hand-maintained
// list. A tab becomes a space and its list becomes placements in the same
// order. Exclusivity is structural in the new model but was only ever a
// convention here, so a conversation listed in two tabs keeps the first and the
// rest are reported as dropped.
const tabs = JSON.parse(db.prepare('select tabs from layout where layout_id = ?').get('default').tabs);

const slug = (name) => `s-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

// A space holds a handful, so each is topped up from the tag that says what it
// is about. `exec-az` is a worktree inside the tower repo, and it is here as the
// one nested space: without one, nothing exercises depth or the rule that a
// parent shows only its own placements. Specific claims first, so a worktree's
// conversations land in the worktree rather than in its repo.
const seeds = [
  { space: 'tower', parent: null, key: 'repo', value: 'tower', hold: 5 },
  { space: 'exec-az', parent: 'tower', key: 'worktree', value: 'exec-az', hold: 3 },
  { space: 'dotfiles', parent: null, key: 'repo', value: 'dotfiles', hold: 4 },
  { space: 'skills', parent: null, key: 'repo', value: 'skills-v2', hold: 5 },
  { space: 'flightrac', parent: null, key: 'repo', value: 'Flightrac', hold: 4 },
  { space: 'swe', parent: null, key: 'repo', value: 'claude-swe', hold: 4 },
  { space: 'hopeventures', parent: null, key: 'repo', value: 'claude-fleet-hopeventures', hold: 4 },
];

const spaces = seeds.map(({ space, parent }) => ({
  id: slug(space),
  name: space,
  parent: parent === null ? null : slug(parent),
}));
for (const { name } of tabs) if (!spaces.some((s) => s.name === name)) spaces.push({ id: slug(name), name, parent: null });

const placements = [];
const claimed = new Set();
const dropped = [];
const unknown = [];

const put = (conv, space) => {
  claimed.add(conv);
  if (!known.has(conv)) unknown.push(conv);
  placements.push({ conv, space, drawn: true });
};

// His own tab membership first: those are real choices, not derived ones.
for (const tab of tabs) {
  for (const conv of tab.convs) {
    if (claimed.has(conv)) {
      dropped.push({ conv, space: slug(tab.name) });
      continue;
    }
    put(conv, slug(tab.name));
  }
}

const byRecency = conversations.map((r) => r.conv);
for (const { space, key, value, hold } of seeds) {
  const id = slug(space);
  let held = placements.filter((p) => p.space === id).length;
  for (const conv of byRecency) {
    if (held >= hold) break;
    if (claimed.has(conv)) continue;
    if (tags.get(conv)?.[key] !== value) continue;
    put(conv, id);
    held += 1;
  }
}

// Two are left minimised, so the surface that brings one back has something in
// it to judge.
for (const space of ['s-tower', 's-skills']) {
  const last = placements.filter((p) => p.space === space).pop();
  if (last !== undefined) last.drawn = false;
}

db.close();

process.stdout.write(
  `${JSON.stringify(
    {
      takenFrom: dbPath,
      takenAt: new Date().toISOString(),
      tagKeys,
      conversations,
      layout: { spaces, placements },
      notes: {
        conversations: conversations.length,
        titled: conversations.filter((r) => r.title !== undefined).length,
        tagged: conversations.filter((r) => r.tags !== undefined).length,
        placed: placements.length,
        droppedDuplicatePlacements: dropped,
        placedButNotInTheRegister: unknown,
      },
    },
    null,
    1,
  )}\n`,
);
