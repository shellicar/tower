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

// The spaces are the ones he already has, taken from the pre-spaces layout's
// tabs. They arrive empty: placing is the operation everything else hangs off,
// so an app that starts arranged never gets it tested.
const tabs = JSON.parse(db.prepare('select tabs from layout where layout_id = ?').get('default').tabs);

const slug = (name) => 's-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

// Two of them nest, so nesting is in front of him rather than imagined. The
// child names are real: repos under the HopeVentures org, worktrees under the
// Flightrac one.
const children = {
  hopeventures: ['CircuitBreaker', 'claude-fleet-hopeventures'],
  flightrac: ['transport-graphql', 'socket-integration'],
};

const spaces = [];
for (const { name } of tabs) {
  spaces.push({ id: slug(name), name, parent: null });
  for (const child of children[name] ?? [])
    spaces.push({ id: slug(`${name}-${child}`), name: child, parent: slug(name) });
}
const placements = [];

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
        spaces: spaces.length,
      },
    },
    null,
    1,
  )}\n`,
);
