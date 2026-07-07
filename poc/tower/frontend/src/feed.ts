// The event feed seam: folding logic depends on this interface, not on a
// socket, so tests can drive it with scripted events.

/** What the backend sends per WebSocket message: the raw agent event, tagged. */
export interface TaggedEvent {
  agentId: string;
  event: Record<string, unknown>;
}

export type FeedStatus = "connecting" | "open" | "closed";

export interface EventFeed {
  onEvent(handler: (e: TaggedEvent) => void): void;
  onStatus(handler: (s: FeedStatus) => void): void;
}

/** Real implementation: a WebSocket to the backend, reconnecting on drop. */
export class WebSocketFeed implements EventFeed {
  private eventHandlers: Array<(e: TaggedEvent) => void> = [];
  private statusHandlers: Array<(s: FeedStatus) => void> = [];

  constructor(private readonly url: string) {
    this.connect();
  }

  onEvent(handler: (e: TaggedEvent) => void): void {
    this.eventHandlers.push(handler);
  }

  onStatus(handler: (s: FeedStatus) => void): void {
    this.statusHandlers.push(handler);
  }

  private emitStatus(s: FeedStatus): void {
    for (const h of this.statusHandlers) h(s);
  }

  private connect(): void {
    this.emitStatus("connecting");
    const ws = new WebSocket(this.url);
    ws.onopen = () => this.emitStatus("open");
    ws.onmessage = (msg: MessageEvent) => {
      if (typeof msg.data !== "string") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(msg.data);
      } catch {
        return; // not JSON: skip, per forward compatibility
      }
      if (!isTaggedEvent(parsed)) return;
      for (const h of this.eventHandlers) h(parsed);
    };
    ws.onclose = () => {
      this.emitStatus("closed");
      setTimeout(() => this.connect(), 2000);
    };
  }
}

function isTaggedEvent(v: unknown): v is TaggedEvent {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.agentId === "string" && typeof o.event === "object" && o.event !== null;
}
