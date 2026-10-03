import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lastMessageId, readRecord } from '../src/ClaudeCodeRecord.js';
import { IMAGE_TOOL_RESULT, INTERRUPT_MARKER, PARTIAL_REPLY, PROMPT, SECOND_PROMPT, TOKENS_REMINDER, TOOL_USE } from './entries.js';

const ID = '0f8b7c1e-2a4d-4e6f-9b1a-3c5d7e9f1a2b';

function lines(...entries: unknown[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
}

describe('lastMessageId', () => {
  it('is null for an empty transcript', () => {
    expect(lastMessageId('')).toBeNull();
  });

  it('is the last user or assistant entry', () => {
    expect(lastMessageId(lines({ type: 'user', uuid: 'u1' }, { type: 'assistant', uuid: 'a1' }))).toBe('a1');
  });

  it('counts a system entry', () => {
    expect(lastMessageId(lines({ type: 'assistant', uuid: 'a1' }, { type: 'system', uuid: 's1' }))).toBe('s1');
  });

  it('skips entries that are not messages', () => {
    expect(lastMessageId(lines({ type: 'user', uuid: 'u1' }, { type: 'attachment', uuid: 'x1' }, { type: 'summary', leafUuid: 'u1' }))).toBe('u1');
  });

  it("skips a subagent's sidechain", () => {
    expect(lastMessageId(lines({ type: 'user', uuid: 'u1' }, { type: 'assistant', uuid: 'a1', isSidechain: true }))).toBe('u1');
  });

  it('counts an interrupt marker', () => {
    expect(lastMessageId(lines(SECOND_PROMPT, PARTIAL_REPLY, INTERRUPT_MARKER))).toBe(INTERRUPT_MARKER.uuid);
  });

  it('skips a reminder', () => {
    expect(lastMessageId(lines(PROMPT, { type: 'user', uuid: 'm1', isMeta: true, message: { role: 'user', content: 'Continue.' } }))).toBe(PROMPT.uuid);
  });

  it('counts a tool result', () => {
    expect(lastMessageId(lines(TOOL_USE, IMAGE_TOOL_RESULT, TOKENS_REMINDER))).toBe(IMAGE_TOOL_RESULT.uuid);
  });

  it('skips a line that is not JSON', () => {
    expect(lastMessageId(`${JSON.stringify({ type: 'user', uuid: 'u1' })}\n{"type":"assist`)).toBe('u1');
  });
});

describe('readRecord', () => {
  function configDir(): string {
    return mkdtempSync(join(tmpdir(), 'participant-record-'));
  }

  it('is undefined when the config dir has no projects', async () => {
    expect(await readRecord(configDir(), ID)).toBeUndefined();
  });

  it('is undefined when no project holds the conversation', async () => {
    const dir = configDir();
    mkdirSync(join(dir, 'projects', '-work-project'), { recursive: true });
    expect(await readRecord(dir, ID)).toBeUndefined();
  });

  it("reads the tip from the conversation's transcript, in whichever project holds it", async () => {
    const dir = configDir();
    mkdirSync(join(dir, 'projects', '-work-other'), { recursive: true });
    mkdirSync(join(dir, 'projects', '-work-project'), { recursive: true });
    writeFileSync(join(dir, 'projects', '-work-project', `${ID}.jsonl`), lines({ type: 'user', uuid: 'u1' }));
    expect(await readRecord(dir, ID)).toEqual({ tip: 'u1' });
  });

  it('ignores a file among the project directories', async () => {
    const dir = configDir();
    mkdirSync(join(dir, 'projects'), { recursive: true });
    writeFileSync(join(dir, 'projects', 'stray'), 'x');
    expect(await readRecord(dir, ID)).toBeUndefined();
  });
});
