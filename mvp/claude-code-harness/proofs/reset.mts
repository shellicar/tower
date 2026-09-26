// Reset run: proves resetConfigDir gives an agent a clean start without
// deleting anything (Stephen, 27 Sep: "a way for an agent to 'reset' their
// directory for a clean start / ie safely, without using rm").
//
// - `.` and `..` are refused, and nothing under the state folder moves.
// - Run 1 under the name `reset`, to the end.
// - Reset. The old directory is at config-dirs/.reset/reset-<timestamp>/,
//   the same directory (same inode) with the same files (path, size,
//   sha256), and config-dirs/reset/ is new and empty.
// - Run 2 under the same name starts from the empty directory: listed
//   just before startRun, and afterwards its projects/ holds only run 2's
//   session.
// - While run 2's Claude Code is still running (its result is in, its input
//   not yet closed), a reset is refused, and nothing moves.
//
// .credentials.json is never read: if one is in the directory it is listed
// by name only.
//
//   node proofs/reset.mts <model>

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { liveClaudeCodes, type Run, resetConfigDir, startRun } from '../src/harness.mts';

const NAME = 'reset';
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

function tryReset(name: string): { movedTo: string | null } | { error: string } {
  try {
    return resetConfigDir(name);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
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

// 1. `.` and `..` are refused, and nothing moves.
say('== refusing . and ..');
const stateBefore = listing(STATE_ROOT);
const dirsBefore = listing(CONFIG_DIRS_ROOT);
for (const bad of ['.', '..']) {
  const r = tryReset(bad);
  say(`resetConfigDir(${JSON.stringify(bad)}): ${JSON.stringify(r)}`);
  check(`resetConfigDir(${JSON.stringify(bad)}) throws`, 'error' in r);
}
check('state folder listing unchanged', JSON.stringify(listing(STATE_ROOT)) === JSON.stringify(stateBefore));
check('config-dirs/ listing unchanged', JSON.stringify(listing(CONFIG_DIRS_ROOT)) === JSON.stringify(dirsBefore));

// 2. Run 1, to the end.
say('== run 1');
const run1 = startRun({ name: NAME, options: { model } });
say(`[run 1] run dir: ${run1.dir}`);
say(`[run 1] config dir: ${run1.configDir}`);
say(`[run 1] config dir before: ${JSON.stringify(listing(run1.configDir))}`);
const session1 = await turn(run1, 'run 1', "Don't use any tools. Reply with the single word ONE.");
run1.end();
await run1.done;
say(`[run 1] transcripts after: ${JSON.stringify(transcripts(run1.configDir))}`);

// 3. Reset.
say('== reset');
const configDir = run1.configDir;
const before = manifest(configDir);
const inodeBefore = lstatSync(configDir).ino;
say(`config dir inode before: ${inodeBefore}`);
say(`config dir manifest before (${Object.keys(before).length} entries): ${JSON.stringify(before)}`);
const reset = tryReset(NAME);
say(`resetConfigDir(${JSON.stringify(NAME)}): ${JSON.stringify(reset)}`);
check('reset succeeds', 'movedTo' in reset && reset.movedTo !== null);
const movedTo = 'movedTo' in reset ? reset.movedTo : null;
if (movedTo === null) {
  say('stopping: nothing was moved');
  process.exit(1);
}
check('moved-aside dir is under config-dirs/.reset/', movedTo.startsWith(`${RESET_ROOT}/${NAME}-`));
const after = manifest(movedTo);
say(`moved-aside inode: ${lstatSync(movedTo).ino}`);
check('moved-aside dir is the same directory (same inode)', lstatSync(movedTo).ino === inodeBefore);
check('moved-aside dir holds the same files, sizes and sha256', JSON.stringify(after) === JSON.stringify(before));
check(`run 1's transcript is in the moved-aside dir`, session1 !== undefined && transcripts(movedTo).some((t) => t.endsWith(`${session1}.jsonl`)));
say(`new config dir: ${JSON.stringify(listing(configDir))}, inode ${lstatSync(configDir).ino}`);
check('new config dir exists and is empty', existsSync(configDir) && listing(configDir).length === 0);

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
const resetsBefore = listing(RESET_ROOT);
const run2Before = manifest(configDir);
const refused = tryReset(NAME);
say(`resetConfigDir(${JSON.stringify(NAME)}) while run 2 is live: ${JSON.stringify(refused)}`);
check('reset refuses while run 2 is live', 'error' in refused);
check('no new entry in config-dirs/.reset/', JSON.stringify(listing(RESET_ROOT)) === JSON.stringify(resetsBefore));
check(`config dir still holds run 2's files`, session2 !== undefined && transcripts(configDir).some((t) => t.endsWith(`${session2}.jsonl`)) && Object.keys(manifest(configDir)).length >= Object.keys(run2Before).length);

run2.end();
await run2.done;
const t2 = transcripts(configDir);
say(`[run 2] transcripts after: ${JSON.stringify(t2)}`);
check(`run 2's config dir holds only run 2's session`, session2 !== undefined && t2.length === 1 && t2[0]?.endsWith(`${session2}.jsonl`) === true);
check(`run 1's session is not in the new config dir`, session1 !== undefined && !t2.some((t) => t.includes(session1)));
check('moved-aside dir unchanged after run 2', JSON.stringify(manifest(movedTo)) === JSON.stringify(before));

say(`== ${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
say(`run 1: ${run1.dir}`);
say(`run 2: ${run2.dir}`);
say(`moved aside: ${movedTo}`);
process.exitCode = failures === 0 ? 0 : 1;
