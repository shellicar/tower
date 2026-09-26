// Proof 10, Q1 + Q2 + the "configuration below" confound: does
// removeDirectories actually remove access, does the grant's source matter,
// what happens to a tool call racing a mid-turn removal, and does an added
// directory also load CLAUDE.md/skills from inside it (permissions.md's
// "grant file access only" line).
//
// Every route uses the SAME kind of directory: a scratch dir outside the
// working directory, holding marker.txt/second.txt/third.txt plus a probe
// CLAUDE.md and a probe skill (for the confound). A separate, never-granted
// trigger directory holds trigger.txt; canUseTool ALWAYS allows a Read
// against it (whatever the route), and piggybacks whatever PermissionUpdate
// the current step wants to test onto that allow, the only way to deliver
// removeDirectories, since PermissionResult.updatedPermissions only exists
// on the 'allow' branch (sdk.d.ts:2504).
//
// Ground truth per step, always three observables together:
//   1. list_permission_rules (workspaceDirectories + rules), before/after.
//   2. Whether a fresh-filename Read in the target dir needs an ask
//      (canUseTool firing), logged for every call, matched by path prefix.
//   3. The next API request's working-directory text (OTEL_LOG_RAW_API_BODIES).
//
// Every HOOK_EVENTS entry is registered with a logging hook, to see whether
// DirectoryAdded fires for a canUseTool-piggybacked addDirectories grant
// (DirectoryAddedHookInput's own type only names 'slash_command' and
// 'register_repo_root' as sources, sdk.d.ts:673-675) and to confirm no
// DirectoryRemoved event exists to fire at all (HOOK_EVENTS has no such
// member, sdk.d.ts:956).
//
//   node proofs/dir-remove.mts <route>
//
//   cliarg    additionalDirectories at start (a real --add-dir in argv,
//             confirmed by reading claude/1/argv.json in this route's own
//             run directory); removeDirectories destination <firstDestination>
//             (argv[3], default cliArg, matching) against that genuine
//             launch-time grant, no restore yet; then a live
//             addDirectories(destination=cliArg) restore; then
//             removeDirectories destination=session (mismatched against
//             that restored, still cliArg-labeled grant, not against the
//             original launch-time one, which the first attempt already
//             consumed)
//   session   canUseTool addDirectories on the natural first ask; then
//             removeDirectories destination session (matching), a live
//             restore, then removeDirectories destination cliArg
//             (mismatched)
//   flag      options.settings.permissions.additionalDirectories at start,
//             alongside an unrelated allow rule (a real --settings '{...}'
//             in argv, no --add-dir at all, confirmed the same way).
//             Surprise, found by running this route first:
//             list_permission_rules reports this directory's source as
//             'localSettings', NOT 'flagSettings', despite Options.settings
//             sharing applyFlagSettings' value shape (sdk.d.ts:357;
//             Options.settings itself is sdk.d.ts:2209), while the
//             unrelated allow RULE from the exact same options.settings
//             payload IS correctly labeled 'flagSettings'. Only the
//             directory gets mislabeled, on both routes, whether delivered
//             at start (this route) or live (flaglive, below).
//   flaglive  applyFlagSettings({permissions:{additionalDirectories:[target],
//             allow:[...]}}) called LIVE as the first thing, no model turn.
//             Confirmed via argv.json: NEITHER --add-dir NOR --settings
//             appears anywhere, since this is a control_request sent after
//             the process is already running. list_permission_rules still
//             reports the directory as source 'localSettings', not
//             'flagSettings', the same mislabeling as 'flag' above, while
//             the allow rule from the same call IS labeled 'flagSettings'.
//   Both flag and flaglive then try removeDirectories with every
//   PermissionUpdateDestination value, restoring the grant live via
//   applyFlagSettings before each attempt after the first. An earlier
//   version of this file tested all 5 destinations sequentially with no
//   restore, so only the first one ever ran against a real grant; caught
//   by review, not left in. Both routes end with
//   applyFlagSettings({permissions:{additionalDirectories: []}}) once more,
//   to test the shallow-merge-replace hazard: does the unrelated allow rule
//   set in an earlier applyFlagSettings call survive a later call that only
//   means to clear directories?
//   race      Q2: one user turn asking for two Read tool calls "together",
//             one on the trigger dir (canUseTool delayed 3s, then allows +
//             removeDirectories the already-session-granted target dir),
//             one on the target dir (already granted, so no ask, an
//             in-flight call with nothing to delay from this side). Records
//             canUseTool timestamps and the raw claude/*/stdout.txt frame
//             order.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CanUseTool, HookCallback, HookEvent, PermissionUpdate, PermissionUpdateDestination, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { HOOK_EVENTS } from '@anthropic-ai/claude-agent-sdk';
import type { HarnessOptions } from '../src/harness.mts';
import { startRun } from '../src/harness.mts';
import { redact, stamp } from '../src/record.mts';

const ROUTES = ['cliarg', 'session', 'flag', 'flaglive', 'race'] as const;
type Route = (typeof ROUTES)[number];
const route = process.argv[2] as Route;
if (!ROUTES.includes(route)) {
  process.stderr.write(`usage: node proofs/dir-remove.mts <${ROUTES.join('|')}> [firstDestination for cliarg, default cliArg]\n`);
  process.exit(2);
}
// cliarg only: which destination the FIRST removal attempt tries, against
// the genuine launch-time --add-dir grant (every later attempt in that
// route restores live via addDirectories first, so only the first attempt
// is ever tested against the real launch-time grant without an
// intervening live restore).
const cliargFirstDestination = (process.argv[3] as PermissionUpdateDestination | undefined) ?? 'cliArg';
// race only: the trigger call's canUseTool delay in ms (argv[3], default
// 3000). 0 tests the opposite ordering: the removal resolves and lands
// BEFORE raceFile's read is asked about, instead of long after it already
// ran unasked.
const raceDelayMs = route === 'race' && process.argv[3] ? Number(process.argv[3]) : 3000;

const STATE_ROOT = join(homedir(), '.local', 'state', 'tower-claude-code-harness');
const name = `proof10-dir-remove-${route}`;
const id = `${stamp().replace(/[:.]/g, '')}-${name}`;
const bodiesDir = join(STATE_ROOT, 'proof10-api-bodies', id);
mkdirSync(bodiesDir, { recursive: true });
const scratch = join(STATE_ROOT, 'proof10-scratch', id);
const target = join(scratch, 'target');
const trigger = join(scratch, 'trigger');
mkdirSync(target, { recursive: true });
mkdirSync(trigger, { recursive: true });
writeFileSync(join(target, 'marker.txt'), 'MARKER-TARGET-7701\n');
writeFileSync(join(target, 'second.txt'), 'MARKER-SECOND-7702\n');
writeFileSync(join(target, 'third.txt'), 'MARKER-THIRD-7703\n');
writeFileSync(join(target, 'fourth.txt'), 'MARKER-FOURTH-7704\n');
writeFileSync(join(target, 'raceFile.txt'), 'MARKER-RACE-7705\n');
writeFileSync(join(target, 'fifth.txt'), 'MARKER-FIFTH-7706\n');
writeFileSync(join(target, 'sixth.txt'), 'MARKER-SIXTH-7707\n');
// Ten distinct trigger files, one per removeAttempt call: Claude Code
// dedupes a repeated Read of a file unchanged since the last Read
// ("Wasted call, file unchanged since your last Read"), client-side,
// before canUseTool would fire again, so re-reading the SAME trigger file
// silently fails to deliver a second update.
for (let i = 0; i < 10; i += 1) {
  writeFileSync(join(trigger, `trigger-${i}.txt`), `TRIGGER-7799-${i}\n`);
}
let triggerCounter = 0;
const nextTrigger = (): string => join(trigger, `trigger-${triggerCounter++}.txt`);

// No CLAUDE.md/skill probe here: permissions.md gates skills/commands/
// agents loaded from an added directory on the 'project' setting source,
// and CLAUDE.md itself on settingSources: [] excluding CLAUDE.md outright
// (harness README), both of which the harness forces off on every run
// regardless of route, so a behavioral probe would read "nothing loaded" on
// every route alike, a harness artifact, not a route difference. The
// "configuration below" question is answered instead, after the run, by
// reading each route's claude/<n>/argv.json for --add-dir vs --settings
// (the mechanical, settingSources-independent signal for which bucket a
// route's grant falls into per permissions.md's exceptions table).

const events: unknown[] = [];
const note = (what: string, detail?: unknown): void => {
  events.push({ ts: stamp(), what, detail });
  process.stdout.write(`[${what}] ${detail === undefined ? '' : JSON.stringify(detail)}\n`);
};

// ---------------------------------------------------------------------------
// Every HOOK_EVENTS member gets a logging hook, so we can see which actually
// fire around an add/remove (in particular: is there ANY DirectoryAdded for
// a canUseTool-piggybacked grant, and does anything fire on removal, given
// there is no DirectoryRemoved in HOOK_EVENTS at all).
const hooks: Partial<Record<HookEvent, { hooks: HookCallback[] }[]>> = {};
for (const evt of HOOK_EVENTS) {
  const cb: HookCallback = async (input) => {
    note(`hook/${evt}`, input);
    return {};
  };
  hooks[evt] = [{ hooks: [cb] }];
}

// ---------------------------------------------------------------------------
// canUseTool: always allow a Read against `trigger`, piggybacking whatever
// update the current step queued (consumed once, cleared whether or not the
// call ever comes: a step that queues an update MUST also send a trigger
// read, or the update is never delivered, since updatedPermissions only
// exists on the 'allow' branch of a real canUseTool response, sdk.d.ts:2504).
//
// A Read that asks about `target` itself is DENIED, with one deliberate,
// single-use exception (`armNaturalGrant`, the 'session' and 'race' routes'
// first turn: the natural "ask, then grant on that same allow" route). An
// earlier version of this file auto-regranted `target` via session on ANY
// ask there, meant only to keep a run from dead-ending after the first
// successful removal; it silently changed which destination was actually
// current underneath a later "mismatched destination" test, so a test
// labeled mismatched was sometimes actually matching by the time it ran.
// Denying keeps every step's starting state exactly what the step sequence
// says it is; a step that needs the directory back explicitly re-grants it
// through its own trigger call.
let pendingUpdate: PermissionUpdate[] | undefined;
let armNaturalGrant = false;
// For 'race': delay resolving the trigger's canUseTool this many ms, so a
// concurrent Read of an already-granted directory can be observed running
// independently of the pending removal.
let triggerDelayMs = 0;

const canUseTool: CanUseTool = async (toolName, input) => {
  const path = String((input as { file_path?: unknown }).file_path ?? '');
  const ts = stamp();
  note('canUseTool/ask', { ts, toolName, path });
  if (path.startsWith(trigger)) {
    if (triggerDelayMs > 0) {
      await new Promise((r) => setTimeout(r, triggerDelayMs));
    }
    const update = pendingUpdate;
    pendingUpdate = undefined;
    note('canUseTool/allow-trigger', { ts: stamp(), path, update });
    return { behavior: 'allow', updatedInput: input, ...(update ? { updatedPermissions: update } : {}) };
  }
  if (path.startsWith(target) && armNaturalGrant) {
    armNaturalGrant = false;
    note('canUseTool/allow-natural-grant', { ts: stamp(), path });
    return { behavior: 'allow', updatedInput: input, updatedPermissions: [{ type: 'addDirectories', directories: [target], destination: 'session' }] };
  }
  note('canUseTool/deny', { ts: stamp(), path });
  return { behavior: 'deny', message: 'proof10: neither the trigger nor an armed natural grant' };
};

const options: HarnessOptions = {
  model: 'claude-haiku-4-5',
  tools: ['Read'],
  // allowedTools deliberately omitted: an entry there auto-approves the
  // tool everywhere, so canUseTool never fires and every inside/outside
  // comparison would read as "no difference" (permissions.md, fetched by
  // the parallel docs agent: "Auto-approved tools never reach canUseTool").
  permissionMode: 'default',
  canUseTool,
  hooks,
  env: { ...process.env, OTEL_LOG_RAW_API_BODIES: `file:${bodiesDir}` },
  debugFile: join(bodiesDir, 'debug.log'),
  ...(route === 'cliarg' ? { additionalDirectories: [target] } : {}),
  ...(route === 'flag' ? { settings: { permissions: { additionalDirectories: [target], allow: ['WebFetch(domain:proof10-hazard-probe.invalid)'] } } } : {}),
};

const run = startRun({ name, options });
process.stdout.write(`run dir: ${run.dir}\nroute: ${route}\ntarget: ${target}\ntrigger: ${trigger}\n`);

const request = (r: Record<string, unknown>): Promise<unknown> => (run.query as unknown as { request: (r: Record<string, unknown>) => Promise<unknown> }).request.bind(run.query)(r);
const listRules = async (label: string): Promise<void> => {
  const state = await request({ subtype: 'list_permission_rules' });
  note(`list_permission_rules/${label}`, state);
};

const askText = (file: string, dir = target): string =>
  `Use the Read tool once on ${join(dir, file)} and quote what it returns (or the error). Then list, verbatim, every additional working directory your environment information names, or say there are none. Nothing else.`;

type Step = { label: string; before?: () => Promise<void>; prompt?: string; after?: () => Promise<void> };

// A trigger call is the only way to deliver an addDirectories/removeDirectories
// update: it must be its OWN model turn against a fresh trigger file (a
// repeated Read of the same trigger file is silently deduped by Claude Code
// before canUseTool would fire again, "Wasted call, file unchanged since
// your last Read", so every call here needs nextTrigger()).
function triggerCall(label: string, update: PermissionUpdate): Step {
  return {
    label,
    before: async () => {
      pendingUpdate = [update];
    },
    prompt: `Use the Read tool once on ${nextTrigger()} and quote what it returns.`,
  };
}

function verifyStep(label: string, file: string, afterLabel: string): Step {
  return { label, prompt: askText(file), after: async () => listRules(afterLabel) };
}

function stepsFor(r: Route): Step[] {
  switch (r) {
    case 'cliarg':
      return [
        { label: 'initial: cliArg grant at start', before: async () => listRules('cliarg-0-initial'), prompt: askText('marker.txt') },
        triggerCall(`remove destination=${cliargFirstDestination} (against the genuine launch-time --add-dir grant, no restore yet)`, { type: 'removeDirectories', directories: [target], destination: cliargFirstDestination }),
        verifyStep(`verify after remove destination=${cliargFirstDestination}`, 'second.txt', `cliarg-1-after-remove-${cliargFirstDestination}`),
        triggerCall('restore: addDirectories destination=cliArg (so the next removal is genuinely mismatched)', { type: 'addDirectories', directories: [target], destination: 'cliArg' }),
        { label: 'confirm restore', before: async () => listRules('cliarg-1b-after-restore-cliArg') },
        triggerCall('remove destination=session (mismatched, the grant is cliArg)', { type: 'removeDirectories', directories: [target], destination: 'session' }),
        verifyStep('verify after remove destination=session (mismatched)', 'third.txt', 'cliarg-2-after-remove-session-mismatched'),
      ];
    case 'session':
      return [
        { label: 'initial: nothing granted yet', before: async () => listRules('session-0-initial') },
        { label: 'arm the natural ask-then-grant route', before: async () => { armNaturalGrant = true; } },
        verifyStep('first ask on target grants it (canUseTool addDirectories destination=session)', 'marker.txt', 'session-1-after-natural-grant'),
        { label: 'confirm no ask now', prompt: askText('second.txt') },
        triggerCall('remove destination=session (matching)', { type: 'removeDirectories', directories: [target], destination: 'session' }),
        verifyStep('verify after remove destination=session', 'third.txt', 'session-2-after-remove-session'),
        triggerCall('restore: addDirectories destination=session (so the next removal is genuinely mismatched)', { type: 'addDirectories', directories: [target], destination: 'session' }),
        { label: 'confirm restore', before: async () => listRules('session-2b-after-restore-session') },
        triggerCall('remove destination=cliArg (mismatched, the grant is session)', { type: 'removeDirectories', directories: [target], destination: 'cliArg' }),
        verifyStep('verify after remove destination=cliArg (mismatched)', 'fourth.txt', 'session-3-after-remove-cliArg-mismatched'),
      ];
    case 'flag':
    case 'flaglive': {
      const destinations: PermissionUpdateDestination[] = ['session', 'cliArg', 'userSettings', 'projectSettings', 'localSettings'];
      const files = ['second.txt', 'third.txt', 'fourth.txt', 'raceFile.txt', 'fifth.txt'];
      const grantLive = async (): Promise<void> => {
        await run.query.applyFlagSettings({ permissions: { additionalDirectories: [target], allow: ['WebFetch(domain:proof10-hazard-probe.invalid)'] } });
      };
      const steps: Step[] =
        r === 'flag'
          ? [{ label: 'initial: options.settings grant + allow rule at start', before: async () => listRules('flag-0-initial'), prompt: askText('marker.txt') }]
          : [
              { label: 'applyFlagSettings LIVE: grant + allow rule, before any model turn', before: async () => { await grantLive(); await listRules('flaglive-0-after-applyFlagSettings-grant'); } },
              verifyStep('verify grant landed, no ask expected', 'marker.txt', 'flaglive-0b-after-verify'),
            ];
      // Every destination is tested against a FRESH grant, restored live
      // between attempts: testing all 5 sequentially without restoring
      // would test only the first destination against a real grant, since
      // that first removal already empties workspaceDirectories and every
      // later "removal" would be a no-op against nothing (a real bug in an
      // earlier version of this file, caught by review before this run).
      // The restore uses applyFlagSettings even for 'flag' (whose original
      // grant was options.settings at start): both land as source
      // 'localSettings' in list_permission_rules (see the header comment),
      // so this substitution is fair for destinations 2 through 5, not
      // identical to the original delivery route for destination 1 alone.
      destinations.forEach((d, idx) => {
        if (idx > 0) {
          steps.push({ label: `restore via applyFlagSettings LIVE before testing destination=${d}`, before: grantLive });
        }
        steps.push(triggerCall(`remove destination=${d}`, { type: 'removeDirectories', directories: [target], destination: d }));
        steps.push(verifyStep(`verify after remove destination=${d}`, files[idx], `${r}-after-remove-${d}`));
      });
      steps.push({
        label: 'restore once more, then applyFlagSettings({permissions:{additionalDirectories: []}}), the shallow-merge-replace hazard: does the allow rule survive?',
        before: async () => {
          await grantLive();
          await run.query.applyFlagSettings({ permissions: { additionalDirectories: [] } });
        },
        prompt: askText('sixth.txt'),
        after: async () => listRules(`${r}-9-after-applyFlagSettings-clear-dirs`),
      });
      return steps;
    }
    case 'race':
      return []; // handled separately below
  }
}

// ---------------------------------------------------------------------------

async function driveSteps(steps: Step[]): Promise<void> {
  let i = 0;
  // A step with no prompt is a pure control step (a direct control_request
  // like list_permission_rules, no model turn involved): run its before/after
  // back to back and advance, without sending anything or waiting for a
  // 'result' that will never come.
  const send = async (): Promise<void> => {
    for (;;) {
      const step = steps[i];
      if (!step) {
        run.end();
        return;
      }
      if (step.before) await step.before();
      if (step.prompt === undefined) {
        if (step.after) await step.after();
        note('control-step', { step: i + 1, label: step.label });
        i += 1;
        continue;
      }
      note('send', { step: i + 1, label: step.label, prompt: step.prompt });
      run.send({ type: 'user', message: { role: 'user', content: step.prompt }, parent_tool_use_id: null });
      return;
    }
  };
  await send();
  for await (const message of run.messages() as AsyncIterable<SDKMessage>) {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') note('assistant text', block.text);
        if (block.type === 'tool_use') note('tool_use', { name: block.name, input: block.input });
      }
    }
    if (message.type === 'user' && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'tool_result') {
          note('tool_result', { ts: stamp(), content: (block as { content?: unknown }).content });
        }
      }
    }
    if (message.type === 'result') {
      note('result', { subtype: message.subtype, result: 'result' in message ? message.result : undefined });
      const finishing = steps[i];
      if (finishing.after) await finishing.after();
      i += 1;
      await send();
    }
  }
}

async function driveRace(): Promise<void> {
  // Precondition: session-grant target, exactly as the 'session' route's
  // first step (arm the one-shot natural ask-then-grant route), so the
  // raceFile read needs no ask.
  armNaturalGrant = true;
  note('send', { step: 0, label: 'grant target via natural ask' });
  run.send({ type: 'user', message: { role: 'user', content: askText('marker.txt') }, parent_tool_use_id: null });
  let phase: 'grant' | 'race' | 'after' = 'grant';
  for await (const message of run.messages() as AsyncIterable<SDKMessage>) {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') note('assistant text', block.text);
        if (block.type === 'tool_use') note('tool_use', { ts: stamp(), name: block.name, input: block.input });
      }
    }
    if (message.type === 'user' && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'tool_result') {
          note('tool_result', { ts: stamp(), content: (block as { content?: unknown }).content });
        }
      }
    }
    if (message.type === 'result') {
      note('result', { ts: stamp(), phase, subtype: message.subtype });
      if (phase === 'grant') {
        await listRules('race-0-after-grant');
        phase = 'race';
        pendingUpdate = [{ type: 'removeDirectories', directories: [target], destination: 'session' }];
        triggerDelayMs = raceDelayMs;
        note('send', { step: 1, label: 'race: two Read calls in one turn' });
        run.send({
          type: 'user',
          message: {
            role: 'user',
            content: `Call the Read tool TWICE in this same turn, issuing both calls together without waiting for one result before starting the other: once on ${nextTrigger()}, once on ${join(target, 'raceFile.txt')}. Quote both results afterward.`,
          },
          parent_tool_use_id: null,
        });
      } else if (phase === 'race') {
        await listRules('race-1-after-race-turn');
        triggerDelayMs = 0;
        phase = 'after';
        note('send', { step: 2, label: 'after: re-read raceFile, expect an ask if removal took' });
        run.send({ type: 'user', message: { role: 'user', content: askText('raceFile.txt') }, parent_tool_use_id: null });
      } else {
        await listRules('race-2-after-final-read');
        run.end();
      }
    }
  }
}

if (route === 'race') {
  await driveRace();
} else {
  await driveSteps(stepsFor(route));
}
await run.done;

writeFileSync(join(run.dir, 'proof-events.json'), `${JSON.stringify(events, null, 2)}\n`);
const outDir = join(run.dir, 'api-bodies');
mkdirSync(outDir, { recursive: true });
for (const entry of existsSync(bodiesDir) ? readdirSync(bodiesDir) : []) {
  const { text } = redact(readFileSync(join(bodiesDir, entry), 'utf8'));
  writeFileSync(join(outDir, entry), text);
}

const index = join(outDir, 'index.jsonl');
const wdLines: string[] = [];
if (existsSync(index)) {
  for (const row of readFileSync(index, 'utf8').split('\n').filter(Boolean)) {
    const e = JSON.parse(row) as { query_source?: string; request_file?: string };
    if (e.query_source !== 'sdk' || !e.request_file) continue;
    const body = JSON.parse(readFileSync(join(outDir, e.request_file), 'utf8')) as { messages: { role: string; content: unknown }[] };
    const text = JSON.stringify(body.messages);
    const hits = [...text.matchAll(/(Additional working directories[^\\]*(?:\\n[^\\]*){0,4}|Primary working directory: [^\\]*)/g)].map((m) => m[0]);
    wdLines.push(`${e.request_file}: ${hits.length ? hits.join(' | ') : '(no working-directory text)'}`);
  }
}

const listCalls = events.filter((e): e is { what: string; detail: unknown } => typeof e === 'object' && e !== null && (e as { what?: string }).what?.startsWith('list_permission_rules/') === true);
// The control response wraps the payload as {subtype, request_id,
// response: {state: {...}}}; `.state` directly on the event's detail is
// always undefined, a bug caught by inspecting a real run before trusting
// this summary.
const rulesSummary = listCalls
  .map((e) => {
    const wrapped = e.detail as { response?: { state?: { workspaceDirectories?: { path: string; source: string }[]; rules?: { source: string; rule: string }[] } } };
    const state = wrapped.response?.state;
    const wd = state?.workspaceDirectories ?? [];
    const rules = state?.rules ?? [];
    return `${e.what}: workspaceDirectories=${JSON.stringify(wd)} rules=${JSON.stringify(rules.filter((r) => r.rule.includes('proof10-hazard-probe') || r.source === 'flagSettings'))}`;
  })
  .join('\n');

const askLog = events
  .filter((e): e is { what: string; detail: unknown } => typeof e === 'object' && e !== null && (e as { what?: string }).what?.startsWith('canUseTool/') === true)
  .map((e) => `${e.what} ${JSON.stringify(e.detail)}`)
  .join('\n');

const hookFired = new Set(events.filter((e) => typeof e === 'object' && e !== null && (e as { what?: string }).what?.startsWith('hook/')).map((e) => (e as { what: string }).what));

const summary = `route: ${route}\ntarget: ${target}\ntrigger: ${trigger}\n\n== list_permission_rules ==\n${rulesSummary}\n\n== canUseTool log ==\n${askLog}\n\n== working-directory text per API request (only present on a fresh 'create' thread; a 'continue' request carries no system/environment block at all, so this is a weak secondary signal beyond the first couple of turns) ==\n${wdLines.join('\n')}\n\n== hook events that fired ==\n${[...hookFired].sort().join('\n')}\n`;
writeFileSync(join(run.dir, 'summary.txt'), summary);
process.stdout.write(`\n${summary}`);
rmSync(scratch, { recursive: true, force: true });
