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
// list. A tab becomes a top-level space and its list becomes placements in the
// same order. Exclusivity is structural in the new model but was only ever a
// convention here, so a conversation listed in two tabs keeps the first and the
// rest are reported as dropped.
const tabs = JSON.parse(db.prepare('select tabs from layout where layout_id = ?').get('default').tabs);

const slug = (name) => `s-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

const spaces = tabs.map(({ name }) => ({ id: slug(name), name, parent: null }));

const placements = [];
const claimed = new Set();
const dropped = [];
const unknown = [];
for (const tab of tabs) {
  for (const conv of tab.convs) {
    if (claimed.has(conv)) {
      dropped.push({ conv, space: slug(tab.name) });
      continue;
    }
    claimed.add(conv);
    if (!known.has(conv)) unknown.push(conv);
    placements.push({ conv, space: slug(tab.name), drawn: true });
  }
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
