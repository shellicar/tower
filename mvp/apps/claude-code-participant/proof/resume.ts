// One resume of a shape's conversation by one method, capturing the request
// its probe sends (Claude Code's own body log, OTEL_LOG_RAW_API_BODIES).
//
// The shape's config dir snapshot is restored to the path it had live, so
// path strings match across methods. For every method but `local`, the
// conversation's local record is deleted from the restored copy, so the
// history can only come from `load()`.
//
// Methods: `local` (load() returns null; Claude Code reads its own record),
// `raw` (load() returns the published raw entries), `msg[:field,...]`
// (load() rebuilds from the published messages, plus the named raw fields),
// each optionally ending in `@` (resume only to the last non-system entry
// load() returned).

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeServing } from '../src/beforeServing.js';
import { ControlLines } from '../src/ControlLines.js';
import { ConversationLauncher } from '../src/ConversationLauncher.js';
import { composeConfig } from '../src/composition.js';
import { participantServices } from '../src/container.js';
import { LOAD_FIELDS, type LoadField, type LoadMode, LoadSetting, PublishedLoader } from '../src/PublishedLoader.js';
import { ISessionLoader } from '../src/SessionStore.js';
import { CONTROL_LINES, type Json, type ShapeMeta } from './lib.js';
import { probeFor } from './shapes.js';

const out = process.env.PROOF_OUT as string;
const method = process.env.PROOF_METHOD as string;
const methodDir = process.env.PROOF_METHOD_DIR as string;
const meta = JSON.parse(readFileSync(join(out, 'meta.json'), 'utf8')) as ShapeMeta;

const atEntry = method.endsWith('@');
const name = atEntry ? method.slice(0, -1) : method;
const [kind, fieldList] = name.split(':');

function modeOf(): LoadMode | undefined {
  // `local2` is a second `local`, the control for what any two resumes differ by.
  if (kind?.startsWith('local')) {
    return undefined;
  }
  if (kind === 'raw') {
    return { source: 'raw' };
  }
  const add = new Set<LoadField>();
  const exclude = new Set<string>();
  for (const field of (fieldList ?? '').split(',').filter((f) => f !== '')) {
    if (field.startsWith('-')) {
      exclude.add(field.slice(1));
      continue;
    }
    if (!LOAD_FIELDS.includes(field as LoadField)) {
      throw new Error(`unknown load field ${field}`);
    }
    add.add(field as LoadField);
  }
  return { source: 'messages', add, exclude, cwd: meta.cwd };
}

// Restore the snapshot to the path it had live.
rmSync(meta.configDir, { recursive: true, force: true });
cpSync(meta.snapshot, meta.configDir, { recursive: true, preserveTimestamps: true });
const projects = join(meta.configDir, 'projects');
if (!kind?.startsWith('local')) {
  for (const dir of existsSync(projects) ? readdirSync(projects) : []) {
    rmSync(join(projects, dir, `${meta.id}.jsonl`), { force: true });
  }
}

const env = {
  ...process.env,
  PARTICIPANT_WORLD: meta.world,
  PARTICIPANT_DURABLE_BUCKET: 'durable',
  PARTICIPANT_CONFIG_DIR: meta.configDir,
  OTEL_LOG_RAW_API_BODIES: `file:${join(methodDir, 'bodies')}`,
};
const config = composeConfig(env, tmpdir(), process.getuid?.(), process.platform);
const services = participantServices(config, process.platform);
const mode = modeOf();
if (mode !== undefined) {
  services.register(LoadSetting).using(() => new LoadSetting(mode)).asSelf();
  services.register(PublishedLoader).as(ISessionLoader);
}
const provider = services.buildProvider();

void beforeServing(provider, process.platform, (line) => console.error(`participant: ${line}`), new AbortController().signal);
const controlReplies: unknown[] = [];
for (const line of CONTROL_LINES) {
  controlReplies.push(provider.resolve(ControlLines).handle(JSON.stringify(line)));
}

// The entry to resume to: the last non-system entry load() returns (computed
// from a first read, since the SDK calls load() itself during launch).
let resumeSessionAt: string | undefined;
if (atEntry && mode !== undefined) {
  const entries = (await provider.resolve(ISessionLoader).load(meta.id)) ?? [];
  const last = [...entries].reverse().find((e) => typeof e.uuid === 'string' && e.type !== 'system' && e.type !== 'progress');
  resumeSessionAt = last?.uuid;
}

const result: Json = { method, resumeSessionAt: resumeSessionAt ?? null, controlReplies };
try {
  const conversation = await provider.resolve(ConversationLauncher).launch({ id: meta.id, cwd: meta.cwd, additionalDirectories: [], resume: true, ...(resumeSessionAt === undefined ? {} : { resumeSessionAt }) });
  conversation.send(probeFor(meta.shape));
  for await (const message of conversation.messages) {
    if (message.type === 'assistant') {
      result.assistant = message.message.content.map((block) => (block.type === 'text' ? { text: block.text } : { type: block.type }));
    }
    if (message.type === 'result') {
      result.result = { subtype: message.subtype, is_error: message.is_error, text: 'result' in message ? message.result : undefined };
      conversation.close();
    }
  }
} catch (err) {
  result.error = err instanceof Error ? (err.stack ?? err.message) : String(err);
}

const loader = mode === undefined ? undefined : (provider.resolve(ISessionLoader) as PublishedLoader);
if (loader !== undefined) {
  result.publishedRead = loader.lastRead;
  result.entriesLoaded = loader.last.length;
  mkdirSync(methodDir, { recursive: true });
  writeFileSync(join(methodDir, 'loaded.jsonl'), loader.last.map((e) => JSON.stringify(e)).join('\n') + '\n');
}
writeFileSync(join(methodDir, 'result.json'), `${JSON.stringify(result, null, 1)}\n`);
process.exit(0);
