// Does the uuid a host puts on an SDKUserMessage become the uuid of the
// prompt entry Claude Code writes (and the store receives)? If it does, a
// committer can find its own prompt among the appends by uuid alone.
// Against the fake API (nothing reaches the model): one prompt with a uuid,
// then the store appends are searched for it.
//
//   node proofs/commit-resume/prompt-uuid.mts <out-dir>

import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import { startRun } from '../../src/harness.mts';
import { startFakeApi } from './fake-api.mts';

type Json = Record<string, unknown>;

const out = resolve(process.argv[2] ?? '');
mkdirSync(out, { recursive: true });
const appends = `${out}/store-appends.jsonl`;
const store: SessionStore = {
  async append(key: SessionKey, entries: SessionStoreEntry[]) {
    appendFileSync(appends, `${JSON.stringify({ key, entries })}\n`);
  },
  async load() {
    return null;
  },
};
const fake = await startFakeApi({ upstream: process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com', dir: out });
const uuid = randomUUID();
const run = startRun({
  name: 'commit-resume',
  options: { model: 'claude-sonnet-5', thinking: { type: 'adaptive', display: 'summarized' }, tools: ['Bash', 'Write'], sessionStore: store, sessionStoreFlush: 'eager', env: { ...process.env, ANTHROPIC_BASE_URL: fake.url, TZ: 'UTC' } },
});
run.send({ type: 'user', message: { role: 'user', content: 'Reply with the word READY only.' }, parent_tool_use_id: null, uuid: uuid as `${string}-${string}-${string}-${string}-${string}` });
for await (const m of run.messages()) {
  if ((m as Json).type === 'result') {
    run.end();
  }
}
await run.done.catch(() => {});
await fake.close();
const entries = readFileSync(appends, 'utf8')
  .split('\n')
  .filter(Boolean)
  .flatMap((l) => (JSON.parse(l) as { entries: Json[] }).entries);
const prompt = entries.find((e) => e.type === 'user');
process.stdout.write(`${JSON.stringify({ sent: uuid, promptEntryUuid: prompt?.uuid ?? null, same: prompt?.uuid === uuid, runDir: run.dir })}\n`);
