// Proof 10, Q3 + Q4: how each PermissionMode treats a Read/Write/Edit inside
// vs outside the working directories, and what 'auto' mode actually does
// (start-time vs a live setPermissionMode('auto') switch), including the
// doc-mentioned "one-time auto-mode prompt for a read outside the working
// directories" and blockReadsOutsideWorkingDirectories under
// bypassPermissions.
//
// canUseTool logs every call (toolName, path, decisionReason, title) and
// DENIES every one: no test here needs an allow, only whether canUseTool
// fires at all and what it is asked, which is the observable. allowedTools
// is left empty for the same reason as dir-remove.mts: an entry there
// auto-approves the tool everywhere, so canUseTool would never fire and
// every inside/outside comparison would read as "no difference"
// (permissions.md: "Auto-approved tools never reach canUseTool").
//
// Every HOOK_EVENTS member is logged too (Elicitation/ElicitationResult in
// particular, in case the auto-mode outside-directory prompt surfaces there
// instead of as a request_user_dialog frame), and the raw
// claude/<n>/stdout.txt is grepped afterward for "request_user_dialog" and
// "dialog_kind" regardless of whether onUserDialog is wired, since a kind
// not declared in supportedDialogKinds is never emitted to this session at
// all (sdk.d.ts: "The CLI fails closed on absence") and might therefore
// leave no raw frame to find either; that absence is itself the finding for
// Q3/Q4's auto-mode row, not a failed test.
//
//   node proofs/perm-mode.mts <mode>
//
//   default                  Read inside, Read outside
//   acceptEdits               + Write inside, Write outside
//   bypassPermissions         Read inside, Read outside (allowDangerouslySkipPermissions)
//   bypassPermissions-block   as above, plus settings.permissions.blockReadsOutsideWorkingDirectories: true
//   plan                      Read inside, Read outside (docs: same as default)
//   dontAsk                   Read inside, Read outside (docs: an outside Read is denied outright, not asked)
//   auto                      claude-sonnet-4-6 (Opus 4.6+/Sonnet 4.6+/Fable required; older
//                             models silently fall back to 'default' per permission-modes.md).
//                             permissionMode: 'auto' at start; Read inside, Read outside
//   auto-live                 starts 'default'; Read inside/outside; setPermissionMode('auto');
//                             Read inside/outside again

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CanUseTool, HookCallback, HookEvent, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { HOOK_EVENTS } from '@anthropic-ai/claude-agent-sdk';
import type { HarnessOptions } from '../src/harness.mts';
import { startRun } from '../src/harness.mts';
import { stamp } from '../src/record.mts';

const MODES = ['default', 'acceptEdits', 'bypassPermissions', 'bypassPermissions-block', 'plan', 'dontAsk', 'auto', 'auto-live'] as const;
type Mode = (typeof MODES)[number];
const mode = process.argv[2] as Mode;
if (!MODES.includes(mode)) {
  process.stderr.write(`usage: node proofs/perm-mode.mts <${MODES.join('|')}>\n`);
  process.exit(2);
}

const STATE_ROOT = join(homedir(), '.local', 'state', 'tower-claude-code-harness');
const name = `proof10-perm-mode-${mode}`;
const id = `${stamp().replace(/[:.]/g, '')}-${name}`;
const outside = join(STATE_ROOT, 'proof10-perm-scratch', id, 'outside');
mkdirSync(outside, { recursive: true });

const events: unknown[] = [];
const note = (what: string, detail?: unknown): void => {
  events.push({ ts: stamp(), what, detail });
  process.stdout.write(`[${what}] ${detail === undefined ? '' : JSON.stringify(detail)}\n`);
};

const hooks: Partial<Record<HookEvent, { hooks: HookCallback[] }[]>> = {};
for (const evt of HOOK_EVENTS) {
  const cb: HookCallback = async (input) => {
    note(`hook/${evt}`, input);
    return {};
  };
  hooks[evt] = [{ hooks: [cb] }];
}

const canUseTool: CanUseTool = async (toolName, input, opts) => {
  const path = String((input as { file_path?: unknown }).file_path ?? '');
  note('canUseTool/ask', {
    ts: stamp(),
    toolName,
    path,
    decisionReason: opts.decisionReason,
    title: opts.title,
    blockedPath: opts.blockedPath,
  });
  return { behavior: 'deny', message: 'proof10: perm-mode observes only, always denies' };
};

const model = mode === 'auto' || mode === 'auto-live' ? 'claude-sonnet-4-6' : 'claude-haiku-4-5';
const tools = mode === 'acceptEdits' ? ['Read', 'Write', 'Edit'] : ['Read'];

const options: HarnessOptions = {
  model,
  tools,
  permissionMode: mode === 'auto' ? 'auto' : mode === 'auto-live' ? 'default' : (mode.startsWith('bypassPermissions') ? 'bypassPermissions' : mode) as HarnessOptions['permissionMode'],
  canUseTool,
  hooks,
  ...(mode.startsWith('bypassPermissions') ? { allowDangerouslySkipPermissions: true } : {}),
  ...(mode === 'bypassPermissions-block' ? { settings: { permissions: { blockReadsOutsideWorkingDirectories: true } } } : {}),
};

const run = startRun({ name, options });
process.stdout.write(`run dir: ${run.dir}\nmode: ${mode}\nmodel: ${model}\noutside: ${outside}\n`);

// A distinct file per read: Claude Code silently dedupes a repeated Read of
// a file unchanged since the last Read, before canUseTool would fire again
// (found while building dir-remove.mts, "Wasted call, file unchanged since
// your last Read"), so reusing one path across two comparisons (e.g. an
// outside read under 'default' and again after switching to 'auto') would
// make the second one a no-op rather than a fresh ask.
let insideCounter = 0;
const nextInside = (): string => {
  const p = join(run.cwd, `inside-${mode}-${insideCounter++}.txt`);
  writeFileSync(p, `INSIDE-MARKER-8800-${insideCounter}\n`);
  return p;
};
let outsideCounter = 0;
const nextOutside = (): string => {
  const p = join(outside, `outside-${outsideCounter++}.txt`);
  writeFileSync(p, `OUTSIDE-MARKER-8801-${outsideCounter}\n`);
  return p;
};

async function drive(steps: { label: string; prompt: string; before?: () => Promise<void> }[]): Promise<void> {
  let i = 0;
  const send = async (): Promise<void> => {
    const step = steps[i];
    if (!step) {
      run.end();
      return;
    }
    if (step.before) await step.before();
    note('send', { step: i + 1, label: step.label, prompt: step.prompt });
    run.send({ type: 'user', message: { role: 'user', content: step.prompt }, parent_tool_use_id: null });
  };
  await send();
  for await (const message of run.messages() as AsyncIterable<SDKMessage>) {
    if (message.type === 'system' && message.subtype === 'init') {
      note('init', { permissionMode: message.permissionMode, model: message.model });
    }
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') note('assistant text', block.text);
        if (block.type === 'tool_use') note('tool_use', { name: block.name, input: block.input });
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

const readInside = (label: string): { label: string; prompt: string } => ({ label, prompt: `Use the Read tool once on ${nextInside()} and quote what it returns (or the error). Nothing else.` });
const readOutside = (label: string): { label: string; prompt: string } => ({
  label,
  prompt: `Use the Read tool once on ${nextOutside()} and quote what it returns (or the error). Nothing else.`,
});
const writeInside = (label: string, file: string): { label: string; prompt: string } => ({
  label,
  prompt: `Use the Write tool once to write the single line "PROOF10-WRITE-INSIDE" to ${file} (overwrite if it exists), then say OK. Nothing else.`,
});
const writeOutside = (label: string, file: string): { label: string; prompt: string } => ({
  label,
  prompt: `Use the Write tool once to write the single line "PROOF10-WRITE-OUTSIDE" to ${file} (overwrite if it exists), then say OK. Nothing else.`,
});

async function main(): Promise<void> {
  switch (mode) {
    case 'default':
    case 'plan':
    case 'dontAsk':
      await drive([readInside('read inside'), readOutside('read outside')]);
      return;
    case 'acceptEdits':
      await drive([
        readInside('read inside'),
        readOutside('read outside'),
        writeInside('write inside', join(run.cwd, `write-inside-${mode}.txt`)),
        writeOutside('write outside', join(outside, `write-outside-${mode}.txt`)),
      ]);
      return;
    case 'bypassPermissions':
    case 'bypassPermissions-block':
      await drive([readInside('read inside'), readOutside('read outside')]);
      return;
    case 'auto':
      await drive([readInside('read inside'), readOutside('read outside')]);
      return;
    case 'auto-live':
      await drive([
        readInside('read inside, mode default'),
        readOutside('read outside, mode default'),
        { ...readInside('read inside, mode auto (live)'), before: async () => { await run.query.setPermissionMode('auto'); } },
        readOutside('read outside, mode auto (live)'),
      ]);
      return;
  }
}

await main();
await run.done;

writeFileSync(join(run.dir, 'proof-events.json'), `${JSON.stringify(events, null, 2)}\n`);

// Raw frame search: any request_user_dialog / dialog_kind / elicitation
// mention in the real binary's stdout, whether or not onUserDialog was
// wired (it wasn't, here) or a hook caught it.
const captureDir = join(run.dir, 'claude');
const dialogHits: string[] = [];
if (existsSync(captureDir)) {
  for (const spawn of readdirSync(captureDir)) {
    const stdoutPath = join(captureDir, spawn, 'stdout.txt');
    if (!existsSync(stdoutPath)) continue;
    const text = readFileSync(stdoutPath, 'utf8');
    for (const m of text.matchAll(/.*(?:request_user_dialog|dialog_kind|[Ee]licitation).*$/gm)) {
      dialogHits.push(`${spawn}: ${m[0].slice(0, 300)}`);
    }
  }
}

const initEvents = events.filter((e): e is { what: string; detail: unknown } => typeof e === 'object' && e !== null && (e as { what?: string }).what === 'init');
const askLog = events
  .filter((e): e is { what: string; detail: unknown } => typeof e === 'object' && e !== null && (e as { what?: string }).what === 'canUseTool/ask')
  .map((e) => JSON.stringify(e.detail))
  .join('\n');
const toolResults = events
  .filter((e): e is { what: string; detail: unknown } => typeof e === 'object' && e !== null && (e as { what?: string }).what === 'tool_result')
  .map((e) => JSON.stringify(e.detail).slice(0, 200))
  .join('\n');
const hookFired = new Set(events.filter((e) => typeof e === 'object' && e !== null && (e as { what?: string }).what?.startsWith('hook/')).map((e) => (e as { what: string }).what));

const summary = `mode: ${mode}\nmodel: ${model}\n\n== init ==\n${initEvents.map((e) => JSON.stringify(e.detail)).join('\n')}\n\n== canUseTool asks ==\n${askLog}\n\n== tool_result content (truncated) ==\n${toolResults}\n\n== hook events that fired ==\n${[...hookFired].sort().join('\n')}\n\n== raw stdout hits for request_user_dialog / dialog_kind / elicitation ==\n${dialogHits.length ? dialogHits.join('\n') : '(none found)'}\n`;
writeFileSync(join(run.dir, 'summary.txt'), summary);
process.stdout.write(`\n${summary}`);
