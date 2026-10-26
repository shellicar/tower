import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isObject, type RecordEntry, roleOf } from './ConversationEntries.js';

/** Claude Code's own record of a conversation: its transcript in the agent's config dir. */
export type ClaudeCodeRecord = {
  /** The id of the conversation's last message, or null when it has none yet. */
  tip: string | null;
};

function isNotFound(err: unknown): boolean {
  const { code } = err as NodeJS.ErrnoException;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** The id of the last entry in a transcript (one JSON entry per line) that counts as a message, or null when there is none. */
export function lastMessageId(transcript: string): string | null {
  let tip: string | null = null;
  for (const line of transcript.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(entry) || typeof entry.type !== 'string') {
      continue;
    }
    const recorded = entry as RecordEntry;
    if (roleOf(recorded) !== undefined) {
      tip = recorded.uuid ?? null;
    }
  }
  return tip;
}

/**
 * Reads Claude Code's record of `conversationId` from `configDir`, under
 * whichever project directory Claude Code filed it. Undefined when Claude
 * Code has none.
 */
export async function readRecord(configDir: string, conversationId: string): Promise<ClaudeCodeRecord | undefined> {
  const projects = join(configDir, 'projects');
  let projectDirs: string[];
  try {
    projectDirs = await readdir(projects);
  } catch (err) {
    if (isNotFound(err)) {
      return undefined;
    }
    throw err;
  }
  for (const projectDir of projectDirs) {
    try {
      const transcript = await readFile(join(projects, projectDir, `${conversationId}.jsonl`), 'utf8');
      return { tip: lastMessageId(transcript) };
    } catch (err) {
      if (!isNotFound(err)) {
        throw err;
      }
    }
  }
  return undefined;
}
