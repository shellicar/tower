#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

const PALETTE = ["#8ec07c", "#83a598", "#d3869b", "#fabd2f", "#fe8019", "#b8bb26", "#7fc7ff", "#d65d0e", "#b16286", "#689d6a"];
const US = "\u001f";
const REPOS = "/repos/";
const DEFAULT_DB = "tower-v2.db";
const BUCKET = process.env.NATS_REPORTING_BUCKET ?? "reporting-lines";
const DIR_KEYS = ["org", "platform", "project", "repo", "worktree"] as const;
const ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";
const FLEET = "fleet";
// Every fleet repo has the same GitHub owner, so only its directory says whose work it manages.
const FLEET_ORGS: Record<string, string> = {
  "claude-fleet-eagers": "Eagers",
  "claude-fleet-flightrac": "Flightrac",
  "claude-fleet-hellicar-solutions": "Hellicar-Solutions",
  "claude-fleet-hopeventures": "HopeVentures",
  "claude-fleet-shellicar": "@shellicar",
};

type Tag = { conv: string; key: string; value: string };
type Dir = { convs: string[]; org: string; platform: string; owner: string; project: string; repo: string; worktree: string; branch: string; fleet: boolean };

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(
    "usage: node tag-conversations.mts [--db <path>] [--apply]\n\n" +
      "Tags each conversation with org, platform, project, repo, worktree, role and\n" +
      "pr. The org is the first directory under /repos/, or the client a fleet repo\n" +
      "manages, or personal for a path outside it; the platform, project, repo and\n" +
      "worktree come from the git repository at the working directory tower recorded;\n" +
      "the role comes from the reporting-lines bucket and the fleet directory; and pr\n" +
      "is the open pull request the conversation mentions most.\n" +
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

if (!existsSync(db)) {
  process.stderr.write(`no database at ${db}\n`);
  process.exit(66);
}

const query = (statement: string): string[][] =>
  execFileSync("sqlite3", ["-readonly", "-cmd", ".timeout 5000", "-separator", US, db, statement], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.split(US));

// Progress goes to stderr so the plan on stdout stays pipeable.
const step = (label: string): void => void process.stderr.write(`  ${label} ... `);
const stepDone = (result: string): void => void process.stderr.write(`${result}\n`);
const substep = (label: string, result: string): void => void process.stderr.write(`    ${label.padEnd(46)} ${result}\n`);

const git = (cwd: string, gitArgs: string[]): string => {
  try {
    return execFileSync("git", gitArgs, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

// Azure DevOps nests a project between the org and the repo and marks it with _git; GitHub does not.
const fromRemote = (url: string): { platform: string; owner: string; project: string; repo: string } => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { platform: "", owner: "", project: "", repo: "" };
  }
  const platform = parsed.host === "github.com" ? "github" : parsed.host === "dev.azure.com" || parsed.host.endsWith(".visualstudio.com") ? "devops" : "";
  const segments = parsed.pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(decodeURIComponent);
  const at = segments.indexOf("_git");
  const owner = segments[0] ?? "";
  if (at > 0) return { platform, owner, project: segments[at - 1] ?? "", repo: segments[at + 1] ?? "" };
  return { platform, owner, project: "", repo: (segments[segments.length - 1] ?? "").replace(/\.git$/, "") };
};

const derive = (cwd: string): Omit<Dir, "convs"> => {
  // Only org needs the path convention. A repository answers for the rest of it
  // wherever it sits, so the git half runs whether or not the path is under /repos/.
  const at = cwd.indexOf(REPOS);
  const segments = at < 0 ? [] : cwd.slice(at + REPOS.length).split("/");
  const fleet = segments[0] === FLEET;
  const client = fleet ? FLEET_ORGS[(segments[1] ?? "").split("--")[0] ?? ""] : undefined;
  const org = at < 0 ? "personal" : (client ?? segments[0] ?? "");
  const empty = { org, platform: "", owner: "", project: "", repo: "", worktree: "", branch: "", fleet };
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) return empty;
  const name = root.slice(root.lastIndexOf("/") + 1);
  const sep = name.indexOf("--");
  const worktree = sep < 0 ? "" : name.slice(sep + 2);
  const branch = git(cwd, ["symbolic-ref", "--short", "HEAD"]);
  const url = git(cwd, ["remote", "get-url", "origin"]);
  if (!url) return { ...empty, worktree, branch };
  return { ...fromRemote(url), org, worktree, branch, fleet };
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

// The pull request a conversation belongs to is the open one for the branch its
// working directory is on. What the conversation says is not evidence: a message
// naming a pull request is as likely to be discussing someone else's.
type Repo = { platform: string; owner: string; project: string; repo: string };
type Branches = { numbers: Map<string, string>; answered: Set<string> };

const repoKey = (r: Repo): string => [r.platform, r.owner, r.project, r.repo].join(US);

const onGithub = (r: Repo): string[] => {
  const raw = execFileSync("gh", ["pr", "list", "--repo", `${r.owner}/${r.repo}`, "--state", "open", "--json", "number,headRefName"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return (JSON.parse(raw) as { number: number; headRefName: string }[]).map((pr) => `${pr.headRefName}${US}${pr.number}`);
};

// az rest authenticates as the default account whatever flags it is given, which
// 403s against an org in another tenant, so the token is minted per subscription
// and attached by hand. The subscription is git-refresh's, read from the same
// repository, so the two can never disagree. (~/lib/git-common.sh)
const onDevops = (r: Repo, cwd: string): string[] => {
  const subscription = git(cwd, ["config", "--get", "cleanup.subscription"]);
  if (!subscription) throw new Error(`no cleanup.subscription in ${cwd}`);
  const profile = git(cwd, ["config", "--get", "cleanup.azconfig"]);
  const env = profile ? { ...process.env, AZURE_CONFIG_DIR: profile.replace(/^~\//, `${homedir()}/`) } : process.env;
  const run = (args: string[]) => execFileSync("az", args, { encoding: "utf8", env, stdio: ["ignore", "pipe", "ignore"] }).trim();
  const token = run(["account", "get-access-token", "--subscription", subscription, "--resource", ADO_RESOURCE, "--query", "accessToken", "-o", "tsv"]);
  const raw = run([
    "rest",
    "--method",
    "get",
    "--skip-authorization-header",
    "--headers",
    `Authorization=Bearer ${token}`,
    "--url",
    `https://dev.azure.com/${r.owner}/${r.project}/_apis/git/repositories/${r.repo}/pullrequests`,
    "--uri-parameters",
    "searchCriteria.status=active",
    "$top=1000",
    "api-version=7.1",
    "--query",
    "value[].[sourceRefName, pullRequestId]",
    "-o",
    "tsv",
  ]);
  // An expired session answers with the HTML sign-in page and a 200, so rows are
  // validated rather than trusted: a branch, a tab, and digits.
  return raw
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((fields): fields is [string, string] => fields.length === 2 && /^\d+$/.test(fields[1] ?? ""))
    .map(([ref, number]) => `${ref.replace(/^refs\/heads\//, "")}${US}${number}`);
};

const openPullRequests = (repos: Map<string, { repo: Repo; cwd: string }>): Branches => {
  const numbers = new Map<string, string>();
  const answered = new Set<string>();
  process.stderr.write(`  open pull requests in ${repos.size} repositories ...\n`);
  for (const [key, { repo, cwd }] of repos) {
    const before = numbers.size;
    try {
      for (const found of repo.platform === "github" ? onGithub(repo) : onDevops(repo, cwd)) {
        const at = found.lastIndexOf(US);
        numbers.set(`${key}${US}${found.slice(0, at)}`, found.slice(at + 1));
      }
      answered.add(key);
      substep(`${repo.platform} ${repo.owner}/${repo.repo}`, `${numbers.size - before} open`);
    } catch {
      substep(`${repo.platform} ${repo.owner}/${repo.repo}`, "did not answer, its pr tags left alone");
    }
  }
  return { numbers, answered };
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
const withCwd = new Set<string>();
const inFleet = new Set<string>();
const byDir = new Map<string, Dir>();

step("reading working directories");
for (const [conv, cwd] of attachments) {
  if (!conv || !cwd || !known.has(conv)) continue;
  const entry = byDir.get(cwd) ?? { convs: [], ...derive(cwd) };
  byDir.set(cwd, entry);
  entry.convs.push(conv);
  withCwd.add(conv);
  if (entry.fleet) inFleet.add(conv);
  for (const key of DIR_KEYS) if (entry[key]) planned.push({ conv, key, value: entry[key] });
}

stepDone(`${byDir.size} directories, ${withCwd.size} conversations`);

step("reporting lines");
const { workers, owners } = reportingLines();
stepDone(`${workers.length} lines, ${new Set(owners).size} owners`);
const roleOf = new Map<string, string>();

// The directory, never the org tag it produced: that tag now names the client.
for (const conv of inFleet) roleOf.set(conv, "handler");
for (const conv of owners) if (known.has(conv)) roleOf.set(conv, "handler");
for (const conv of workers) if (known.has(conv)) roleOf.set(conv, "operator");
for (const [conv, role] of roleOf) planned.push({ conv, key: "role", value: role });

const repos = new Map<string, { repo: Repo; cwd: string }>();
for (const [cwd, entry] of byDir) if (entry.platform && entry.repo && entry.branch) repos.set(repoKey(entry), { repo: entry, cwd });

const { numbers, answered } = openPullRequests(repos);

// Only a conversation whose repository answered can lose its pr tag. One whose
// working directory is gone, or whose host could not be reached, is unknown, and
// unknown is not closed.
const prAnswered = new Set<string>();
for (const entry of byDir.values()) {
  const key = repoKey(entry);
  if (!entry.branch || !answered.has(key)) continue;
  const number = numbers.get(`${key}${US}${entry.branch}`);
  for (const conv of entry.convs) {
    prAnswered.add(conv);
    if (number) planned.push({ conv, key: "pr", value: number });
  }
}

step("existing tags");
const existing = new Map(query("SELECT conv, key, value FROM tags;").map((row) => [`${row[0]}${US}${row[1]}`, row[2]]));
stepDone(`${existing.size} rows`);
const changes = planned.filter((tag) => existing.get(`${tag.conv}${US}${tag.key}`) !== tag.value);
const plannedKeys = new Set(planned.map((tag) => `${tag.conv}${US}${tag.key}`));
const removals = [...existing.keys()].filter((key) => key.endsWith(`${US}pr`) && !plannedKeys.has(key) && prAnswered.has(key.split(US)[0] ?? ""));

const tally = (key: string): [string, number][] => {
  const counts = new Map<string, number>();
  for (const tag of planned) {
    if (tag.key !== key) continue;
    counts.set(tag.value, (counts.get(tag.value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
};

process.stdout.write(`database ${db}\n`);
process.stdout.write(`${withCwd.size} conversations have a recorded working directory\n`);

for (const key of ["org", "platform", "project", "repo", "role", "pr"]) {
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
const silent = repos.size - answered.size;
const prRemovals = silent === 0 ? `${removals.length} stale pr rows to remove` : `${removals.length} stale pr rows to remove, ${silent} repositories did not answer and were left alone`;
process.stdout.write(`\n${changes.length} rows to write, ${planned.length - changes.length} already correct, ${prRemovals}\n`);

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

step(`writing ${changes.length} rows`);
execFileSync("sqlite3", [db], { input: statements.join("\n"), encoding: "utf8" });
stepDone("done");

process.stdout.write(`\nWrote ${changes.length} rows, removed ${removals.length}. Refresh the UI to see them.\n`);
