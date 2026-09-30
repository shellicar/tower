import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Claude Code's own record of a conversation: its transcript in the agent's config dir. */
export type ClaudeCodeRecord = {
  /** The id of the conversation's last message, or null when it has none yet. */
  tip: string | null;
};

// TODO: undecided: which transcript entries count as the conversation's
// messages is settled with the publisher. Until then the tip is the last
// user, assistant or system entry outside a subagent's sidechain.
const MESSAGE_TYPES: readonly string[] = ['user', 'assistant', 'system'];

function isNotFound(err: unknown): boolean {
  const { code } = err as NodeJS.ErrnoException;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** The id of the last message in a transcript (one JSON entry per line), or null when there is none. */
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
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const { type, uuid, isSidechain } = entry as Record<string, unknown>;
    if (typeof type === 'string' && MESSAGE_TYPES.includes(type) && typeof uuid === 'string' && isSidechain !== true) {
      tip = uuid;
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
