// A live check of the foundation: configure over stdio, launch one
// conversation, send one prompt, show the reply and what Claude Code was
// started with. It launches directly, without the bus.
//
//   printf '%s\n' '<control line>' ... | NATS_URL=... PARTICIPANT_WORLD=... PARTICIPANT_DURABLE_BUCKET=... PARTICIPANT_CONFIG_DIR=... \
//     pnpm exec tsx scripts/live-check.ts <cwd> <prompt>
//
// Like the participant, it takes the config dir's lock and starts stopping
// an earlier run's leftovers (reported on stderr), reading control lines from
// stdin (answering each on stdout) meanwhile. Once stdin ends it launches,
// which waits for the leftovers to be stopped. Linux only: the evidence comes
// from /proc.

import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionKey, SessionStoreEntry, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { beforeServing } from '../src/beforeServing.js';
import { ControlLines, runControlLines } from '../src/ControlLines.js';
import { ConversationLauncher } from '../src/ConversationLauncher.js';
import { composeConfig } from '../src/composition.js';
import { participantServices } from '../src/container.js';
import { IProcessSpawner, NodeProcessSpawner, type ProcessOptions } from '../src/ProcessSpawner.js';
import { IPublisher } from '../src/SessionStore.js';

const [cwd, prompt] = process.argv.slice(2);
if (cwd === undefined || prompt === undefined) {
  console.error('usage: live-check.ts <cwd> <prompt>');
  process.exit(2);
}

const spawned: ChildProcess[] = [];
class RecordingSpawner extends NodeProcessSpawner {
  public override spawn(command: string, args: string[], options: ProcessOptions): SpawnedProcess {
    const child = super.spawn(command, args, options);
    spawned.push(child as unknown as ChildProcess);
    return child;
  }
}

const appended: string[] = [];
class CountingPublisher implements IPublisher {
  public publish(_key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    for (const entry of entries) {
      appended.push(entry.type);
    }
    return Promise.resolve();
  }

  public route(): () => void {
    return () => {};
  }
}

const config = composeConfig(process.env, tmpdir(), process.getuid?.(), process.platform);
const services = participantServices(config, process.platform);
services.register(RecordingSpawner).as(IProcessSpawner);
services.register(CountingPublisher).as(IPublisher);
const provider = services.buildProvider();

void beforeServing(provider, process.platform, (line) => console.error(`participant: ${line}`), new AbortController().signal);
await runControlLines(process.stdin, process.stdout, provider.resolve(ControlLines));

const id = randomUUID();
const conversation = await provider.resolve(ConversationLauncher).launch({ id, cwd, additionalDirectories: [], resume: false });
conversation.send(prompt);

function statFields(pid: number): string[] {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  // Fields after the command name, which is in parentheses and may hold spaces.
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ');
}

function evidence(pid: number): Record<string, unknown> {
  const environ = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
  const value = (name: string) => environ.find((e) => e.startsWith(`${name}=`))?.slice(name.length + 1);
  const [, , pgid, sid] = statFields(pid);
  const [, , ownPgid, ownSid] = statFields(process.pid);
  return {
    pid,
    executable: readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0],
    pgid,
    sid,
    ownPgid,
    ownSid,
    ownGroup: pgid === String(pid),
    HOME: value('HOME'),
    TOWER_PARTICIPANT: value('TOWER_PARTICIPANT'),
    CLAUDE_CONFIG_DIR: value('CLAUDE_CONFIG_DIR'),
    CLAUDE_SECURESTORAGE_CONFIG_DIR: value('CLAUDE_SECURESTORAGE_CONFIG_DIR'),
    CLAUDE_CODE_SHELL_PREFIX: value('CLAUDE_CODE_SHELL_PREFIX'),
    TOWER_REAL_HOME: value('TOWER_REAL_HOME'),
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: value('CLAUDE_CODE_MAX_OUTPUT_TOKENS'),
    // The SDK sets CLAUDE_CODE_ENTRYPOINT itself (sdk-ts) when it is absent.
    parentSessionVariables: environ.filter((e) => ['CLAUDECODE', 'AI_AGENT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_PID'].includes(e.split('=')[0] ?? '')),
  };
}

let shown = false;
for await (const message of conversation.messages) {
  if (!shown && spawned[0]?.pid !== undefined) {
    console.log(JSON.stringify({ claudeCode: evidence(spawned[0].pid) }));
    shown = true;
  }
  if (message.type === 'system' && message.subtype === 'init') {
    console.log(JSON.stringify({ init: { session_id: message.session_id, model: message.model, permissionMode: message.permissionMode, cwd: message.cwd, claude_code_version: message.claude_code_version } }));
  } else if (message.type === 'assistant') {
    console.log(JSON.stringify({ assistant: message.message.content.map((block) => (block.type === 'text' ? { text: block.text } : { type: block.type })) }));
  } else if (message.type === 'result') {
    console.log(JSON.stringify({ result: { subtype: message.subtype, is_error: message.is_error, result: 'result' in message ? message.result : undefined } }));
    conversation.close();
  }
}

const child = spawned[0];
const exited = await new Promise<boolean>((resolve) => {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
    resolve(true);
    return;
  }
  const timer = setTimeout(() => resolve(false), 15000);
  child.once('exit', () => {
    clearTimeout(timer);
    resolve(true);
  });
});
if (!exited && child?.pid !== undefined) {
  // Only the Claude Code this script started, by its recorded pid.
  process.kill(child.pid, 'SIGINT');
}

const projects = join(config.configDir, 'projects');
const transcripts = existsSync(projects) ? readdirSync(projects).filter((dir) => existsSync(join(projects, dir, `${id}.jsonl`))) : [];
console.log(
  JSON.stringify({
    after: {
      conversationId: id,
      claudeCodeExited: exited,
      exitCode: child?.exitCode,
      transcriptIn: transcripts.map((dir) => join(projects, dir, `${id}.jsonl`)),
      storeAppends: appended.length,
      storeEntryTypes: [...new Set(appended)],
      privateHome: config.privateHome,
      privateHomeExists: existsSync(config.privateHome),
      privateHomeEntries: readdirSync(config.privateHome),
    },
  }),
);

// With OTEL_LOG_RAW_API_BODIES=file:<dir> in the environment (it passes
// through to Claude Code), Claude Code writes each request body there: the
// ground truth for what a conversation was actually sent with.
const bodies = process.env.OTEL_LOG_RAW_API_BODIES?.startsWith('file:') ? process.env.OTEL_LOG_RAW_API_BODIES.slice('file:'.length) : undefined;
if (bodies !== undefined && existsSync(bodies)) {
  for (const file of readdirSync(bodies).filter((name) => name.endsWith('.request.json'))) {
    const text = readFileSync(join(bodies, file), 'utf8');
    const body = JSON.parse(text) as Record<string, unknown>;
    // The main loop's request is the one that offers tools; Claude Code's
    // side requests (titles and the like) don't.
    if (Array.isArray(body.tools) && body.tools.length > 0) {
      console.log(JSON.stringify({ request: { model: body.model, max_tokens: body.max_tokens, thinking: body.thinking ?? null, output_config: body.output_config ?? null, planModeReminder: text.includes('Plan mode is active') } }));
    }
  }
}
