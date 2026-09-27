// Proof 20, problem 3: making Claude Code retry, and seeing which request
// bodies were attempts.
//
// Tunnel: an HTTP CONNECT proxy on 127.0.0.1 that Claude Code reaches through
// HTTPS_PROXY. It only pipes bytes: the TLS session runs end to end between
// Claude Code and the API, so the proxy never sees a header, a token or a
// body. To fail a request it destroys the open tunnels to the API host (the
// request in flight gets a connection reset, which Claude Code retries).
// ANTHROPIC_BASE_URL is deliberately not used: that would put the login's
// bearer token through this process in the clear.
//
// Otel: a receiver for Claude Code's documented OTLP/HTTP JSON log export
// (CLAUDE_CODE_ENABLE_TELEMETRY, OTEL_LOGS_EXPORTER=otlp). Claude Code emits
// one `api_request_body` event per attempt, with query_source and the request
// file's id (request_body_id): the ground truth for attempts that never got an
// index.jsonl line. Only the event name, those attributes and the time are
// kept; the rest of each record (account, organisation, email attributes) is
// dropped on receipt.
//
// TODO: undecided (proof mechanism, not a proposal): both channels exist for
// this proof only.

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import { stamp } from '../../src/record.mts';

export const API_HOST = 'api.anthropic.com';

export interface TunnelEvent {
  at: string;
  ms: number;
  event: 'open' | 'close' | 'kill';
  host: string;
  id: number;
  // Bytes each way when it closed or was killed.
  up?: number;
  down?: number;
  why?: string;
}

export class Tunnel {
  readonly server: Server;
  port = 0;
  readonly open = new Map<number, { host: string; client: Socket; upstream: Socket; up: number; down: number }>();
  readonly events: TunnelEvent[] = [];
  onEvent: (e: TunnelEvent) => void = () => {};
  next = 1;
  constructor() {
    this.server = createHttpServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(405).end();
    });
    this.server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
      const [host = '', portText = '443'] = String(req.url).split(':');
      const id = this.next++;
      const upstream = netConnect(Number(portText), host, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) {
          upstream.write(head);
        }
        client.pipe(upstream);
        upstream.pipe(client);
      });
      const t = { host, client, upstream, up: head.length, down: 0 };
      this.open.set(id, t);
      client.on('data', (d: Buffer) => {
        t.up += d.length;
      });
      upstream.on('data', (d: Buffer) => {
        t.down += d.length;
      });
      const close = (): void => {
        if (this.open.delete(id)) {
          this.note({ at: stamp(), ms: Date.now(), event: 'close', host, id, up: t.up, down: t.down });
        }
        client.destroy();
        upstream.destroy();
      };
      client.on('close', close);
      upstream.on('close', close);
      client.on('error', close);
      upstream.on('error', close);
      this.note({ at: stamp(), ms: Date.now(), event: 'open', host, id });
    });
  }
  note(e: TunnelEvent): void {
    this.events.push(e);
    this.onEvent(e);
  }
  async start(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const addr = this.server.address();
    this.port = typeof addr === 'object' && addr ? addr.port : 0;
    return this.port;
  }
  // Reset every open tunnel to the API host. Returns how many.
  kill(why: string): number {
    let n = 0;
    for (const [id, t] of [...this.open]) {
      if (t.host !== API_HOST) {
        continue;
      }
      this.open.delete(id);
      this.note({ at: stamp(), ms: Date.now(), event: 'kill', host: t.host, id, up: t.up, down: t.down, why });
      t.client.resetAndDestroy();
      t.upstream.destroy();
      n += 1;
    }
    return n;
  }
  async stop(): Promise<void> {
    for (const t of this.open.values()) {
      t.client.destroy();
      t.upstream.destroy();
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

export interface OtelEvent {
  at: string;
  ms: number;
  name: string;
  // Event time as Claude Code stamped it.
  eventTime: string | undefined;
  attrs: Record<string, string>;
}

const KEEP = new Set(['event.name', 'query_source', 'request_body_id', 'body_ref', 'model', 'request_id', 'message.id', 'message.uuid', 'body_length', 'attempt', 'status_code', 'error', 'duration_ms']);

export class Otel {
  readonly server: Server;
  port = 0;
  readonly events: OtelEvent[] = [];
  onEvent: (e: OtelEvent) => void = () => {};
  constructor() {
    this.server = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const at = stamp();
        const ms = Date.now();
        if (req.url?.startsWith('/v1/logs')) {
          try {
            this.take(JSON.parse(Buffer.concat(chunks).toString('utf8')), at, ms);
          } catch {
            // Not JSON (a protobuf export): nothing kept.
          }
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      });
    });
  }
  take(payload: unknown, at: string, ms: number): void {
    const p = payload as { resourceLogs?: { scopeLogs?: { logRecords?: { timeUnixNano?: string; body?: { stringValue?: string }; attributes?: { key: string; value: Record<string, unknown> }[] }[] }[] }[] };
    for (const rl of p.resourceLogs ?? []) {
      for (const sl of rl.scopeLogs ?? []) {
        for (const r of sl.logRecords ?? []) {
          const attrs: Record<string, string> = {};
          for (const a of r.attributes ?? []) {
            if (KEEP.has(a.key)) {
              const v = a.value;
              attrs[a.key] = String(v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue ?? '');
            }
          }
          const name = attrs['event.name'] ?? String(r.body?.stringValue ?? '');
          const nano = r.timeUnixNano ? Number(BigInt(r.timeUnixNano) / 1000000n) : undefined;
          const e: OtelEvent = { at, ms, name, eventTime: nano ? new Date(nano).toISOString() : undefined, attrs };
          this.events.push(e);
          this.onEvent(e);
        }
      }
    }
  }
  async start(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const addr = this.server.address();
    this.port = typeof addr === 'object' && addr ? addr.port : 0;
    return this.port;
  }
  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

// Claude Code's environment for both channels.
export function faultEnv(tunnelPort: number, otelPort: number): Record<string, string> {
  return {
    HTTPS_PROXY: `http://127.0.0.1:${tunnelPort}`,
    NO_PROXY: '127.0.0.1,localhost',
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_METRICS_EXPORTER: 'none',
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://127.0.0.1:${otelPort}/v1/logs`,
    OTEL_LOGS_EXPORT_INTERVAL: '200',
  };
}
