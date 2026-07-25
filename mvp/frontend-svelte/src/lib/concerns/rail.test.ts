import { describe, expect, it } from 'vitest';
import type { Clock } from '../core/time';
import type { ClientMsg, ServerMsg } from '../types';
import type { Transport } from '../core/transport.svelte';
import { Rail } from './rail.svelte';

// A fake transport: Rail only ever calls subscribe/send/id on it. Cast past
// the nominal `Transport` type (its private fields make a plain object
// literal structurally incompatible) — the only fake here, same discipline
// as the Rust suites' one fake being the Broker.
function fakeTransport(clock?: Clock) {
  let handler: ((event: ServerMsg) => void) | undefined;
  const sent: ClientMsg[] = [];
  const transport = {
    subscribe(h: (event: ServerMsg) => void) {
      handler = h;
      return () => {
        handler = undefined;
      };
    },
    send(msg: ClientMsg) {
      sent.push(msg);
    },
    id: () => 'r1',
  } as unknown as Transport;
  return {
    rail: clock ? new Rail(transport, clock) : new Rail(transport),
    sent,
    emit: (event: ServerMsg) => handler?.(event),
  };
}

function attached(world: string, ts: number, cwd?: string): ServerMsg {
  return { type: 'agent', kind: 'attached', world, instanceId: 'inst-1', ts, conv: 'a', cwd } as ServerMsg;
}

describe('Rail attachments', () => {
  it('a new attached supersedes the old pair, never sits beside it', () => {
    const { rail, sent, emit } = fakeTransport();

    emit({
      type: 'agent',
      kind: 'attached',
      world: 'mac',
      instanceId: 'inst-1',
      ts: 1,
      conv: 'a',
    } as ServerMsg);
    emit({
      type: 'agent',
      kind: 'attached',
      world: 'vm',
      instanceId: 'inst-2',
      ts: 2,
      conv: 'a',
    } as ServerMsg);

    const potential = rail.attachedOnly;
    expect(potential.length).toBe(1);
    expect(potential[0].world).toBe('vm');
    expect(potential[0].instanceId).toBe('inst-2');

    rail.dismissAttachment('a');
    const dismiss = sent.at(-1) as Extract<ClientMsg, { type: 'dismiss_attachment' }>;
    expect(dismiss.type).toBe('dismiss_attachment');
    expect(dismiss.world).toBe('vm');
    expect(dismiss.instanceId).toBe('inst-2');
  });
});

describe('liveCwd', () => {
  it('hides the cwd of a stranded attachment', () => {
    // Attached at t=0, read at t=1000s: silence far past the stranded
    // threshold. Liveness is a fold against the clock (agent-spec); a dead
    // agent's cwd is not where the conversation is being served.
    const { rail, emit } = fakeTransport({ now: () => 1_000_000 });
    emit(attached('w1', 0, '/gone/path'));

    const actual = rail.liveCwd('a');

    expect(actual).toBeUndefined();
  });
});
