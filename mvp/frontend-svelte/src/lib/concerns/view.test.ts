// @vitest-environment jsdom
// jsdom for localStorage alone: View reads the persisted active tab in a
// field initialiser, so constructing one needs a browser storage to exist.
import { describe, expect, it } from 'vitest';
import type { Transport } from '../core/transport.svelte';
import type { Conversations } from './conversation.svelte';
import { View } from './view.svelte';

// Fakes for the two collaborators View only ever calls a handful of methods
// on; cast past the nominal types, the same discipline rail.test.ts uses.
function newView(): View {
  const transport = {
    subscribe: () => () => {},
    onConnect: () => {},
    send: () => {},
    id: () => 'r1',
  } as unknown as Transport;
  const conversations = {
    setOpen: () => {},
    open: () => {},
    close: () => {},
  } as unknown as Conversations;
  return new View(conversations, transport);
}

describe('the rail id search', () => {
  it('starts empty', () => {
    const expected = '';

    const actual = newView().convSearch;

    expect(actual).toBe(expected);
  });

  it('does not survive a tab switch', () => {
    const view = newView();
    view.addTab();
    view.convSearch = 'aa-11';

    view.switchTab(0);

    const expected = '';
    const actual = view.convSearch;

    expect(actual).toBe(expected);
  });
});
