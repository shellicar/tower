// Tower's test broker (127.0.0.1:31416, never 4222), the conv.v2 subjects
// this proof publishes, and reading them back. From proof 14
// (pure-resume.mts), without the side subject.

import { type JetStreamClient, type JetStreamManager, jetstream, jetstreamManager } from '@nats-io/jetstream';
import { connect, type NatsConnection } from '@nats-io/transport-node';
import type { Json, TowerMessage } from './form.mts';

export const NATS_URL = '127.0.0.1:31416';
export const AUDIT_STREAM = 'conv-approval';

export interface Tower {
  nc: NatsConnection;
  js: JetStreamClient;
  jsm: JetStreamManager;
}

export async function openTower(): Promise<Tower> {
  const nc = await connect({ servers: NATS_URL, name: 'proof-16-semantic-form' });
  const jsm = await jetstreamManager(nc);
  for (const probe of ['conv.v2.probe.changes.message', 'conv.v2.probe.changes.query', 'conv.v2.probe.telemetry.usage']) {
    const found = await jsm.streams.find(probe);
    if (found !== AUDIT_STREAM) {
      throw new Error(`${probe} is captured by ${found}, not ${AUDIT_STREAM}: the broker's streams are not what mvp/stream-init.sh sets up`);
    }
  }
  return { nc, js: jetstream(nc), jsm };
}

export async function lastSeq(tower: Tower): Promise<number> {
  return (await tower.jsm.streams.info(AUDIT_STREAM)).state.last_seq;
}

export function tsNow(): string {
  const d = new Date();
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  const local = new Date(d.getTime() + off * 60_000).toISOString().replace('Z', '');
  return `${local}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

// The spec's required fields (conversation.md), checked before publishing.
export function checkMessage(body: Json): string[] {
  const errors: string[] = [];
  for (const f of ['id', 'queryId', 'turnId', 'role']) {
    if (typeof body[f] !== 'string') {
      errors.push(`${f}: not a string`);
    }
  }
  if (typeof body.ts !== 'string' || !TS.test(body.ts)) {
    errors.push('ts: not a timestamp');
  }
  if (!Array.isArray(body.content) || !(body.content as Json[]).every((b) => typeof b?.type === 'string')) {
    errors.push('content: not blocks');
  }
  return errors;
}

async function readStream(tower: Tower, filter: string, upto?: number): Promise<{ seq: number; body: Json }[]> {
  const info = await tower.jsm.streams.info(AUDIT_STREAM, { subjects_filter: filter });
  const count = Object.values(info.state.subjects ?? {}).reduce((a, n) => a + n, 0);
  if (count === 0) {
    return [];
  }
  const consumer = await tower.js.consumers.get(AUDIT_STREAM, { filter_subjects: filter });
  const out: { seq: number; body: Json }[] = [];
  const messages = await consumer.consume();
  for await (const m of messages) {
    if (upto !== undefined && m.seq > upto) {
      break;
    }
    out.push({ seq: m.seq, body: m.json() as Json });
    if (m.info.pending === 0) {
      break;
    }
  }
  await messages.close();
  return out;
}

// changes.message folded by id (a later body under the same id replaces the
// earlier one), in first-seen order.
export async function towerMessages(tower: Tower, convId: string, upto: number): Promise<TowerMessage[]> {
  const byId = new Map<string, TowerMessage>();
  const order: string[] = [];
  for (const s of await readStream(tower, `conv.v2.${convId}.changes.message`, upto)) {
    const id = String(s.body.id);
    if (!byId.has(id)) {
      order.push(id);
    }
    byId.set(id, s.body as TowerMessage);
  }
  return order.map((id) => byId.get(id) as TowerMessage);
}

export async function modelsByTurn(tower: Tower, convId: string, upto: number): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const s of await readStream(tower, `conv.v2.${convId}.telemetry.usage`, upto)) {
    if (!out.has(String(s.body.turnId))) {
      out.set(String(s.body.turnId), String(s.body.model));
    }
  }
  return out;
}
