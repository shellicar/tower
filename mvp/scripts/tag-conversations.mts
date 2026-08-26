#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const PALETTE = ["#8ec07c", "#83a598", "#d3869b", "#fabd2f", "#fe8019", "#b8bb26", "#7fc7ff", "#d65d0e", "#b16286", "#689d6a"];
const US = "\u001f";
const REPOS = "/repos/";
const DEFAULT_DB = "tower-v2.db";
const BUCKET = process.env.NATS_REPORTING_BUCKET ?? "reporting-lines";
const PERSONAL_REPOS: Record<string, string> = { "/Volumes/ato": "ato", "/Users/stephen/dotfiles": "dotfiles" };
const DIR_KEYS = ["org", "project", "repo", "worktree"] as const;

type Tag = { conv: string; key: string; value: string };
type Dir = { convs: string[]; org: string; project: string; repo: string; worktree: string };

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(
    "usage: node tag-conversations.mts [--db <path>] [--apply]\n\n" +
      "Tags each conversation with org, project, repo, worktree and role. The org is\n" +
      "the first directory under /repos/, the project and repo come from the git remote\n" +
      "of the working directory tower recorded, and the role comes from the\n" +
      "reporting-lines bucket.\n" +
      "Prints the plan and exits. --apply prints the same plan, then writes it.\n" +
      "--db defaults to $TOWER_DB, then tower-v2.db in the working directory.\n",
  );
  process.exit(0);
}

const apply = args.includes("--apply");
const dbFlag = args.indexOf("--db");
const db = dbFlag >= 0 ? args[dbFlag + 1] : (process.env.TOWER_DB ?? DEFAULT_DB);

if (!db) {
  process.stderr.write("--db needs a path\n");
  process.exit(64);
}

const query = (statement: string): string[][] =>
  execFileSync("sqlite3", ["-cmd", ".timeout 5000", "-separator", US, db, statement], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.split(US));

const git = (cwd: string, gitArgs: string[]): string => {
  try {
    return execFileSync("git", gitArgs, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

// Azure DevOps nests a project between the org and the repo and marks it with _git; GitHub does not.
const fromRemote = (url: string): { project: string; repo: string } => {
  const segments = new URL(url).pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(decodeURIComponent);
  const at = segments.indexOf("_git");
  if (at > 0) return { project: segments[at - 1] ?? "", repo: segments[at + 1] ?? "" };
  return { project: "", repo: (segments[segments.length - 1] ?? "").replace(/\.git$/, "") };
};

const derive = (cwd: string): { org: string; project: string; repo: string; worktree: string } => {
  const at = cwd.indexOf(REPOS);
  if (at < 0) return { org: "personal", project: "", repo: PERSONAL_REPOS[cwd] ?? "", worktree: "" };
  const [org = ""] = cwd.slice(at + REPOS.length).split("/");
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) return { org, project: "", repo: "", worktree: "" };
  const name = root.slice(root.lastIndexOf("/") + 1);
  const sep = name.indexOf("--");
  const worktree = sep < 0 ? "" : name.slice(sep + 2);
  const url = git(cwd, ["remote", "get-url", "origin"]);
  if (!url) return { org, project: "", repo: "", worktree };
  const { project, repo } = fromRemote(url);
  return { org, project, repo, worktree };
};

const reportingLines = (): { workers: string[]; owners: string[] } => {
  let keys: string[] = [];
  try {
    keys = execFileSync("nats", ["kv", "ls", BUCKET], { encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    process.stderr.write(`warning: could not read the ${BUCKET} bucket, so role falls back to the fleet rule alone\n`);
    return { workers: [], owners: [] };
  }
  const owners: string[] = [];
  for (const key of keys) {
    try {
      const raw = execFileSync("nats", ["kv", "get", BUCKET, key, "--raw"], { encoding: "utf8" });
      const line = JSON.parse(raw) as { owner?: string };
      if (line.owner) owners.push(line.owner);
    } catch {
      process.stderr.write(`warning: could not read the reporting line for ${key}\n`);
    }
  }
  return { workers: keys, owners };
};

const openPullRequests = (): Set<string> => {
  try {
    const raw = execFileSync("gh", ["search", "prs", "--owner", "shellicar", "--state", "open", "--limit", "200", "--json", "number,repository"], { encoding: "utf8" });
    const found = JSON.parse(raw) as { number: number; repository: { nameWithOwner: string } }[];
    return new Set(found.map((item) => `${item.repository.nameWithOwner}#${item.number}`));
  } catch {
    process.stderr.write("warning: could not list open pull requests, so no pr tags are planned\n");
    return new Set();
  }
};

const pullRequests = (open: Set<string>): Map<string, string> => {
  const counts = new Map<string, Map<string, number>>();
  for (const [conv, content] of query("SELECT conv, content FROM messages WHERE content LIKE '%/pull/%';")) {
    if (!conv || !content) continue;
    const perConv = counts.get(conv) ?? new Map<string, number>();
    for (const match of content.matchAll(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g)) {
      const reference = `${match[1]}/${match[2]}#${match[3]}`;
      if (open.has(reference)) perConv.set(reference, (perConv.get(reference) ?? 0) + 1);
    }
    if (perConv.size > 0) counts.set(conv, perConv);
  }
  const winners = new Map<string, string>();
  for (const [conv, perConv] of counts) {
    const best = [...perConv.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best) winners.set(conv, best[0].split("#")[1] ?? "");
  }
  return winners;
};

const known = new Set(query("SELECT conv FROM rows;").map((row) => row[0]));
// Both attachment planes, conv_attachments first: a conv-leaf claim supersedes an
// agent.v1 one, the same precedence towerd's own agents() applies.
const attachments = query(
  "SELECT conv, cwd FROM conv_attachments WHERE cwd IS NOT NULL" +
    " UNION ALL" +
    " SELECT a.conv, a.cwd FROM agent_attachments a WHERE a.cwd IS NOT NULL" +
    " AND a.conv NOT IN (SELECT conv FROM conv_attachments WHERE cwd IS NOT NULL)" +
    " AND a.attached_ts = (SELECT MAX(b.attached_ts) FROM agent_attachments b WHERE b.conv = a.conv)" +
    " GROUP BY a.conv;",
);

const planned: Tag[] = [];
const orgOf = new Map<string, string>();
const byDir = new Map<string, Dir>();

for (const [conv, cwd] of attachments) {
  if (!conv || !cwd || !known.has(conv)) continue;
  const entry = byDir.get(cwd) ?? { convs: [], ...derive(cwd) };
  byDir.set(cwd, entry);
  entry.convs.push(conv);
  orgOf.set(conv, entry.org);
  for (const key of DIR_KEYS) if (entry[key]) planned.push({ conv, key, value: entry[key] });
}

const { workers, owners } = reportingLines();
const roleOf = new Map<string, string>();

for (const [conv, org] of orgOf) if (org === "fleet") roleOf.set(conv, "handler");
for (const conv of owners) if (known.has(conv)) roleOf.set(conv, "handler");
for (const conv of workers) if (known.has(conv)) roleOf.set(conv, "operator");
for (const [conv, role] of roleOf) planned.push({ conv, key: "role", value: role });

for (const [conv, number] of pullRequests(openPullRequests())) if (known.has(conv) && number) planned.push({ conv, key: "pr", value: number });

const existing = new Map(query("SELECT conv, key, value FROM tags;").map((row) => [`${row[0]}${US}${row[1]}`, row[2]]));
const changes = planned.filter((tag) => existing.get(`${tag.conv}${US}${tag.key}`) !== tag.value);
const plannedKeys = new Set(planned.map((tag) => `${tag.conv}${US}${tag.key}`));
const removals = [...existing.keys()].filter((key) => key.endsWith(`${US}pr`) && !plannedKeys.has(key));

const tally = (key: string): [string, number][] => {
  const counts = new Map<string, number>();
  for (const tag of planned) {
    if (tag.key !== key) continue;
    counts.set(tag.value, (counts.get(tag.value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
};

process.stdout.write(`database ${db}\n`);
process.stdout.write(`${orgOf.size} conversations have a recorded working directory\n`);

for (const key of ["org", "project", "repo", "role", "pr"]) {
  process.stdout.write(`\n${key}\n`);
  for (const [value, count] of tally(key)) process.stdout.write(`  ${value.padEnd(34)} ${count}\n`);
}

process.stdout.write(`\nworktree ${planned.filter((tag) => tag.key === "worktree").length} tags\n`);

const pending = new Set(changes.map((tag) => `${tag.conv}${US}${tag.key}`));

process.stdout.write("\ndirectories, * marks one with rows to write\n");
for (const [dir, entry] of [...byDir.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const derived = DIR_KEYS.filter((key) => entry[key])
    .map((key) => `${key}=${entry[key]}`)
    .join(" ");
  const writes = entry.convs.some((conv) => DIR_KEYS.some((key) => pending.has(`${conv}${US}${key}`)));
  process.stdout.write(`  ${writes ? "*" : " "} ${String(entry.convs.length).padStart(2)}  ${dir}  ${derived}\n`);
}
process.stdout.write(`\n${changes.length} rows to write, ${planned.length - changes.length} already correct, ${removals.length} stale pr rows to remove\n`);

if (!apply) {
  process.stdout.write("\nDry run. Nothing was written. Pass --apply to write this plan.\n");
  process.exit(0);
}

if (changes.length === 0 && removals.length === 0) process.exit(0);

const escape = (value: string): string => `'${value.replace(/'/g, "''")}'`;
const seeded = Number(query("SELECT COUNT(*) FROM tag_keys;")[0]?.[0] ?? "0");
const keysUsed = [...new Set(changes.map((tag) => tag.key))];

const statements = ["PRAGMA busy_timeout = 5000;", "BEGIN;"];

keysUsed.forEach((key, index) => {
  const colour = PALETTE[(seeded + index) % PALETTE.length] ?? PALETTE[0];
  statements.push(`INSERT OR IGNORE INTO tag_keys (key, colour) VALUES (${escape(key)}, ${escape(String(colour))});`);
});

for (const tag of changes) {
  statements.push(
    `INSERT INTO tags (conv, key, value) VALUES (${escape(tag.conv)}, ${escape(tag.key)}, ${escape(tag.value)}) ON CONFLICT(conv, key) DO UPDATE SET value = excluded.value;`,
  );
}

for (const key of removals) {
  const [conv = ""] = key.split(US);
  statements.push(`DELETE FROM tags WHERE conv = ${escape(conv)} AND key = 'pr';`);
}

statements.push("COMMIT;");

execFileSync("sqlite3", [db], { input: statements.join("\n"), encoding: "utf8" });

process.stdout.write(`\nWrote ${changes.length} rows, removed ${removals.length}. Refresh the UI to see them.\n`);
