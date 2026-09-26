// Proof 10, Q5: does an added directory survive a resume through the
// session store? sdk.d.ts (SDKPermissionRuleEntry.editability, "'session'
// (cliArg/session, in memory only, for the rest of this session)") is about
// permission RULES; sessions.md is the citation for directories
// specifically: "directories added mid-session with /add-dir aren't
// restored either" on resume, and says nothing about a canUseTool-granted
// (addDirectories) directory in particular, which is what this run fills in
// empirically.
//
// One process, two startRun calls, same `name` (so both share the same
// harness cwd, and therefore the same projectKey the FileStore keys on) and
// the same FileStore instance (no broker needed, matching proof-8's
// FileStore pattern, mvp/claude-code-harness/proofs/resume-store.mts):
//
//   seed    canUseTool grants `target` on the natural first ask (addDirectories
//           destination session), same pattern as dir-remove.mts's 'session'
//           route. list_permission_rules confirms the grant, then a second
//           read confirms no further ask. Session id captured from the init
//           message.
//   resume  a SECOND run, options.resume: sessionId, the SAME store, but
//           NEITHER additionalDirectories NOR settings.permissions.
//           additionalDirectories passed again. list_permission_rules is
//           called immediately (a pure control call, before any turn) to
//           check whether the grant survived; then a fresh-filename read of
//           `target` checks whether canUseTool fires again.
//
// The FileStore's jsonl (the resumed transcript itself) is grepped
// afterward for the directory path or "addDirectories", to check whether
// the grant left any trace in the transcript the store persists (the
// SessionStoreEntry schema is transcript entries: user/assistant/attachment/
// etc, not permission events, so the expectation is no trace at all; that
// expectation is checked here, not assumed).
//
//   node proofs/resume-dir.mts

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CanUseTool, SDKMessage, SDKUserMessage, SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import type { HarnessOptions, Run } from '../src/harness.mts';
import { startRun } from '../src/harness.mts';
import { stamp } from '../src/record.mts';

const NAME = 'proof10-resume-dir';
const STATE = join(homedir(), '.local', 'state', 'tower-claude-code-harness', 'proof10-resume');
const FILE_STORE_ROOT = join(STATE, 'file-store');

function fileFor(root: string, key: SessionKey): string {
  const dir = join(root, key.projectKey);
  return key.subpath ? join(dir, key.sessionId, `${key.subpath}.jsonl`) : join(dir, `${key.sessionId}.jsonl`);
}

// Same shape as proof-8's FileStore (mvp/claude-code-harness/proofs/resume-store.mts):
// every entry, one JSON line each, keyed by projectKey/sessionId.
class FileStore implements SessionStore {
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }
  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    const path = fileFor(this.root, key);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, entries.map((e) => `${JSON.stringify(e)}\n`).join(''));
  }
  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const path = fileFor(this.root, key);
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as SessionStoreEntry);
  }
}

const events: unknown[] = [];
const note = (what: string, detail?: unknown): void => {
  events.push({ ts: stamp(), what, detail });
  process.stdout.write(`[${what}] ${detail === undefined ? '' : JSON.stringify(detail)}\n`);
};

const scratch = join(STATE, 'scratch', stamp().replace(/[:.]/g, ''));
const target = join(scratch, 'target');
mkdirSync(target, { recursive: true });
writeFileSync(join(target, 'marker.txt'), 'MARKER-RESUME-9901\n');
writeFileSync(join(target, 'second.txt'), 'MARKER-RESUME-9902\n');
writeFileSync(join(target, 'third.txt'), 'MARKER-RESUME-9903\n');

const store = new FileStore(FILE_STORE_ROOT);

let armNaturalGrant = false;
const canUseTool: CanUseTool = async (toolName, input) => {
  const path = String((input as { file_path?: unknown }).file_path ?? '');
  note('canUseTool/ask', { ts: stamp(), toolName, path });
  if (path.startsWith(target) && armNaturalGrant) {
    armNaturalGrant = false;
    note('canUseTool/allow-natural-grant', { ts: stamp(), path });
    return { behavior: 'allow', updatedInput: input, updatedPermissions: [{ type: 'addDirectories', directories: [target], destination: 'session' }] };
  }
  note('canUseTool/deny', { ts: stamp(), path });
  return { behavior: 'deny', message: 'proof10: resume-dir observes only' };
};

function baseOptions(): HarnessOptions {
  return {
    model: 'claude-haiku-4-5',
    tools: ['Read'],
    canUseTool,
    sessionStore: store,
    sessionStoreFlush: 'eager',
  };
}

const request = (run: Run, r: Record<string, unknown>): Promise<unknown> => (run.query as unknown as { request: (r: Record<string, unknown>) => Promise<unknown> }).request.bind(run.query)(r);
const listRules = async (run: Run, label: string): Promise<void> => {
  note(`list_permission_rules/${label}`, await request(run, { subtype: 'list_permission_rules' }));
};

function user(text: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
}

async function drive(run: Run, steps: { label: string; prompt?: string; before?: () => Promise<void> }[]): Promise<void> {
  let i = 0;
  const send = async (): Promise<void> => {
    for (;;) {
      const step = steps[i];
      if (!step) {
        run.end();
        return;
      }
      if (step.before) await step.before();
      if (step.prompt === undefined) {
        note('control-step', { step: i + 1, label: step.label });
        i += 1;
        continue;
      }
      note('send', { step: i + 1, label: step.label, prompt: step.prompt });
      run.send(user(step.prompt));
      return;
    }
  };
  await send();
  for await (const message of run.messages() as AsyncIterable<SDKMessage>) {
    if (message.type === 'system' && message.subtype === 'init') {
      note('init', { session_id: message.session_id, permissionMode: message.permissionMode });
    }
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') note('assistant text', block.text);
      }
    }
    if (message.type === 'user' && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'tool_result') {
          note('tool_result', { content: (block as { content?: unknown }).content });
        }
      }
    }
    if (message.type === 'result') {
      note('result', { subtype: message.subtype });
      i += 1;
      await send();
    }
  }
}

const ask = (file: string): string => `Use the Read tool once on ${join(target, file)} and quote what it returns (or the error). Nothing else.`;

let sessionId = '';

async function seed(): Promise<void> {
  armNaturalGrant = true;
  const run = startRun({ name: NAME, options: baseOptions() });
  process.stdout.write(`seed run dir: ${run.dir}\n`);
  await drive(run, [
    { label: 'natural first ask grants target via session', prompt: ask('marker.txt') },
    { label: 'confirm grant', before: async () => listRules(run, 'seed-1-after-grant') },
    { label: 'confirm no ask now', prompt: ask('second.txt') },
  ]);
  await run.done;
  const initEvent = events.find((e): e is { what: string; detail: { session_id: string } } => typeof e === 'object' && e !== null && (e as { what?: string }).what === 'init');
  sessionId = initEvent?.detail.session_id ?? '';
  writeFileSync(join(run.dir, 'proof-events.json'), `${JSON.stringify(events, null, 2)}\n`);
  process.stdout.write(`seed session id: ${sessionId}\n`);
}

async function resume(): Promise<void> {
  const before = events.length;
  const run = startRun({ name: NAME, options: { ...baseOptions(), resume: sessionId } });
  process.stdout.write(`resume run dir: ${run.dir}\n`);
  // A pure control call, before any turn: does the grant survive at all,
  // with nothing else in the resumed options naming the directory?
  await listRules(run, 'resume-0-immediately-after-start-before-any-turn');
  await drive(run, [{ label: 'fresh-filename read: does canUseTool fire again?', prompt: ask('third.txt') }]);
  await run.done;
  writeFileSync(join(run.dir, 'proof-events.json'), `${JSON.stringify(events.slice(before), null, 2)}\n`);

  // projectKey's exact derivation is the CLI's own; find the actual file
  // written for this sessionId under FILE_STORE_ROOT instead of guessing it.
  const { readdirSync } = await import('node:fs');
  let foundTranscript: string | undefined;
  for (const projectDir of existsSync(FILE_STORE_ROOT) ? readdirSync(FILE_STORE_ROOT) : []) {
    const candidate = join(FILE_STORE_ROOT, projectDir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) foundTranscript = candidate;
  }
  const transcriptText = foundTranscript ? readFileSync(foundTranscript, 'utf8') : '';
  const mentionsDir = transcriptText.includes(target) || /addDirectories/.test(transcriptText);

  const listCalls = events
    .slice(before)
    .filter((e): e is { what: string; detail: unknown } => typeof e === 'object' && e !== null && (e as { what?: string }).what?.startsWith('list_permission_rules/') === true);
  const rulesSummary = listCalls
    .map((e) => {
      const wrapped = e.detail as { response?: { state?: { workspaceDirectories?: unknown[] } } };
      return `${e.what}: workspaceDirectories=${JSON.stringify(wrapped.response?.state?.workspaceDirectories ?? [])}`;
    })
    .join('\n');
  const askLog = events
    .slice(before)
    .filter((e): e is { what: string; detail: unknown } => typeof e === 'object' && e !== null && (e as { what?: string }).what?.startsWith('canUseTool/') === true)
    .map((e) => `${e.what} ${JSON.stringify(e.detail)}`)
    .join('\n');

  const summary = `found transcript: ${foundTranscript ?? '(none found)'}\ntranscript mentions the target path or "addDirectories": ${mentionsDir}\n\n== list_permission_rules on resume ==\n${rulesSummary}\n\n== canUseTool log on resume ==\n${askLog}\n`;
  writeFileSync(join(run.dir, 'summary.txt'), summary);
  process.stdout.write(`\n${summary}`);
}

await seed();
if (!sessionId) {
  process.stderr.write('resume-dir: seed produced no session id, aborting\n');
  process.exit(1);
}
await resume();
