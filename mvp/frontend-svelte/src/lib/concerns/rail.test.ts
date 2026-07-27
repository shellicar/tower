import { describe, expect, it } from 'vitest';
import type { ClientMsg, ServerMsg } from '../types';
import type { Transport } from '../core/transport.svelte';
import { Rail } from './rail.svelte';

// A fake transport: Rail only ever calls subscribe/send/id on it. Cast past
// the nominal `Transport` type (its private fields make a plain object
// literal structurally incompatible) — the only fake here, same discipline
// as the Rust suites' one fake being the Broker.
function fakeTransport() {
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
  return { transport, sent, emit: (event: ServerMsg) => handler?.(event) };
}

describe('Rail attachments', () => {
  it('a new attached supersedes the old pair, never sits beside it', () => {
    const { transport, sent, emit } = fakeTransport();
    const rail = new Rail(transport);

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
