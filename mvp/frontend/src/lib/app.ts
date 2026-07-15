// lib/app.ts — the composition root. No DI: tower has one transport and no
// async-service soup (Decision 3), so plain module singletons are the wiring.
// It constructs the one transport, the concerns that fold its events, wires the
// view to the conversation concern it drives, and connects. Components import
// the concerns they read from here.

import { Approvals } from './concerns/approvals.svelte';
import { Conversations } from './concerns/conversation.svelte';
import { Rail } from './concerns/rail.svelte';
import { View } from './concerns/view.svelte';
import { Transport } from './core/transport';

export const transport = new Transport();
export const conversations = new Conversations(transport);
export const rail = new Rail(transport);
export const approvals = new Approvals(transport);
export const view = new View(conversations);

transport.connect();
