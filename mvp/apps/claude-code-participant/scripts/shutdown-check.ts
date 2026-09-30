// A live check of shutdown: the participant as main.ts runs it, plus one
// conversation launched and sent a prompt, since launching has no trigger of
// its own until the `service` request exists. Everything it shows goes to
// stderr, stamped with the time since start, beside shutdown's own lines:
// the control lines it applied, Claude Code's pid and process group, the
// commands Claude Code starts, and the messages that come back.
//
//   NATS_URL=... PARTICIPANT_CONFIG_DIR=... \
//     node --import tsx scripts/shutdown-check.ts <cwd> <control-lines-file> <prompt> [<id to resume>]
//
// The control lines in the file are applied before the launch. The config
// dir is then locked and scanned for leftovers, and stdin served, exactly as
// main.ts does it, so closing stdin is a trigger. Linux only: the pids and
// groups come from /proc.

import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { beforeServing } from '../src/beforeServing.js';
import { ClaudeCodeSpawner } from '../src/ClaudeCodeSpawner.js';
import { ControlLines } from '../src/ControlLines.js';
import { ConversationLauncher } from '../src/ConversationLauncher.js';
import { composeConfig } from '../src/composition.js';
import { participantServices } from '../src/container.js';
import type { ChildProcessHandle } from '../src/ProcessSpawner.js';
import { runParticipant } from '../src/run.js';
import { Shutdown } from '../src/Shutdown.js';

const [cwd, linesFile, prompt, resumeId] = process.argv.slice(2);
if (cwd === undefined || linesFile === undefined || prompt === undefined) {
  console.error('usage: shutdown-check.ts <cwd> <control-lines-file> <prompt> [<id to resume>]');
  process.exit(2);
}

const started = Date.now();
const writeError = console.error.bind(console);
console.error = (...args: unknown[]) => writeError(`[+${String(Date.now() - started).padStart(6)} ms]`, ...args);
const show = (what: string, value: unknown) => console.error(`check: ${what} ${JSON.stringify(value)}`);
process.on('exit', (code) => show('participant exiting', { code }));

const spawned: ChildProcess[] = [];
class RecordingSpawner extends ClaudeCodeSpawner {
  public override spawn(options: SpawnOptions): ChildProcessHandle {
    const child = super.spawn(options);
    spawned.push(child as unknown as ChildProcess);
    return child;
  }
}

const services = participantServices(composeConfig(process.env, tmpdir(), process.getuid?.()));
services.register(RecordingSpawner).as(ClaudeCodeSpawner);
const provider = services.buildProvider();

const lines = provider.resolve(ControlLines);
for (const line of readFileSync(linesFile, 'utf8').split('\n')) {
  if (line.trim() !== '') {
    show('control line', { line: JSON.parse(line), reply: lines.handle(line) });
  }
}

void beforeServing(provider, process.platform, (line) => console.error(`participant: ${line}`), provider.resolve(Shutdown).begun);
runParticipant(provider);
show('participant', { pid: process.pid, pgid: statFields(process.pid)[4] });

function statFields(pid: number): string[] {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  // Fields after the command name, which is in parentheses and may hold spaces.
  return [String(pid), stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')')), ...stat.slice(stat.lastIndexOf(')') + 2).split(' ')];
}

/** Every process descended from `root`, with its group and session. */
function descendants(root: number): { pid: number; pgid: string; sid: string; command: string }[] {
  const parents = new Map<number, number>();
  for (const entry of readdirSync('/proc')) {
    if (/^\d+$/.test(entry)) {
      try {
        parents.set(Number(entry), Number(statFields(Number(entry))[3]));
      } catch {
        // gone while listing
      }
    }
  }
  const found: { pid: number; pgid: string; sid: string; command: string }[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const parent = queue.shift() as number;
    for (const [pid, ppid] of parents) {
      if (ppid === parent) {
        queue.push(pid);
        try {
          const fields = statFields(pid);
          found.push({ pid, pgid: fields[4] ?? '?', sid: fields[5] ?? '?', command: readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim().slice(0, 120) });
        } catch {
          // gone while listing
        }
      }
    }
  }
  return found;
}

void (async () => {
  // Launching waits for the leftover scan, so it isn't a top-level await: a
  // shutdown before the scan ends would leave that pending.
  const id = resumeId ?? randomUUID();
  const conversation = await provider.resolve(ConversationLauncher).launch({ id, cwd, additionalDirectories: [], resume: resumeId !== undefined });
  show('conversation', { id, resume: resumeId !== undefined });
  conversation.send(prompt);
  let shown = false;
  for await (const message of conversation.messages) {
    const child = spawned[0];
    if (!shown && child?.pid !== undefined) {
      show('claude code', { pid: child.pid, pgid: statFields(child.pid)[4], sid: statFields(child.pid)[5] });
      child.once('exit', (code, signal) => show('claude code exited', { code, signal }));
      shown = true;
    }
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') {
          show('assistant text', block.text);
        } else if (block.type === 'tool_use') {
          show('assistant tool_use', { name: block.name, input: block.input });
          const pid = child?.pid;
          if (pid !== undefined) {
            setTimeout(() => show('claude code descendants', descendants(pid)), 1500).unref();
          }
        }
      }
    } else if (message.type === 'user' && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (typeof block === 'object' && block.type === 'tool_result') {
          show('tool result', typeof block.content === 'string' ? block.content.slice(0, 200) : block.content);
        }
      }
    } else if (message.type === 'result') {
      show('result', { subtype: message.subtype, is_error: message.is_error });
    }
  }
  show('messages', 'ended');
})().catch((err: unknown) => show('messages failed', err instanceof Error ? err.message : String(err)));
