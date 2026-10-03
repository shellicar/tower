import { mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { participantServices } from '../src/container.js';
import { IOutboxStore, type OutboxRecord } from '../src/OutboxStore.js';
import { testConfig } from './support.js';

const ID = '0c77fb4e-655e-41f2-be80-558ad2aaf6dc';

function store() {
  const configDir = mkdtempSync(join(tmpdir(), 'outbox-store-'));
  const provider = participantServices(testConfig({ configDir }), 'linux').buildProvider();
  return { configDir, store: provider.resolve(IOutboxStore), directory: join(configDir, 'outbox', ID) };
}

function record(id: string, objectIds: string[] = []): OutboxRecord {
  return { id, subject: `conv.v2.${ID}.changes.message`, body: { id }, files: objectIds.map((objectId) => ({ objectId, bucket: 'durable-test', metadata: {} })) };
}

describe('the disk outbox store', () => {
  it('loads what was written, in the order of its sequence numbers', async () => {
    const { store: disk } = store();
    await disk.write(ID, 2, record('m2'), []);
    await disk.write(ID, 10, record('m10'), []);
    await disk.write(ID, 1, record('m1'), []);
    expect((await disk.load(ID)).map(({ seq, record: loaded }) => [seq, loaded.id])).toEqual([
      [1, 'm1'],
      [2, 'm2'],
      [10, 'm10'],
    ]);
  });

  it('reads a blob back as it was written', async () => {
    const { store: disk } = store();
    await disk.write(ID, 1, record('m1', ['a', 'b']), [new Uint8Array([1, 2]), new Uint8Array([3])]);
    expect([...(await disk.readBlob(ID, 1, 1))]).toEqual([3]);
  });

  it('removes a record and its blobs', async () => {
    const { store: disk, directory } = store();
    await disk.write(ID, 1, record('m1', ['a']), [new Uint8Array([1])]);
    await disk.remove(ID, 1, 1);
    expect(readdirSync(directory)).toEqual([]);
  });

  it('lists the conversations with something in them', async () => {
    const { store: disk } = store();
    await disk.write(ID, 1, record('m1'), []);
    expect(await disk.conversations()).toEqual([ID]);
  });

  it('has no conversations before anything is written', async () => {
    const { store: disk } = store();
    expect(await disk.conversations()).toEqual([]);
  });

  it('loads nothing for a conversation with nothing written', async () => {
    const { store: disk } = store();
    expect(await disk.load(ID)).toEqual([]);
  });

  describe('after a write that was cut short', () => {
    it('ignores and removes a blob whose record never landed', async () => {
      const { store: disk, directory } = store();
      await disk.write(ID, 1, record('m1'), []);
      writeFileSync(join(directory, '000000000002.0.blob'), 'orphan');
      await disk.load(ID);
      expect(readdirSync(directory)).toEqual(['000000000001.json']);
    });

    it('removes a temporary file', async () => {
      const { store: disk, directory } = store();
      await disk.write(ID, 1, record('m1'), []);
      writeFileSync(join(directory, '.writing-000000000002.json'), '{"id":');
      await disk.load(ID);
      expect(readdirSync(directory)).toEqual(['000000000001.json']);
    });
  });

  it('keeps its files readable by the owner alone', async () => {
    const { store: disk, directory } = store();
    await disk.write(ID, 1, record('m1'), []);
    expect(statSync(join(directory, '000000000001.json')).mode & 0o077).toBe(0);
  });
});
