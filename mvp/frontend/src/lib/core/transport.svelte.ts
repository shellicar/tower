// core/transport.ts — the one thing that touches the wire (docs/mvp/
// frontend-architecture.md). It owns the socket, decodes each frame into a
// typed event and dispatches it, correlates id-carrying requests to their
// response, and holds connection state. It holds NO domain state: it knows
// bytes and events, never conversations, approvals, or rows.

import type { ClientMsg, ServerMsg } from '../types';

type EventHandler = (event: ServerMsg) => void;

export class Transport {
  /** Socket state, for the shell's live/reconnecting badge. */
  connected = $state(false);

  #ws: WebSocket | null = null;
  #nextId = 1;
  #retryMs = 500;
  /** Broadcast subscribers — every concern that folds inbound events. */
  #handlers = new Set<EventHandler>();
  /** id → resolver, for request/response (say, answer, cancel). */
  #pending = new Map<string, (event: ServerMsg) => void>();
  /** Run on every (re)connection — concerns re-request what they need. */
  #onConnect = new Set<() => void>();

  /** A client-minted request id; any unique string (ws-spec). */
  id(): string {
    return `r${this.#nextId++}`;
  }

  /** Subscribe to every inbound event; a concern filters by type itself.
   *  Returns an unsubscribe. */
  subscribe(handler: EventHandler): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  /** Run f whenever a connection opens (the first included) — the moment a
   *  concern re-requests its state (e.g. re-`open` conversations with `after`).
   *  The snapshots towerd sends unasked (list, approvals, agents) arrive as
   *  ordinary events; this is only for what the client must ask for. */
  onConnect(f: () => void): () => void {
    this.#onConnect.add(f);
    return () => this.#onConnect.delete(f);
  }

  /** Fire-and-forget — open / close / set_title / set_tag. Dropped if the
   *  socket is not open: the reconnect path re-establishes state by re-request,
   *  so a lost in-flight message is recovered, not retried. */
  send(msg: ClientMsg): void {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(msg));
    } else {
      console.warn('transport: send dropped (socket not open)', msg.type);
    }
  }

  /** An id-correlated request — resolves with the response frame that echoes
   *  the msg's id (say_result / answer_result / cancel_result, or error). The
   *  caller mints the id via id() and includes it. */
  request(msg: ClientMsg): Promise<ServerMsg> {
    return new Promise((resolve) => {
      this.#pending.set(msg.id, resolve);
      this.send(msg);
    });
  }

  connect(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    console.log('transport: connecting', `${proto}://${location.host}/ws`);
    this.#ws = ws;

    ws.onopen = () => {
      console.log('transport: connected');
      this.connected = true;
      this.#retryMs = 500;
      for (const f of [...this.#onConnect]) f();
    };
    ws.onmessage = (e) => {
      let event: ServerMsg;
      try {
        event = JSON.parse(e.data);
      } catch (err) {
        console.error('transport: unparseable frame', err, e.data);
        return; // tolerance: an unparseable frame is skipped, never fatal
      }
      this.#dispatch(event);
    };
    ws.onclose = (e) => {
      console.log('transport: socket closed', e.code, e.reason);
      this.connected = false;
      this.#ws = null;
      setTimeout(() => this.connect(), this.#retryMs);
      this.#retryMs = Math.min(this.#retryMs * 2, 10_000);
    };
  }

  #dispatch(event: ServerMsg): void {
    // A response to an outstanding request resolves it and does NOT broadcast —
    // the requester owns it. Only request() registers a pending id, so ack/
    // snapshot frames that happen to carry an id (conversation, title_set…)
    // fall through to the concerns. Everything else fans out.
    const id = 'id' in event ? (event as { id?: string }).id : undefined;
    if (id !== undefined && this.#pending.has(id)) {
      const resolve = this.#pending.get(id)!;
      this.#pending.delete(id);
      resolve(event);
      return;
    }
    for (const handler of [...this.#handlers]) {
      try {
        handler(event);
      } catch (err) {
        console.error('transport: handler failed on', event.type, err);
      }
    }
  }
}
