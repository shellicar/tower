// A live check of who each published message says wrote it: it starts the
// participant as main.ts runs it, in a world and config dir of its own made
// for the run, configures it over stdin, and drives it from a second NATS
// connection the way tower would. One say asks Claude to start a background
// command and end its turn; the command finishes after the turn has ended, so
// Claude Code opens a turn of its own with the task-finished notice. A second
// say does the same with a background agent. It shows
// each message published, with its role, `from` and the first 70 characters
// of its first text block, then the shape of every entry in Claude Code's
// record: its keys and a few fields, the `origin` whole, which for a
// handed-back report holds the report's text.
//
//   NATS_URL=nats://127.0.0.1:31416 node --import tsx scripts/author-check.ts
//
// Run it through author-check.sh, which broker-run starts the test broker
// around. Everything it shows goes to stdout as one JSON object per line; the
// participant's own diagnostics go to stderr.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { connect } from '@nats-io/transport-node';

const natsUrl = process.env.NATS_URL;
if (natsUrl === undefined || natsUrl === '') {
  console.error('usage: NATS_URL=... author-check.ts');
  process.exit(2);
}

const world = `author-check-${randomUUID().slice(0, 8)}`;
const configDir = mkdtempSync(join(tmpdir(), 'author-check-config-'));
const cwd = mkdtempSync(join(tmpdir(), 'author-check-cwd-'));
const bucket = 'durable';

const started = Date.now();
const show = (what: string, value: unknown = {}) => console.log(JSON.stringify({ at: Date.now() - started, [what]: value }));
show('setup', { world, configDir, cwd });

const CONTROL_LINES = [{ model: { name: 'claude-sonnet-5-5', maxTokens: 16000, thinking: 'adaptive', thinkingDisplay: 'summarized', effort: 'low' } }, { system: { preset: true } }, { permissionMode: 'auto' }, { claudeSettings: { sandbox: { enabled: true, autoAllowBashIfSandboxed: true } } }];

const conversationId = randomUUID();
const changesPrefix = `conv.v2.${conversationId}.changes.`;
type Change = { subject: string; body: Record<string, unknown> };
const changes: Change[] = [];
const nc = await connect({ servers: natsUrl });

function head(content: unknown): string {
  if (!Array.isArray(content)) {
    return '';
  }
  for (const block of content as Record<string, unknown>[]) {
    if (block.type === 'text' && typeof block.text === 'string') {
      return block.text.slice(0, 70).replace(/\n/g, ' ');
    }
  }
  return '';
}

nc.subscribe(`${changesPrefix}>`, {
  callback: (_err, msg) => {
    const body = msg.json<Record<string, unknown>>();
    changes.push({ subject: msg.subject, body });
    const leaf = msg.subject.slice(changesPrefix.length);
    if (leaf === 'message') {
      show('message', { id: body.id, queryId: body.queryId, role: body.role, from: body.from ?? null, blocks: (body.content as { type: string }[]).map((block) => block.type), text: head(body.content) });
    } else {
      show('change', { leaf, body });
    }
  },
});
await nc.flush();

async function request(subject: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reply = await nc.request(subject, JSON.stringify({ ts: new Date().toISOString(), ...body }), { timeout: 30_000 });
  const answer = reply.json<Record<string, unknown>>();
  show('request', { leaf: subject.split('.').slice(-1)[0], reply: answer });
  return answer;
}

async function until(what: string, test: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!test()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await delay(200);
  }
}

const messages = () => changes.filter((change) => change.subject.endsWith('.changes.message')).map((change) => change.body);
const closed = () => changes.filter((change) => change.subject.endsWith('.changes.query.closed')).map((change) => change.body.queryId);

const main = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const participant = spawn(process.execPath, ['--import', 'tsx', main], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, NATS_URL: natsUrl, PARTICIPANT_WORLD: world, PARTICIPANT_DURABLE_BUCKET: bucket, PARTICIPANT_CONFIG_DIR: configDir },
});
const exited = new Promise<number | null>((resolve) => participant.once('exit', (code) => resolve(code)));
createInterface({ input: participant.stdout }).on('line', (line) => show('controlReply', JSON.parse(line)));

let ready = false;
nc.subscribe(`agent.v1.${world}.telemetry.ready`, {
  callback: () => {
    ready = true;
  },
});
await nc.flush();
for (const line of CONTROL_LINES) {
  participant.stdin.write(`${JSON.stringify(line)}\n`);
}

try {
  await until('ready', () => ready, 60_000);
  await request(`agent.v1.${world}.requests.service`, { conversationId, cwd });

  const reply = await request(`conv.v2.${conversationId}.requests.say`, {
    from: { kind: 'human' },
    text: 'Use the Bash tool with run_in_background set to true to run exactly: sleep 20; echo finished. Then end your turn at once with one short sentence. Do not wait for it or check on it. When you are later told it finished, reply with one short sentence.',
    precondition: { tip: null },
  });
  if (reply.accepted !== true) {
    throw new Error(`say not accepted: ${JSON.stringify(reply)}`);
  }
  const first = reply.id;
  await until('the say to close', () => closed().includes(first), 120_000);
  // The notice opens a query the participant mints; wait for it to close too.
  await until('the notice query to close', () => closed().some((id) => id !== first), 180_000);

  // A second say starts a background agent, whose end comes as a notice too.
  const second = await request(`conv.v2.${conversationId}.requests.say`, {
    from: { kind: 'human' },
    text: 'Use the Agent tool with run_in_background set to true to start a general-purpose agent whose whole task is to reply with the single word: done. Then end your turn at once with one short sentence. Do not wait for it. When you are later told it finished, reply with one short sentence.',
    precondition: { tip: (messages().at(-1)?.id as string | undefined) ?? null },
  });
  if (second.accepted !== true) {
    throw new Error(`say not accepted: ${JSON.stringify(second)}`);
  }
  await until('the second say to close', () => closed().includes(second.id), 120_000);
  await until('the agent notice query to close', () => closed().filter((id) => id !== first && id !== second.id).length >= 2, 240_000);

  const label = (queryId: unknown) => (queryId === first ? 'say' : queryId === second.id ? 'say2' : 'own');
  show('summary', {
    messages: messages().map((body) => ({ queryId: label(body.queryId), role: body.role, from: body.from ?? null, blocks: (body.content as { type: string }[]).map((block) => block.type), text: head(body.content) })),
  });
} finally {
  // The record: every entry's shape, with its origin.
  const projects = join(configDir, 'projects');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (name === `${conversationId}.jsonl`) {
        files.push(path);
      }
    }
  };
  try {
    walk(projects);
  } catch {
    // No record was written.
  }
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line.trim() === '') {
        continue;
      }
      const entry = JSON.parse(line) as Record<string, unknown>;
      const message = (entry.message ?? {}) as Record<string, unknown>;
      const content = message.content;
      show('entry', {
        uuid: entry.uuid,
        type: entry.type,
        subtype: entry.subtype,
        attachment: (entry.attachment as Record<string, unknown> | undefined)?.type,
        isMeta: entry.isMeta,
        isSidechain: entry.isSidechain,
        origin: entry.origin,
        commandMode: entry.commandMode,
        toolUseResult: entry.toolUseResult === undefined ? undefined : 'set',
        model: message.model,
        blocks: Array.isArray(content) ? (content as { type: string }[]).map((block) => block.type) : typeof content,
        keys: Object.keys(entry),
      });
    }
  }
  participant.kill('SIGINT');
  show('shutdown', { exitCode: await exited });
  await nc.drain();
}
