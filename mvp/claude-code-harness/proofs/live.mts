// Proof 4: what can change on a running Claude Code (Stephen, 26 Sep: "what
// *can* be configured during runtime, and what cannot / ie, is there
// *anything* that *must* be passed in from the start?").
//
// One run per scenario. Each scenario is one query() fed a stream of
// messages: a first turn, then for each later turn a control call on the
// running session (setModel, applyFlagSettings, ...) followed by the turn
// that should show its effect. Nothing restarts between turns.
//
// Evidence is the actual API request (OTEL_LOG_RAW_API_BODIES, as proof 1),
// what the model did (tool calls, files on disk), and what each control call
// returned. After the run the proof prints, per main-thread request, the
// fields a lever can move (model, max_tokens, thinking, output_config, the
// tool names, the system blocks, the tail of the messages) and what changed
// from the request before it.
//
//   node proofs/live.mts <model> <scenario>
//
// The scenarios (see SCENARIOS below for the exact calls and prompts):
//
//   model        setModel, then applyFlagSettings({model})
//   thinking     setMaxThinkingTokens(0), then (null, 'summarized')
//   effort       applyFlagSettings({effortLevel: 'low'}), then null
//   fast         applyFlagSettings({fastMode: true})
//   env          applyFlagSettings({env}): a variable Bash reads, and
//                CLAUDE_CODE_MAX_OUTPUT_TOKENS, which Claude Code itself reads
//   sandbox      applyFlagSettings({sandbox: {enabled: true}}), then a write
//                outside the working directory
//   permissions  an allow rule (on echo, which needed no approval anyway),
//                then a whole-tool deny rule (Bash)
//   allow        an allow rule on touch, which does need approval
//   deny-start   control: the same deny rule given at start-up
//   tools-add    an allow rule for a tool not in the start-up tool list
//   no-approver  no canUseTool: a call that needs approval
//   mode         setPermissionMode acceptEdits, plan, then bypassPermissions
//                on a session not started with allowDangerouslySkipPermissions
//   bypass       setPermissionMode bypassPermissions on a session started with
//                allowDangerouslySkipPermissions
//   hooks        applyFlagSettings({hooks}): a UserPromptSubmit hook
//   skills       a skill written into a loaded plugin mid-session;
//                reloadSkills, reloadPlugins, then skillOverrides
//   skills-start control: the same skillOverrides given at start-up
//   skills-bundled  skillOverrides on a skill bundled with Claude Code
//   skills-bundled-start  control: the same given at start-up
//   output-styles  an output style written into a loaded plugin mid-session;
//                reloadOutputStyles, then reloadPlugins, then selecting it
//   output-styles-start  control: the same style present at start-up
//   mcp          setMcpServers with an in-process server, then {}
//   prompt       applyFlagSettings agent, then outputStyle; no systemPrompt
//                option (the SDK's one-line default)
//   prompt-preset  the same on the claude_code preset (recorded, the default)
//   prompt-nosnap  the same on the claude_code preset with snapshot: false
//   cwd          the binary's set_cwd control request (not on the SDK's
//                public surface; sent through the query's request())
//   rewind       rewindFiles without file checkpointing, then with it turned
//                on through applyFlagSettings({env}); a dry run, then a real
//                rewind
//
// `node proofs/live.mts --summarise <run dir>` re-prints a run's request
// summary (summary.txt) without running anything.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createSdkMcpServer, tool, type CanUseTool, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { HarnessOptions, Run } from '../src/harness.mts';
import { startRun } from '../src/harness.mts';
import { redact, stamp } from '../src/record.mts';

const STATE_ROOT = join(homedir(), '.local', 'state', 'tower-claude-code-harness');

interface Ctx {
  run: Run;
  // A directory of the proof's own outside the working directory, fresh per
  // run: plugin files, sandbox write targets, the cwd move target.
  scratch: string;
  // The uuid each sent user message carried, in order (rewindFiles' target).
  userUuids: string[];
  note: (what: string, detail?: unknown) => void;
}

interface Step {
  // Run before the turn's prompt is sent; its result or error is recorded.
  control?: { label: string; call: (ctx: Ctx) => Promise<unknown> };
  prompt: string;
}

interface Scenario {
  options?: (ctx: { scratch: string }) => Partial<HarnessOptions>;
  setup?: (ctx: { scratch: string }) => void;
  // After the run has started, before the first message.
  prepare?: (ctx: Ctx) => void;
  steps: Step[];
  // Checked after the run: files on disk and the like.
  after?: (ctx: Ctx) => void;
}

// The approval callback most scenarios use: records every call and allows
// only the harmless commands the prompts ask for, and writes inside the
// proof's own directories.
function approver(note: Ctx['note'], allowedRoots: () => string[]): CanUseTool {
  return async (toolName, input) => {
    note('canUseTool', { toolName, input });
    if (toolName === 'Bash') {
      const command = String(input.command ?? '');
      if (/^(echo|pwd|printenv|touch|ls|cat)\b/.test(command.trim())) {
        return { behavior: 'allow', updatedInput: input };
      }
      return { behavior: 'deny', message: 'proof: only echo, pwd, printenv, touch, ls, cat are allowed' };
    }
    if (toolName === 'Write' || toolName === 'Edit' || toolName === 'Read') {
      const path = String(input.file_path ?? '');
      if (allowedRoots().some((root) => path.startsWith(root))) {
        return { behavior: 'allow', updatedInput: input };
      }
      return { behavior: 'deny', message: 'proof: outside the proof directories' };
    }
    return { behavior: 'deny', message: `proof: ${toolName} not allowed` };
  };
}

// Filled once the run exists; the approver reads it lazily.
let roots: string[] = [];
let noteRef: Ctx['note'] = () => {};

const LIST_TOOLS = 'List the names of every tool you have, comma separated, and nothing else.';

const SCENARIOS: Record<string, Scenario> = {
  model: {
    steps: [
      { prompt: 'Reply with the word ONE and nothing else.' },
      { control: { label: "setModel('claude-haiku-4-5')", call: ({ run }) => run.query.setModel('claude-haiku-4-5') }, prompt: 'Reply with the word TWO and nothing else.' },
      { control: { label: "applyFlagSettings({model: 'claude-opus-5-5'})", call: ({ run }) => run.query.applyFlagSettings({ model: 'claude-opus-5-5' }) }, prompt: 'Reply with the word THREE and nothing else.' },
    ],
  },
  thinking: {
    options: () => ({ thinking: { type: 'adaptive' } }),
    steps: [
      { prompt: 'What is 17 * 23? Reply with the number only.' },
      { control: { label: 'setMaxThinkingTokens(0)', call: ({ run }) => run.query.setMaxThinkingTokens(0) }, prompt: 'What is 19 * 29? Reply with the number only.' },
      { control: { label: "setMaxThinkingTokens(null, 'summarized')", call: ({ run }) => run.query.setMaxThinkingTokens(null, 'summarized') }, prompt: 'What is 31 * 37? Reply with the number only.' },
    ],
  },
  effort: {
    steps: [
      { prompt: 'Reply with the word ONE and nothing else.' },
      { control: { label: "applyFlagSettings({effortLevel: 'low'})", call: ({ run }) => run.query.applyFlagSettings({ effortLevel: 'low' }) }, prompt: 'Reply with the word TWO and nothing else.' },
      { control: { label: 'applyFlagSettings({effortLevel: null})', call: ({ run }) => run.query.applyFlagSettings({ effortLevel: null }) }, prompt: 'Reply with the word THREE and nothing else.' },
    ],
  },
  fast: {
    steps: [
      { prompt: 'Reply with the word ONE and nothing else.' },
      { control: { label: 'applyFlagSettings({fastMode: true})', call: ({ run }) => run.query.applyFlagSettings({ fastMode: true }) }, prompt: 'Reply with the word TWO and nothing else.' },
    ],
  },
  env: {
    options: () => ({ tools: ['Bash'], canUseTool: approver((w, d) => noteRef(w, d), () => roots) }),
    steps: [
      { prompt: 'Run `printenv PROOF_LIVE_VAR` with Bash, then reply with its output verbatim, or EMPTY if it printed nothing.' },
      {
        control: {
          label: "applyFlagSettings({env: {PROOF_LIVE_VAR: 'live-value-2', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '4096'}})",
          call: ({ run }) => run.query.applyFlagSettings({ env: { PROOF_LIVE_VAR: 'live-value-2', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '4096' } }),
        },
        prompt: 'Run `printenv PROOF_LIVE_VAR` with Bash again, then reply with its output verbatim, or EMPTY if it printed nothing.',
      },
    ],
  },
  sandbox: {
    options: () => ({ tools: ['Bash'], canUseTool: approver((w, d) => noteRef(w, d), () => roots) }),
    steps: [
      { prompt: 'Run exactly `touch OUTSIDE/probe-1` with Bash (OUTSIDE as given in the next line), then reply OK or the error text.' },
      {
        control: {
          label: 'applyFlagSettings({sandbox: {enabled: true, allowUnsandboxedCommands: false}})',
          call: ({ run }) => run.query.applyFlagSettings({ sandbox: { enabled: true, allowUnsandboxedCommands: false } }),
        },
        prompt: 'Run exactly `touch OUTSIDE/probe-2` with Bash (OUTSIDE as given in the next line), then reply OK or the error text.',
      },
    ],
    after: ({ scratch, note }) => {
      note('files', { 'probe-1': existsSync(join(scratch, 'outside', 'probe-1')), 'probe-2': existsSync(join(scratch, 'outside', 'probe-2')) });
    },
  },
  permissions: {
    options: () => ({ tools: ['Bash', 'Read'], canUseTool: approver((w, d) => noteRef(w, d), () => roots) }),
    steps: [
      { prompt: 'Run `echo one` with Bash, then reply with its output.' },
      {
        control: { label: "applyFlagSettings({permissions: {allow: ['Bash(echo:*)']}})", call: ({ run }) => run.query.applyFlagSettings({ permissions: { allow: ['Bash(echo:*)'] } }) },
        prompt: 'Run `echo two` with Bash, then reply with its output.',
      },
      {
        control: { label: "applyFlagSettings({permissions: {deny: ['Bash']}})", call: ({ run }) => run.query.applyFlagSettings({ permissions: { deny: ['Bash'] } }) },
        prompt: `${LIST_TOOLS} Then, if you have a Bash tool, run \`echo three\` with it.`,
      },
    ],
  },
  // The permissions scenario's echo turned out not to need approval (Claude
  // Code allows read-only commands itself), so its allow rule showed nothing.
  // touch does need it.
  allow: {
    options: () => ({ tools: ['Bash'], canUseTool: approver((w, d) => noteRef(w, d), () => roots) }),
    steps: [
      { prompt: 'Run `touch p1.txt` with Bash in your working directory, then reply OK or the error text.' },
      {
        control: { label: "applyFlagSettings({permissions: {allow: ['Bash(touch:*)']}})", call: ({ run }) => run.query.applyFlagSettings({ permissions: { allow: ['Bash(touch:*)'] } }) },
        prompt: 'Run `touch p2.txt` with Bash in your working directory, then reply OK or the error text.',
      },
    ],
    after: ({ run, note }) => {
      note('files', Object.fromEntries(['p1.txt', 'p2.txt'].map((f) => [f, existsSync(join(run.cwd, f))])));
    },
  },
  // Control for the permissions scenario: does a whole-tool deny rule given
  // at start-up hide the tool?
  'deny-start': {
    options: () => ({ tools: ['Bash', 'Read'], settings: { permissions: { deny: ['Bash'] } }, canUseTool: approver((w, d) => noteRef(w, d), () => roots) }),
    steps: [{ prompt: LIST_TOOLS }],
  },
  // Control for the skills scenario: does skillOverrides given at start-up
  // hide the skill?
  'skills-start': {
    setup: ({ scratch }) => {
      writePlugin(scratch);
      writeSkill(scratch, 'proof-skill-alpha', 'Dummy skill present from start-up. Does nothing.');
      writeSkill(scratch, 'proof-skill-beta', 'Second dummy skill present from start-up. Does nothing.');
    },
    options: ({ scratch }) => ({
      plugins: [{ type: 'local', path: join(scratch, 'plugin') }],
      settings: { skillOverrides: { 'tower-proof-live:proof-skill-alpha': 'off', 'proof-skill-alpha': 'off' } },
    }),
    steps: [{ prompt: 'List the names of every skill you have whose name contains "proof-skill", comma separated, or NONE.' }],
  },
  // No canUseTool: the SDK starts the binary without --permission-prompt-tool
  // stdio. What happens to a call that needs approval?
  'no-approver': {
    options: () => ({ tools: ['Bash'] }),
    steps: [{ prompt: 'Run `touch q1.txt` with Bash in your working directory, then reply OK or the error text.' }],
    after: ({ run, note }) => {
      note('files', { 'q1.txt': existsSync(join(run.cwd, 'q1.txt')) });
    },
  },
  'tools-add': {
    options: () => ({ tools: ['Read'], canUseTool: approver((w, d) => noteRef(w, d), () => roots) }),
    steps: [
      { prompt: LIST_TOOLS },
      { control: { label: "applyFlagSettings({permissions: {allow: ['Bash']}})", call: ({ run }) => run.query.applyFlagSettings({ permissions: { allow: ['Bash'] } }) }, prompt: LIST_TOOLS },
    ],
  },
  mode: {
    options: () => ({ tools: ['Write'], canUseTool: approver((w, d) => noteRef(w, d), () => roots) }),
    steps: [
      { prompt: 'Use the Write tool to create a.txt in your working directory containing the word alpha, then reply OK.' },
      { control: { label: "setPermissionMode('acceptEdits')", call: ({ run }) => run.query.setPermissionMode('acceptEdits') }, prompt: 'Use the Write tool to create b.txt in your working directory containing the word beta, then reply OK.' },
      { control: { label: "setPermissionMode('plan')", call: ({ run }) => run.query.setPermissionMode('plan') }, prompt: 'Reply with the word PLAN and nothing else.' },
      { control: { label: "setPermissionMode('bypassPermissions')", call: ({ run }) => run.query.setPermissionMode('bypassPermissions') }, prompt: 'Use the Write tool to create c.txt in your working directory containing the word gamma, then reply OK.' },
    ],
    after: ({ run, note }) => {
      note('files', Object.fromEntries(['a.txt', 'b.txt', 'c.txt'].map((f) => [f, existsSync(join(run.cwd, f))])));
    },
  },
  bypass: {
    options: () => ({ tools: ['Write'], allowDangerouslySkipPermissions: true, canUseTool: approver((w, d) => noteRef(w, d), () => roots) }),
    steps: [
      { prompt: 'Use the Write tool to create d.txt in your working directory containing the word delta, then reply OK.' },
      { control: { label: "setPermissionMode('bypassPermissions')", call: ({ run }) => run.query.setPermissionMode('bypassPermissions') }, prompt: 'Use the Write tool to create e.txt in your working directory containing the word epsilon, then reply OK.' },
    ],
    after: ({ run, note }) => {
      note('files', Object.fromEntries(['d.txt', 'e.txt'].map((f) => [f, existsSync(join(run.cwd, f))])));
    },
  },
  hooks: {
    steps: [
      { prompt: 'Reply with the word ONE and nothing else.' },
      {
        control: {
          label: "applyFlagSettings({hooks: {UserPromptSubmit: [{hooks: [{type: 'command', command: 'echo PROOF-HOOK-MARKER-7731'}]}]}})",
          call: ({ run }) => run.query.applyFlagSettings({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo PROOF-HOOK-MARKER-7731' }] }] } }),
        },
        prompt: 'If your context contains a marker of the form PROOF-HOOK-MARKER-<digits>, reply with it; otherwise reply NONE.',
      },
    ],
  },
  skills: {
    setup: ({ scratch }) => {
      writePlugin(scratch);
      writeSkill(scratch, 'proof-skill-alpha', 'Dummy skill present from start-up. Does nothing.');
    },
    options: ({ scratch }) => ({ plugins: [{ type: 'local', path: join(scratch, 'plugin') }] }),
    steps: [
      { prompt: 'List the names of every skill you have whose name contains "proof-skill", comma separated, or NONE.' },
      {
        control: {
          label: 'write proof-skill-beta into the plugin, then reloadSkills()',
          call: async ({ run, scratch }) => {
            writeSkill(scratch, 'proof-skill-beta', 'Dummy skill written while the session runs. Does nothing.');
            return run.query.reloadSkills();
          },
        },
        prompt: 'List the names of every skill you have whose name contains "proof-skill", comma separated, or NONE.',
      },
      { control: { label: 'reloadPlugins()', call: ({ run }) => run.query.reloadPlugins() }, prompt: 'List the names of every skill you have whose name contains "proof-skill", comma separated, or NONE.' },
      {
        control: {
          label: "applyFlagSettings({skillOverrides: {'tower-proof-live:proof-skill-alpha': 'off', 'proof-skill-alpha': 'off'}})",
          call: ({ run }) => run.query.applyFlagSettings({ skillOverrides: { 'tower-proof-live:proof-skill-alpha': 'off', 'proof-skill-alpha': 'off' } }),
        },
        prompt: 'List the names of every skill you have whose name contains "proof-skill", comma separated, or NONE.',
      },
    ],
  },
  // skillOverrides skips plugin skills (2.1.282: its lookup returns early
  // for source 'plugin'), which is what skills-start showed. These two use a
  // skill bundled with Claude Code instead.
  'skills-bundled': {
    steps: [
      { prompt: 'Is a skill named "simplify" in your skill listing? Reply YES or NO.' },
      {
        control: { label: "applyFlagSettings({skillOverrides: {simplify: 'off'}})", call: ({ run }) => run.query.applyFlagSettings({ skillOverrides: { simplify: 'off' } }) },
        prompt: 'Is a skill named "simplify" in your skill listing now? Reply YES or NO, then name what told you so.',
      },
    ],
  },
  'skills-bundled-start': {
    options: () => ({ settings: { skillOverrides: { simplify: 'off' } } }),
    steps: [{ prompt: 'Is a skill named "simplify" in your skill listing? Reply YES or NO.' }],
  },
  // An output style written into a loaded plugin mid-session, then
  // reloadOutputStyles and selecting it; then reloadPlugins first.
  'output-styles': {
    setup: ({ scratch }) => {
      writePlugin(scratch);
    },
    options: ({ scratch }) => ({ plugins: [{ type: 'local', path: join(scratch, 'plugin') }] }),
    steps: [
      { prompt: 'Reply with the word ONE and nothing else.' },
      {
        control: {
          label: 'write output-styles/proof-style.md into the plugin, reloadOutputStyles(), then applyFlagSettings({outputStyle: <the listed name containing proof-style>})',
          call: async ({ run, scratch }) => {
            writeStyle(scratch);
            return selectStyle(run, await run.query.reloadOutputStyles());
          },
        },
        prompt: 'Reply with the word TWO, following your output style.',
      },
      {
        control: {
          label: 'reloadPlugins(), reloadOutputStyles(), then applyFlagSettings({outputStyle: <the listed name containing proof-style>})',
          call: async ({ run }) => {
            const plugins = await run.query.reloadPlugins();
            const selected = await selectStyle(run, await run.query.reloadOutputStyles());
            return { pluginNames: plugins.plugins?.map((p) => p.name), ...selected };
          },
        },
        prompt: 'Reply with the word THREE, following your output style.',
      },
    ],
  },
  // Control for output-styles: the same plugin style present at start-up.
  'output-styles-start': {
    setup: ({ scratch }) => {
      writePlugin(scratch);
      writeStyle(scratch);
    },
    options: ({ scratch }) => ({ plugins: [{ type: 'local', path: join(scratch, 'plugin') }] }),
    steps: [
      { prompt: 'Reply with the word ONE and nothing else.' },
      {
        control: { label: 'reloadOutputStyles(), then applyFlagSettings({outputStyle: <the listed name containing proof-style>})', call: async ({ run }) => selectStyle(run, await run.query.reloadOutputStyles()) },
        prompt: 'Reply with the word TWO, following your output style.',
      },
    ],
  },
  mcp: {
    steps: [
      { prompt: LIST_TOOLS },
      {
        control: {
          label: "setMcpServers({proofsrv: in-process server with tool 'probe_tool'})",
          call: ({ run }) =>
            run.query.setMcpServers({
              proofsrv: createSdkMcpServer({
                name: 'proofsrv',
                tools: [tool('probe_tool', 'Returns the word PROBED. For the tower proof harness.', {}, async () => ({ content: [{ type: 'text', text: 'PROBED' }] }))],
              }),
            }),
        },
        prompt: LIST_TOOLS,
      },
      { control: { label: 'setMcpServers({})', call: ({ run }) => run.query.setMcpServers({}) }, prompt: LIST_TOOLS },
    ],
  },
  prompt: promptScenario('none'),
  'prompt-preset': promptScenario('preset'),
  'prompt-nosnap': promptScenario('preset-nosnap'),
  cwd: {
    setup: ({ scratch }) => {
      mkdirSync(join(scratch, 'moved-cwd'), { recursive: true });
    },
    options: () => ({ tools: ['Bash'], canUseTool: approver((w, d) => noteRef(w, d), () => roots) }),
    steps: [
      { prompt: 'Run `pwd` with Bash, then reply with its output and, separately, the primary working directory your environment information names.' },
      {
        control: {
          label: 'request({subtype: set_cwd, path: <scratch>/moved-cwd}), repeated with trust_accepted if it answers needs_trust',
          call: async ({ run, scratch }) => {
            // Not on the SDK's public surface: the binary handles set_cwd
            // (2.1.282), the SDK's Query only sends what its methods name.
            // Its private request() sends any control request.
            const request = (run.query as unknown as { request: (r: Record<string, unknown>) => Promise<unknown> }).request.bind(run.query);
            const path = join(scratch, 'moved-cwd');
            // The answer comes back wrapped: {subtype, request_id, response}.
            const first = (await request({ subtype: 'set_cwd', path })) as { response?: { status?: string; directory?: string } };
            if (first?.response?.status === 'needs_trust') {
              const second = await request({ subtype: 'set_cwd', path, trust_accepted: true, trusted_directory: first.response.directory });
              return { first, second };
            }
            return { first };
          },
        },
        prompt: 'Run `pwd` with Bash, then reply with its output and, separately, the primary working directory your environment information names now.',
      },
    ],
  },
  rewind: {
    // The working directory is reused across runs; r1.txt must not exist yet.
    prepare: ({ run }) => {
      rmSync(join(run.cwd, 'r1.txt'), { force: true });
    },
    options: () => ({ tools: ['Write'], permissionMode: 'acceptEdits', canUseTool: approver((w, d) => noteRef(w, d), () => roots) }),
    steps: [
      { prompt: 'Use the Write tool to create r1.txt in your working directory containing the word one, then reply OK.' },
      {
        control: {
          label: "rewindFiles(<turn 1 user uuid>, {dryRun: true}); then applyFlagSettings({env: {CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: '1'}})",
          call: async ({ run, userUuids }) => {
            let before: unknown;
            try {
              before = await run.query.rewindFiles(userUuids[0], { dryRun: true });
            } catch (err) {
              before = { threw: err instanceof Error ? err.message : String(err) };
            }
            await run.query.applyFlagSettings({ env: { CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: '1' } });
            return { rewindBeforeEnable: before, turn1Uuid: userUuids[0] };
          },
        },
        prompt: 'Use the Write tool to overwrite r1.txt in your working directory with the word two, then reply OK.',
      },
      {
        control: {
          label: 'rewindFiles(<turn 2 user uuid>, {dryRun: true})',
          call: async ({ run, userUuids }) => {
            try {
              return { turn2Uuid: userUuids[1], result: await run.query.rewindFiles(userUuids[1], { dryRun: true }) };
            } catch (err) {
              return { turn2Uuid: userUuids[1], threw: err instanceof Error ? err.message : String(err) };
            }
          },
        },
        prompt: 'Reply with the word DONE and nothing else.',
      },
      {
        control: {
          label: 'rewindFiles(<turn 2 user uuid>), then read r1.txt',
          call: async ({ run, userUuids }) => {
            const result = await run.query.rewindFiles(userUuids[1]);
            return { result, r1: readFileSync(join(run.cwd, 'r1.txt'), 'utf8') };
          },
        },
        prompt: 'Reply with the word DONE and nothing else.',
      },
    ],
  },
};

// systemPrompt: 'none' passes none (the SDK's own one-line default),
// 'preset' the claude_code preset (recorded, the default), 'preset-nosnap'
// the preset with snapshot: false.
function promptScenario(systemPrompt: 'none' | 'preset' | 'preset-nosnap'): Scenario {
  return {
    options: () => ({
      agents: {
        'proof-agent': {
          description: 'Agent for the tower proof harness.',
          prompt: 'You are PROOF-AGENT-7719. When asked for your agent marker, reply PROOF-AGENT-7719.',
        },
      },
      ...(systemPrompt === 'preset' ? { systemPrompt: { type: 'preset', preset: 'claude_code' } } : {}),
      ...(systemPrompt === 'preset-nosnap' ? { systemPrompt: { type: 'preset', preset: 'claude_code', snapshot: false } } : {}),
    }),
    steps: [
      { prompt: 'If your instructions name an agent marker of the form PROOF-AGENT-<digits>, reply with it; otherwise reply NONE.' },
      {
        control: { label: "applyFlagSettings({agent: 'proof-agent'})", call: ({ run }) => run.query.applyFlagSettings({ agent: 'proof-agent' }) },
        prompt: 'If your instructions name an agent marker of the form PROOF-AGENT-<digits>, reply with it; otherwise reply NONE.',
      },
      {
        control: { label: "applyFlagSettings({agent: null, outputStyle: 'Explanatory'})", call: ({ run }) => run.query.applyFlagSettings({ agent: null, outputStyle: 'Explanatory' }) },
        prompt: 'Name the output style your instructions ask you to use, if any, in one line.',
      },
    ],
  };
}

function writeStyle(scratch: string): void {
  const dir = join(scratch, 'plugin', 'output-styles');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'proof-style.md'), '---\nname: proof-style\ndescription: Proof 4 output style.\n---\n\nEnd every reply with the marker PROOF-STYLE-4411 on its own line.\n');
}

async function selectStyle(run: Run, reloaded: { available_output_styles: string[] }): Promise<Record<string, unknown>> {
  const name = reloaded.available_output_styles.find((n) => n.includes('proof-style'));
  if (name) {
    await run.query.applyFlagSettings({ outputStyle: name });
  }
  return { available: reloaded.available_output_styles, selected: name ?? null };
}

function writePlugin(scratch: string): void {
  const dir = join(scratch, 'plugin', '.claude-plugin');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), `${JSON.stringify({ name: 'tower-proof-live', description: 'Proof 4 plugin: skills added while the session runs.', version: '0.0.0' }, null, 2)}\n`);
}

function writeSkill(scratch: string, name: string, description: string): void {
  const dir = join(scratch, 'plugin', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nDummy skill for the tower Claude Code harness, proof 4. It has no task; don't use it.\n`);
}

// `node proofs/live.mts --summarise <run dir>` re-prints an earlier run's
// request summary without running anything.
if (process.argv[2] === '--summarise' && process.argv[3]) {
  process.stdout.write(`${summarise(process.argv[3])}\n`);
  process.exit(0);
}

const [model, scenarioName] = process.argv.slice(2);
const scenario = SCENARIOS[scenarioName ?? ''];
if (!model || !scenario) {
  process.stderr.write(`usage: node proofs/live.mts <model> <${Object.keys(SCENARIOS).join('|')}>\n`);
  process.exit(2);
}

const name = `live-${scenarioName}`;
const runStamp = stamp().replace(/[:.]/g, '');
const scratch = join(STATE_ROOT, 'proof-4', `${runStamp}-${name}`);
mkdirSync(join(scratch, 'outside'), { recursive: true });
const bodiesDir = join(STATE_ROOT, 'api-bodies', `${runStamp}-${name}`);
mkdirSync(bodiesDir, { recursive: true });
const debugFile = join(bodiesDir, 'debug.log');

scenario.setup?.({ scratch });

const options: HarnessOptions = {
  model,
  debugFile,
  env: { ...process.env, OTEL_LOG_RAW_API_BODIES: `file:${bodiesDir}` },
  ...(scenario.options?.({ scratch }) ?? {}),
};

const run = startRun({ name, options });
const proofEvents = join(run.dir, 'proof-events.jsonl');
const note: Ctx['note'] = (what, detail) => {
  const line = { ts: stamp(), what, ...(detail === undefined ? {} : { detail }) };
  appendFileSync(proofEvents, `${redact(JSON.stringify(line)).text}\n`);
  process.stdout.write(`[${what}] ${detail === undefined ? '' : JSON.stringify(detail)}\n`);
};
noteRef = note;
roots = [run.cwd, scratch];
const ctx: Ctx = { run, scratch, userUuids: [], note };

process.stdout.write(`run dir: ${run.dir}\nmodel: ${model}\nscenario: ${scenarioName}\nscratch: ${scratch}\nworking dir: ${run.cwd}\n`);

let stepIndex = 0;
let line = 0;

const send = (prompt: string): void => {
  const text = prompt.replaceAll('OUTSIDE', join(scratch, 'outside')) + (prompt.includes('OUTSIDE') ? `\nOUTSIDE is ${join(scratch, 'outside')}` : '');
  const uuid = randomUUID();
  ctx.userUuids.push(uuid);
  note('send', { step: stepIndex + 1, uuid, text });
  run.send({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, uuid });
};

scenario.prepare?.(ctx);
send(scenario.steps[0].prompt);

for await (const message of run.messages() as AsyncIterable<SDKMessage>) {
  line += 1;
  if (message.type === 'system' && message.subtype === 'init') {
    note('init', { line, model: message.model, session_id: message.session_id, permissionMode: message.permissionMode, cwd: message.cwd, tools: message.tools, skills: message.skills });
  } else if (message.type === 'system') {
    note(`system:${message.subtype}`, { line });
  }
  if (message.type === 'assistant') {
    for (const block of message.message.content) {
      if (block.type === 'text') {
        note('assistant-text', { line, text: block.text });
      } else if (block.type === 'tool_use') {
        note('assistant-tool_use', { line, name: block.name, input: block.input });
      } else if (block.type === 'thinking') {
        note('assistant-thinking', { line, chars: block.thinking.length });
      }
    }
  }
  if (message.type === 'user' && Array.isArray(message.message.content)) {
    for (const block of message.message.content) {
      if (typeof block === 'object' && block && 'type' in block && block.type === 'tool_result') {
        note('tool_result', { line, content: JSON.stringify(block.content).slice(0, 400), is_error: (block as { is_error?: boolean }).is_error });
      }
    }
  }
  if (message.type === 'result') {
    note('result', { line, step: stepIndex + 1, subtype: message.subtype, is_error: message.is_error, modelUsage: Object.keys(message.modelUsage ?? {}) });
    stepIndex += 1;
    if (stepIndex < scenario.steps.length) {
      const step = scenario.steps[stepIndex];
      if (step.control) {
        try {
          const result = await step.control.call(ctx);
          note('control', { step: stepIndex + 1, label: step.control.label, ok: true, result: result ?? null });
        } catch (err) {
          note('control', { step: stepIndex + 1, label: step.control.label, ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      }
      send(step.prompt);
    } else {
      run.end();
    }
  }
}

let failed = false;
try {
  await run.done;
} catch (err) {
  failed = true;
  note('run-failed', { error: err instanceof Error ? err.message : String(err) });
}
scenario.after?.(ctx);

// Copy the bodies and the debug log into the run directory, redacted.
const outDir = join(run.dir, 'api-bodies');
mkdirSync(outDir, { recursive: true });
for (const entry of existsSync(bodiesDir) ? readdirSync(bodiesDir) : []) {
  const { text } = redact(readFileSync(join(bodiesDir, entry), 'utf8'));
  writeFileSync(entry === 'debug.log' ? join(run.dir, 'debug.log') : join(outDir, entry), text);
}

writeFileSync(join(run.dir, 'summary.txt'), `${redact(summarise(run.dir)).text}\n`);
process.stdout.write(`\n${readFileSync(join(run.dir, 'summary.txt'), 'utf8')}`);

// Per main-thread request: the fields a lever can move, and what changed
// from the request before it.
//
// With the message-threads beta, a request either creates a thread (the full
// tools, system and messages) or continues one (thread {type: 'continue'}):
// then it carries only the messages added since, and a field it leaves out
// (tools) is the thread's, unchanged. So each request is compared with the
// thread's state as the requests so far have built it.
function summarise(runDir: string): string {
  type Tool = { name: string; description?: string };
  type Body = { model?: string; max_tokens?: number; thinking?: unknown; output_config?: unknown; tools?: Tool[]; system?: { text: string }[]; messages?: { role: string; content: unknown }[]; thread?: { type?: string }; [k: string]: unknown };
  const lines: string[] = [];
  const out = (s: string): void => {
    lines.push(s);
  };
  const bodies = join(runDir, 'api-bodies');
  const indexPath = join(bodies, 'index.jsonl');
  if (!existsSync(indexPath)) {
    return 'no index.jsonl: no request bodies were written';
  }
  const index = readFileSync(indexPath, 'utf8').trim().split('\n').filter(Boolean);
  let tools: Tool[] | undefined;
  let system: { text: string }[] | undefined;
  let betas: unknown;
  let messageCount = 0;
  index.forEach((raw, i) => {
    const entry = JSON.parse(raw) as { query_source?: string; model?: string; request_file?: string };
    if (entry.query_source !== 'sdk') {
      out(`index.jsonl line ${i + 1}: source=${entry.query_source} model=${entry.model} (not main thread)`);
      return;
    }
    const file = entry.request_file ? join(bodies, entry.request_file) : '';
    if (!file || !existsSync(file)) {
      out(`index.jsonl line ${i + 1}: request file missing`);
      return;
    }
    const body = JSON.parse(readFileSync(file, 'utf8')) as Body;
    const continues = body.thread?.type === 'continue';
    const extraKeys = Object.keys(body).filter((k) => !['model', 'messages', 'system', 'tools', 'betas', 'metadata', 'max_tokens', 'thinking', 'context_management', 'output_config', 'thread', 'diagnostics', 'stream'].includes(k));
    out(`index.jsonl line ${i + 1}: ${entry.request_file}`);
    out(`  thread=${JSON.stringify(body.thread)} messages=${body.messages?.length ?? 0} tools=${body.tools ? body.tools.length : 'absent'} system=${body.system ? body.system.length : 'absent'}`);
    out(`  model=${body.model} max_tokens=${body.max_tokens} thinking=${JSON.stringify(body.thinking)} output_config=${JSON.stringify(body.output_config)} extra keys=${JSON.stringify(Object.fromEntries(extraKeys.map((k) => [k, body[k]])))}`);
    if (JSON.stringify(betas) !== JSON.stringify(body.betas)) {
      const before = new Set((betas as string[] | undefined) ?? []);
      const after = new Set((body.betas as string[] | undefined) ?? []);
      out(`  betas: +[${[...after].filter((b) => !before.has(b)).join(',')}] -[${[...before].filter((b) => !after.has(b)).join(',')}]`);
      betas = body.betas;
    }
    if (body.tools) {
      const names = body.tools.map((t) => t.name);
      if (tools) {
        const prevNames = tools.map((t) => t.name);
        const changedDesc = body.tools.filter((t) => {
          const p = tools?.find((q) => q.name === t.name);
          return p && p.description !== t.description;
        });
        out(`  tools vs thread: +[${names.filter((n) => !prevNames.includes(n)).join(',')}] -[${prevNames.filter((n) => !names.includes(n)).join(',')}] description changed [${changedDesc.map((t) => t.name).join(',')}]`);
        for (const t of changedDesc) {
          out(`    ${t.name} description: ${firstDiff(tools.find((q) => q.name === t.name)?.description ?? '', t.description ?? '')}`);
        }
      }
      out(`  tools=${names.join(',')}`);
      tools = body.tools;
    } else {
      out(`  tools: ${continues ? 'absent, the thread keeps its own' : 'absent'}`);
    }
    if (body.system) {
      body.system.forEach((b, j) => {
        const p = system?.[j]?.text;
        if (system && p !== b.text) {
          out(`  system[${j}] vs thread (${p?.length ?? 'none'} -> ${b.text.length}): ${firstDiff(p ?? '', b.text)}`);
        }
      });
      out(`  system blocks=${body.system.map((b) => `${b.text.length}:${createHash('sha256').update(b.text).digest('hex').slice(0, 8)}`).join(' ')}`);
      system = body.system;
    }
    // A continuing request carries only its new messages; a creating one
    // carries all of them, and the new ones are those past the thread's count.
    const msgs = body.messages ?? [];
    const from = continues ? 0 : Math.min(messageCount, msgs.length);
    msgs.slice(from).forEach((m, k) => {
      const blocks = typeof m.content === 'string' ? [{ type: 'string', text: m.content }] : (m.content as { type: string; text?: string; content?: unknown; name?: string; input?: unknown }[]);
      for (const b of blocks) {
        const text = b.text ?? (b.type === 'tool_result' ? JSON.stringify(b.content) : b.type === 'tool_use' ? `${b.name} ${JSON.stringify(b.input)}` : '');
        out(`  messages[${from + k}] ${m.role}/${b.type}: ${text.replace(/\s+/g, ' ').slice(0, 700)}`);
      }
    });
    messageCount = continues ? messageCount + msgs.length : msgs.length;
  });
  return lines.join('\n');
}

function firstDiff(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) {
    i += 1;
  }
  return `at ${i}: ${JSON.stringify(a.slice(Math.max(0, i - 40), i + 200))} -> ${JSON.stringify(b.slice(Math.max(0, i - 40), i + 200))}`;
}

if (failed) {
  process.exitCode = 1;
}
