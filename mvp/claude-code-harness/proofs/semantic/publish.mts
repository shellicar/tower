// The live publisher: one per approach, each onto its own tower
// conversation. Claude Code's entries arrive through the session store; a
// user or system message is published once its approach has resolved where
// its entries went; assistant pieces are published in record order behind
// whatever is still unresolved (tower's order would break otherwise).
//
// TODO: undecided (from proof 14, carried forward): the turnId of user and
// system messages is the turn of the response to the request that carries
// them; queryId changes on each prompt (a user entry that is neither isMeta
// nor tool results).

import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { redact, stamp } from '../../src/record.mts';
import { type FormMessage, isCarrier, isToolResults, type Json, messageId } from './form.mts';
import { checkMessage, type Tower, tsNow } from './tower.mts';

const SERVICE = 'anthropic.messages';

export class Recorder {
  path: string | undefined;
  pending: string[] = [];
  readonly file: string;
  constructor(file: string) {
    this.file = file;
  }
  attach(dir: string): void {
    this.path = join(dir, this.file);
    for (const line of this.pending) {
      appendFileSync(this.path, line);
    }
    this.pending = [];
  }
  write(value: unknown): void {
    const line = `${redact(typeof value === 'string' ? value : JSON.stringify(value)).text}\n`;
    if (this.path) {
      appendFileSync(this.path, line);
    } else {
      this.pending.push(line);
    }
  }
}

interface Item {
  entry: Json;
  kind: 'assistant' | 'carrier' | 'other';
  appendedAt: string;
  appendedMs: number;
  queryId: string;
  state: 'pending' | 'resolved' | 'released';
  forms?: { form: FormMessage; turnId: string; signal: string; signalAt: string; signalMs: number; queryId: string }[];
}

export class Publisher {
  readonly tower: Tower;
  convId: string;
  readonly label: string;
  readonly instanceId = randomUUID();
  readonly rec: Recorder;
  readonly timing: Recorder;
  readonly outbox: Item[] = [];
  readonly turnByMsgId = new Map<string, string>();
  readonly pendingUsage = new Map<string, Json[]>();
  // A: turns minted per request, taken by the next new response id.
  readonly requestTurns: string[] = [];
  lastMsgId: string | undefined;
  lastModel: string | undefined;
  queryId = randomUUID();
  published = 0;
  chain: Promise<void> = Promise.resolve();

  constructor(tower: Tower, convId: string, label: string) {
    this.tower = tower;
    this.convId = convId;
    this.label = label;
    this.rec = new Recorder(`published-${label}.jsonl`);
    this.timing = new Recorder(`timing-${label}.jsonl`);
  }

  serial(fn: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(fn, fn);
    return this.chain;
  }

  async publish(leaf: string, body: Json): Promise<number> {
    const subject = `conv.v2.${this.convId}.${leaf}`;
    if (leaf === 'changes.message') {
      const errors = checkMessage(body);
      if (errors.length > 0) {
        this.rec.write({ at: stamp(), subject, INVALID: errors, body });
        throw new Error(`${subject} fails the spec schema: ${errors.join('; ')}`);
      }
    }
    const ack = await this.tower.js.publish(subject, JSON.stringify(body));
    this.published += 1;
    this.rec.write({ at: stamp(), seq: ack.seq, subject, body });
    return ack.seq;
  }

  append(entries: Json[]): Promise<void> {
    const at = stamp();
    const ms = Date.now();
    this.noteAppended(entries);
    return this.serial(async () => {
      for (const e of entries) {
        let kind: Item['kind'] = 'other';
        if (e.isSidechain === true) {
          kind = 'other';
        } else if (e.type === 'assistant') {
          kind = 'assistant';
        } else if (isCarrier(e)) {
          kind = 'carrier';
          if (e.type === 'user' && e.isMeta !== true && !isToolResults((e.message as Json).content)) {
            this.queryId = randomUUID();
          }
        }
        this.outbox.push({ entry: e, kind, appendedAt: at, appendedMs: ms, queryId: this.queryId, state: kind === 'carrier' ? 'pending' : 'resolved' });
      }
      await this.drain();
    });
  }

  pendingEntries(): Json[] {
    return this.outbox.filter((i) => i.kind === 'carrier' && i.state === 'pending').map((i) => i.entry);
  }

  // An approach has placed these forms; the entries they list are resolved.
  // Entries in `release` stop blocking without being published (recorded).
  resolve(forms: FormMessage[], turnId: string, signal: string, signalAt: string, signalMs: number, release: Json[] = [], note?: Json): Promise<void> {
    return this.serial(async () => {
      for (const form of forms) {
        const ids = new Set(form.ccEntries.map((c) => c.uuid));
        const items = this.outbox.filter((i) => i.kind === 'carrier' && ids.has(String(i.entry.uuid)));
        for (const i of items) {
          i.state = 'resolved';
        }
        const holder = items.find((i) => String(i.entry.uuid) === messageId(form)) ?? items[0];
        const host = items[0];
        if (!host || !holder) {
          this.timing.write({ at: stamp(), UNHOSTED: form.ccEntries.map((c) => c.uuid) });
          continue;
        }
        host.forms = [...(host.forms ?? []), { form, turnId, signal, signalAt, signalMs, queryId: holder.queryId }];
      }
      for (const e of release) {
        const i = this.outbox.find((x) => x.entry === e);
        if (i && i.state === 'pending') {
          i.state = 'released';
          this.timing.write({ at: stamp(), released: String(e.uuid), type: e.type, attachment: (e.attachment as Json | undefined)?.type, note });
        }
      }
      await this.drain();
    });
  }

  async drain(): Promise<void> {
    while (this.outbox.length > 0 && (this.outbox[0] as Item).state !== 'pending') {
      const item = this.outbox.shift() as Item;
      for (const f of item.forms ?? []) {
        const id = messageId(f.form);
        const isPrompt = f.form.role === 'user' && f.form.content.some((b) => b.type === 'text') && f.form.ccEntries.some((c) => c.type === 'user' && !c.isMeta);
        const body: Json = {
          ts: tsNow(),
          instanceId: this.instanceId,
          id,
          queryId: f.queryId,
          turnId: f.turnId,
          role: f.form.role,
          // TODO: undecided, `from` (form.mts header).
          ...(isPrompt ? { from: { kind: 'human' } } : {}),
          content: f.form.content,
          ccEntries: f.form.ccEntries,
        };
        const seq = await this.publish('changes.message', body);
        const entryTimes = f.form.ccEntries.map((c) => {
          const it = this.findAppended(c.uuid);
          return { uuid: c.uuid, appendedAt: it?.at, appendedMs: it?.ms };
        });
        const lastAppend = Math.max(...entryTimes.map((t) => t.appendedMs ?? 0));
        this.timing.write({ at: stamp(), seq, role: f.form.role, id, signal: f.signal, signalAt: f.signalAt, entries: entryTimes, waitAfterLastEntryMs: Date.now() - lastAppend, signalAfterLastEntryMs: f.signalMs - lastAppend });
      }
      if (item.kind === 'assistant') {
        const msg = item.entry.message as Json;
        const msgId = String(msg.id);
        let turnId = this.turnByMsgId.get(msgId);
        if (!turnId) {
          turnId = this.requestTurns.shift() ?? randomUUID();
          this.turnByMsgId.set(msgId, turnId);
        }
        const seq = await this.publish('changes.message', {
          ts: tsNow(),
          instanceId: this.instanceId,
          id: String(item.entry.uuid),
          queryId: item.queryId,
          turnId,
          role: 'assistant',
          from: { kind: 'agent' },
          content: msg.content,
        });
        this.timing.write({ at: stamp(), seq, role: 'assistant', id: item.entry.uuid, appendedAt: item.appendedAt, waitAfterAppendMs: Date.now() - item.appendedMs });
        await this.drainUsage(msgId);
      }
    }
  }

  readonly appendedAt = new Map<string, { at: string; ms: number }>();
  findAppended(uuid: string): { at: string; ms: number } | undefined {
    return this.appendedAt.get(uuid);
  }
  noteAppended(entries: Json[]): void {
    const at = stamp();
    const ms = Date.now();
    for (const e of entries) {
      if (typeof e.uuid === 'string' && !this.appendedAt.has(e.uuid)) {
        this.appendedAt.set(e.uuid, { at, ms });
      }
    }
  }

  // Whatever is still pending at the end was never sent.
  finish(): Promise<void> {
    return this.serial(async () => {
      for (const i of this.outbox) {
        if (i.state === 'pending') {
          i.state = 'released';
          this.timing.write({ at: stamp(), released: String(i.entry.uuid), type: i.entry.type, attachment: (i.entry.attachment as Json | undefined)?.type, note: 'never placed by the end of the run' });
        }
      }
      await this.drain();
    });
  }

  closeQuery(reason: string): Promise<void> {
    return this.serial(async () => {
      await this.publish('changes.query', { ts: tsNow(), instanceId: this.instanceId, queryId: this.queryId, reason });
    });
  }

  streamEvent(event: Json): Promise<void> {
    return this.serial(async () => {
      if (event.type === 'message_start') {
        const m = event.message as Json;
        this.lastMsgId = String(m.id);
        this.lastModel = String(m.model);
        this.queueUsage(this.lastMsgId, this.lastModel, m.usage as Json);
      } else if (event.type === 'message_delta' && this.lastMsgId && this.lastModel) {
        this.queueUsage(this.lastMsgId, this.lastModel, event.usage as Json);
      } else {
        return;
      }
      if (this.lastMsgId && this.turnByMsgId.has(this.lastMsgId) && !this.outbox.some((i) => i.kind === 'assistant' && (i.entry.message as Json).id === this.lastMsgId)) {
        await this.drainUsage(this.lastMsgId);
      }
    });
  }

  queueUsage(msgId: string, model: string, usage: Json | undefined): void {
    if (!usage) {
      return;
    }
    const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
    this.pendingUsage.set(msgId, [
      ...(this.pendingUsage.get(msgId) ?? []),
      {
        service: SERVICE,
        model,
        inputTokens: num(usage.input_tokens),
        cacheCreationTokens: num(usage.cache_creation_input_tokens),
        cacheReadTokens: num(usage.cache_read_input_tokens),
        outputTokens: num(usage.output_tokens),
      },
    ]);
  }

  async drainUsage(msgId: string): Promise<void> {
    const turnId = this.turnByMsgId.get(msgId);
    const frames = this.pendingUsage.get(msgId) ?? [];
    if (!turnId || frames.length === 0) {
      return;
    }
    this.pendingUsage.delete(msgId);
    for (const f of frames) {
      await this.publish('telemetry.usage', { ts: tsNow(), queryId: this.queryId, turnId, ...f });
    }
  }
}
