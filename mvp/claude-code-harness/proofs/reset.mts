// Reset run: proves the reset script, `pnpm reset-config-dir <name>`, the
// only way an agent resets its config directory (Stephen, 27 Sep: "deleting
// is fine / what i meant is, we shouldnt make the agents use rm / ie they use
// a script to do it 'safely'"). Every reset and refusal here goes through the
// package script as a child process, the way an agent runs it.
//
// - `.`, `..` and `.reset` are refused (exit 1), and nothing under the state
//   folder changes.
// - Run 1 under the name `reset`, to the end. Its runs/<id>/config-dir/ copy
//   holds its transcript: the record of what the reset deletes.
// - Reset (exit 0). config-dirs/reset/ exists and is empty, run 1's session
//   is gone from it, every other entry in config-dirs/ and the state folder
//   is still there, and run 1's record still holds its transcript.
// - Run 2 under the same name starts from the empty directory: listed just
//   before startRun, and afterwards its projects/ holds only run 2's session.
// - While run 2's Claude Code is still running (its result is in, its input
//   not yet closed), a reset is refused (exit 1, naming the pid), and every
//   file run 2 had is still there.
// - config-dirs/.reset/, what the earlier move-aside reset left, has the same
//   files (path, size, sha256) at the end as at the start.
//
// .credentials.json is never read: if one is in a directory it is listed by
// name only.
//
//   node proofs/reset.mts <model>

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { liveClaudeCodes, type Run, startRun } from '../src/harness.mts';

const NAME = 'reset';
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_ROOT = join(homedir(), '.local', 'state', 'tower-claude-code-harness');
const CONFIG_DIRS_ROOT = join(STATE_ROOT, 'config-dirs');
const RESET_ROOT = join(CONFIG_DIRS_ROOT, '.reset');

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

let failures = 0;
const check = (what: string, ok: boolean): void => {
  say(`CHECK ${ok ? 'PASS' : 'FAIL'}: ${what}`);
  if (!ok) {
    failures += 1;
  }
};

function user(content: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
}

// Every entry under a directory: relative path -> "dir", "link -> target",
// or "<size> <sha256>". .credentials.json is listed by name, never read.
function manifest(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(root, rel)).sort()) {
      const relPath = rel ? join(rel, entry) : entry;
      const path = join(root, relPath);
      const st = lstatSync(path);
      if (entry === '.credentials.json') {
        out[relPath] = 'credentials file, not read';
      } else if (st.isSymbolicLink()) {
        out[relPath] = `link -> ${readlinkSync(path)}`;
      } else if (st.isDirectory()) {
        out[relPath] = 'dir';
        walk(relPath);
      } else if (st.isFile()) {
        out[relPath] = `${st.size} ${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
      } else {
        out[relPath] = 'other';
      }
    }
  };
  walk('');
  return out;
}

function transcripts(configDir: string): string[] {
  const projects = join(configDir, 'projects');
  return existsSync(projects) ? readdirSync(projects, { recursive: true, encoding: 'utf8' }).filter((p) => p.endsWith('.jsonl')) : [];
}

function listing(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

interface ScriptResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// The reset script, run as an agent runs it.
function resetScript(name: string): ScriptResult {
  const r = spawnSync('pnpm', ['--silent', 'reset-config-dir', name], { cwd: PACKAGE_ROOT, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Sends one message and reads until its result. Returns the init session id.
async function turn(run: Run, label: string, content: string): Promise<string | undefined> {
  run.send(user(content));
  let sessionId: string | undefined;
  for await (const message of run.messages()) {
    if (message.type === 'system' && message.subtype === 'init') {
      sessionId = message.session_id;
      say(`[${label}] init.session_id: ${message.session_id}`);
    }
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') {
          say(`[${label}] assistant: ${block.text}`);
        }
      }
    }
    if (message.type === 'result') {
      say(`[${label}] result: ${message.subtype}${message.is_error ? ' (error)' : ''}`);
      return sessionId;
    }
  }
  return sessionId;
}

const model = process.argv[2];
if (!model) {
  process.stderr.write('usage: node proofs/reset.mts <model>\n');
  process.exit(2);
}

// 1. `.`, `..` and `.reset` are refused, and nothing changes.
const resetArchiveBefore = manifest(RESET_ROOT);
say(`config-dirs/.reset/ manifest at start (${Object.keys(resetArchiveBefore).length} entries)`);
say('== refusing ., .. and .reset');
const stateBefore = listing(STATE_ROOT);
const dirsBefore = listing(CONFIG_DIRS_ROOT);
for (const bad of ['.', '..', '.reset']) {
  const r = resetScript(bad);
  say(`pnpm reset-config-dir ${bad}: ${JSON.stringify(r)}`);
  check(`reset-config-dir ${JSON.stringify(bad)} refused (exit 1)`, r.status === 1);
}
check('state folder listing unchanged', same(listing(STATE_ROOT), stateBefore));
check('config-dirs/ listing unchanged', same(listing(CONFIG_DIRS_ROOT), dirsBefore));
check('config-dirs/.reset/ unchanged', same(manifest(RESET_ROOT), resetArchiveBefore));

// 2. Run 1, to the end.
say('== run 1');
const run1 = startRun({ name: NAME, options: { model } });
say(`[run 1] run dir: ${run1.dir}`);
say(`[run 1] config dir: ${run1.configDir}`);
say(`[run 1] config dir before: ${JSON.stringify(listing(run1.configDir))}`);
const session1 = await turn(run1, 'run 1', "Don't use any tools. Reply with the single word ONE.");
run1.end();
await run1.done;
const configDir = run1.configDir;
const record1 = join(run1.dir, 'config-dir');
say(`[run 1] transcripts after: ${JSON.stringify(transcripts(configDir))}`);
check(`run 1's transcript is in the config dir`, session1 !== undefined && transcripts(configDir).some((t) => t.endsWith(`${session1}.jsonl`)));
check(`run 1's record (runs/<id>/config-dir/) holds its transcript`, session1 !== undefined && transcripts(record1).some((t) => t.endsWith(`${session1}.jsonl`)));
const record1Before = manifest(record1);

// 3. Reset, through the script.
say('== reset');
const before = manifest(configDir);
say(`config dir manifest before (${Object.keys(before).length} entries): ${JSON.stringify(before)}`);
const stateBeforeReset = listing(STATE_ROOT);
const dirsBeforeReset = listing(CONFIG_DIRS_ROOT);
const reset = resetScript(NAME);
say(`pnpm reset-config-dir ${NAME}: ${JSON.stringify(reset)}`);
check('reset succeeds (exit 0)', reset.status === 0);
check('reset reports the directory deleted', same(JSON.parse(reset.stdout || 'null'), { configDir, deleted: true }));
say(`new config dir: ${JSON.stringify(listing(configDir))}`);
check('config dir exists and is empty', existsSync(configDir) && lstatSync(configDir).isDirectory() && listing(configDir).length === 0);
check(`run 1's session is gone from the config dir`, session1 !== undefined && !transcripts(configDir).some((t) => t.includes(session1)));
check('config-dirs/ holds the same entries', same(listing(CONFIG_DIRS_ROOT), dirsBeforeReset));
check('state folder holds the same entries', same(listing(STATE_ROOT), stateBeforeReset));
check('config-dirs/.reset/ unchanged', same(manifest(RESET_ROOT), resetArchiveBefore));
check(`run 1's record is unchanged`, same(manifest(record1), record1Before));

// 4. Run 2 starts from the empty directory, and a reset is refused while it runs.
say('== run 2');
const run2ListingBefore = listing(configDir);
say(`[run 2] config dir just before startRun: ${JSON.stringify(run2ListingBefore)}`);
check('run 2 starts from an empty config dir', run2ListingBefore.length === 0);
const run2 = startRun({ name: NAME, options: { model } });
say(`[run 2] run dir: ${run2.dir}`);
const session2 = await turn(run2, 'run 2', "Don't use any tools. Reply with the single word TWO.");

// The result is in and the input is still open, so Claude Code is still
// running. Wait for its pid file.
const deadline = Date.now() + 30_000;
let live = liveClaudeCodes(configDir);
while (live.length === 0 && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 100));
  live = liveClaudeCodes(configDir);
}
say(`[run 2] live Claude Codes: ${JSON.stringify(live)}`);
check('run 2 is live by its pid file', live.length > 0);
const run2Before = manifest(configDir);
const refused = resetScript(NAME);
say(`pnpm reset-config-dir ${NAME} while run 2 is live: ${JSON.stringify(refused)}`);
check('reset refused while run 2 is live (exit 1)', refused.status === 1);
check('the refusal names the live pid', live.every((l) => refused.stderr.includes(`pid ${l.pid}`)));
const run2After = manifest(configDir);
check('every entry run 2 had is still there', Object.keys(run2Before).every((k) => k in run2After));
check(`config dir still holds run 2's transcript`, session2 !== undefined && transcripts(configDir).some((t) => t.endsWith(`${session2}.jsonl`)));

run2.end();
await run2.done;
const t2 = transcripts(configDir);
say(`[run 2] transcripts after: ${JSON.stringify(t2)}`);
check(`run 2's config dir holds only run 2's session`, session2 !== undefined && t2.length === 1 && t2[0]?.endsWith(`${session2}.jsonl`) === true);
check(`run 1's session is not in the config dir`, session1 !== undefined && !t2.some((t) => t.includes(session1)));
check('config-dirs/.reset/ unchanged at the end', same(manifest(RESET_ROOT), resetArchiveBefore));

say(`== ${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
say(`run 1: ${run1.dir}`);
say(`run 2: ${run2.dir}`);
process.exitCode = failures === 0 ? 0 : 1;
