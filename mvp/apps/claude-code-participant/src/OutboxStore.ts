import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { dependsOn } from '@shellicar/core-di';
import { ParticipantConfig } from './ParticipantConfig.js';

/** A file whose bytes belong in the object store before the message that points at it is published. */
export type OutboxFile = { objectId: string; bucket: string; metadata: Record<string, string> };

/** One message waiting to be published, as it is kept on disk. */
export type OutboxRecord = {
  /** What the stream recognises a repeat of this message by. */
  id: string;
  subject: string;
  body: Record<string, unknown>;
  /** Stored in order, each from the blob of the same index, before the message goes out. */
  files: OutboxFile[];
};

export type StoredRecord = { seq: number; record: OutboxRecord };

/**
 * The filesystem edge of the outbox: one ordered list of records per
 * conversation, each with the bytes of its files kept beside it.
 */
export abstract class IOutboxStore {
  /** The conversations with anything waiting. */
  public abstract conversations(): Promise<string[]>;
  /** What is waiting for `conversationId`, in the order it was written. */
  public abstract load(conversationId: string): Promise<StoredRecord[]>;
  /** Writes `record` and its blobs; once this resolves they survive the process being killed. */
  public abstract write(conversationId: string, seq: number, record: OutboxRecord, blobs: readonly Uint8Array[]): Promise<void>;
  public abstract readBlob(conversationId: string, seq: number, index: number): Promise<Uint8Array>;
  /** Removes the record and its blobs. */
  public abstract remove(conversationId: string, seq: number, blobCount: number): Promise<void>;
}

const SEQ_DIGITS = 12;
const OWNER_ONLY = 0o700;
const RECORD_SUFFIX = '.json';

function recordName(seq: number): string {
  return `${String(seq).padStart(SEQ_DIGITS, '0')}${RECORD_SUFFIX}`;
}

function blobName(seq: number, index: number): string {
  return `${String(seq).padStart(SEQ_DIGITS, '0')}.${index}.blob`;
}

/** Writes `data` to `path` so that it exists whole or not at all, and survives a crash once this resolves. */
async function writeDurably(directory: string, name: string, data: Uint8Array | string): Promise<void> {
  const temporary = join(directory, `.writing-${name}`);
  const handle = await open(temporary, 'w', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, join(directory, name));
  await syncDirectory(directory);
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** The outbox as files under `<config dir>/outbox/<conversation id>/`. */
export class DiskOutboxStore implements IOutboxStore {
  @dependsOn(ParticipantConfig) private readonly config!: ParticipantConfig;

  public async conversations(): Promise<string[]> {
    try {
      const entries = await readdir(this.root(), { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }

  public async load(conversationId: string): Promise<StoredRecord[]> {
    const directory = this.directory(conversationId);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }
    const records = names.filter((name) => name.endsWith(RECORD_SUFFIX) && !name.startsWith('.'));
    const kept = new Set(records.map((name) => name.slice(0, SEQ_DIGITS)));
    // What a write that was cut short leaves behind: a temporary file, or a
    // blob whose record never landed.
    for (const name of names) {
      const stray = name.startsWith('.writing-') || (name.endsWith('.blob') && !kept.has(name.slice(0, SEQ_DIGITS)));
      if (stray) {
        await rm(join(directory, name), { force: true });
      }
    }
    const loaded: StoredRecord[] = [];
    for (const name of records.sort()) {
      loaded.push({ seq: Number(name.slice(0, SEQ_DIGITS)), record: JSON.parse(await readFile(join(directory, name), 'utf8')) as OutboxRecord });
    }
    return loaded;
  }

  public async write(conversationId: string, seq: number, record: OutboxRecord, blobs: readonly Uint8Array[]): Promise<void> {
    const directory = this.directory(conversationId);
    await mkdir(directory, { recursive: true, mode: OWNER_ONLY });
    // The record last: it is what makes the message exist.
    for (const [index, blob] of blobs.entries()) {
      await writeDurably(directory, blobName(seq, index), blob);
    }
    await writeDurably(directory, recordName(seq), JSON.stringify(record));
  }

  public async readBlob(conversationId: string, seq: number, index: number): Promise<Uint8Array> {
    return await readFile(join(this.directory(conversationId), blobName(seq, index)));
  }

  public async remove(conversationId: string, seq: number, blobCount: number): Promise<void> {
    const directory = this.directory(conversationId);
    // The record first, so a cut-short removal leaves strays, never a record
    // missing its blobs.
    await rm(join(directory, recordName(seq)), { force: true });
    for (let index = 0; index < blobCount; index += 1) {
      await rm(join(directory, blobName(seq, index)), { force: true });
    }
  }

  private root(): string {
    return join(this.config.configDir, 'outbox');
  }

  private directory(conversationId: string): string {
    return join(this.root(), conversationId);
  }
}
