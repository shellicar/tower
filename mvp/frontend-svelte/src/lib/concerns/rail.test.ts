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

// A reconnect snapshot whose claim omits its world (towerd stores absent as
// an empty string) while the instance's own pulses carry one: the claim keys
// as "/inst-1", the instance as "mac/inst-1".
function worldlessClaimSnapshot(): ServerMsg {
  return {
    type: 'agents',
    instances: [{ world: 'mac', instanceId: 'inst-1', lastPulse: 100_000, intervalS: 15 }],
    attachments: [{ world: '', instanceId: 'inst-1', conv: 'a', cwd: '/served/here', attachedTs: 100_000 }],
  };
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

describe('detached gating', () => {
  function detached(world: string, instanceId: string): ServerMsg {
    return { type: 'agent', kind: 'detached', world, instanceId, ts: 300_000, conv: 'a' } as ServerMsg;
  }

  // Each clock sits inside the stranded threshold, so a cleared cwd is the
  // gate's doing and never liveness quietly hiding a surviving attachment.
  it('ignores a displaced instance releasing its own past claim', () => {
    const { rail, emit } = fakeTransport({ now: () => 220_000 });
    emit(attached('w1', 100_000, '/old/path'));
    emit({ ...attached('w2', 200_000, '/new/path'), instanceId: 'inst-2' } as ServerMsg);

    emit(detached('w1', 'inst-1'));

    expect(rail.liveCwd('a')).toBe('/new/path');
  });

  it('clears on the standing instance releasing', () => {
    const { rail, emit } = fakeTransport({ now: () => 120_000 });
    emit(attached('w1', 100_000, '/old/path'));

    emit(detached('w1', 'inst-1'));

    expect(rail.liveCwd('a')).toBeUndefined();
  });

  it('degrades to bare instanceId when the fact omits world', () => {
    const { rail, emit } = fakeTransport({ now: () => 120_000 });
    emit(attached('w1', 100_000, '/old/path'));

    emit(detached('', 'inst-1'));

    expect(rail.liveCwd('a')).toBeUndefined();
  });
});

describe('verdict', () => {
  it('degrades to the bare instanceId when the claim omits world', () => {
    // The dot on every rail row reads this. A claim that omits its world must
    // still find the instance that is pulsing under one, or the agents this
    // conversation is actually served by all read as nothing attached.
    const { rail, emit } = fakeTransport({ now: () => 120_000 });
    emit(worldlessClaimSnapshot());

    const expected = 'alive';
    const actual = rail.verdict('a');

    expect(actual).toBe(expected);
  });
});

describe('liveCwd', () => {
  it('reads the attachment replacing a prior one', () => {
    // A second attached for the same conv supersedes the first (agent-spec);
    // liveCwd must read the survivor, not the ghost.
    const { rail, emit } = fakeTransport({ now: () => 200_000 });
    emit(attached('w1', 100_000, '/old/path'));
    emit(attached('w2', 200_000, '/new/path'));

    expect(rail.liveCwd('a')).toBe('/new/path');
    expect(rail.liveCwd('unknown')).toBeUndefined();
  });

  it('degrades to the bare instanceId when the claim omits world', () => {
    // ws-spec is explicit that the map keys degrade to bare instanceId, not
    // only the gates.
    const { rail, emit } = fakeTransport({ now: () => 120_000 });
    emit(worldlessClaimSnapshot());

    const expected = '/served/here';
    const actual = rail.liveCwd('a');

    expect(actual).toBe(expected);
  });

  it('follows a chdir on the standing attachment', () => {
    // towerd answers a conv-leaf `moved` with an Attached fact carrying the
    // claim's ORIGINAL attachedTs (towerd views/fold.rs): same world, same
    // instance, later cwd. Nothing about that shape may look like a stale
    // fact to skip.
    const { rail, emit } = fakeTransport({ now: () => 120_000 });
    emit(attached('w1', 100_000, '/repos/tower'));

    emit(attached('w1', 100_000, '/repos/tower/mvp'));

    const expected = '/repos/tower/mvp';
    const actual = rail.liveCwd('a');

    expect(actual).toBe(expected);
  });

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
