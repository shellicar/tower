// A local forwarder for the cancel scenarios' API-error and network endings
// (F2, F3) and a held response (D1): ANTHROPIC_BASE_URL points at it for a
// run, it forwards every request to the upstream (the shell's own
// ANTHROPIC_BASE_URL, or api.anthropic.com), and on a request whose LAST
// user message contains a marker it does one of:
//   status   answer with an injected error status and an Anthropic-shaped
//            error body instead of forwarding (the upstream never sees it)
//   cut      forward, pass the response through, and destroy the client
//            connection after N SSE content_block_delta events
//   hold     forward, but hold the response for N ms before passing it on
// `times` limits how many matching requests are acted on (retries of the
// same request match again); later ones pass through untouched.
//
// Injected errors are injected: nothing here reaches the real API as an
// error. Only this process's own connections are cut.
//
// Choices made for these runs, not decisions (TODO: undecided, the easiest
// thing that runs): matching on the last user message's text; the error
// bodies' wording; accept-encoding dropped on forwarded requests so SSE
// events can be counted.
//
//   node proofs/cancel/forwarder.mts --port 18990 [--upstream URL] --rule '<json>' [--rule ...]
//   rule: {"marker":"ZX1","action":"status","status":429,"times":1,"retryAfter":1}
//         {"marker":"ZX2","action":"cut","afterDeltas":5}
//         {"marker":"ZX3","action":"hold","ms":5000}
// Each event is one JSON line on stdout.

import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { fileURLToPath } from 'node:url';

export interface Rule {
  marker: string;
  action: 'status' | 'cut' | 'hold';
  status?: number;
  retryAfter?: number;
  afterDeltas?: number;
  ms?: number;
  times?: number;
}

export interface Forwarder {
  port: number;
  url: string;
  close(): Promise<void>;
}

type Json = Record<string, unknown>;

const ERROR_TYPES: Record<number, string> = { 429: 'rate_limit_error', 529: 'overloaded_error', 500: 'api_error', 502: 'api_error', 503: 'api_error', 504: 'api_error' };

function lastUserText(body: Json): string {
  const msgs = body.messages;
  if (!Array.isArray(msgs) || msgs.length === 0) {
    return '';
  }
  const last = msgs[msgs.length - 1] as Json;
  if (last.role !== 'user') {
    return '';
  }
  const c = last.content;
  if (typeof c === 'string') {
    return c;
  }
  if (Array.isArray(c)) {
    return (c as Json[]).map((b) => (typeof b.text === 'string' ? b.text : '')).join('\n');
  }
  return '';
}

export function startForwarder(args: { port: number; upstream: string; rules: Rule[]; onEvent?: (e: Json) => void }): Promise<Forwarder> {
  const upstream = new URL(args.upstream);
  const used = new Map<Rule, number>();
  const emit = args.onEvent ?? ((e: Json) => process.stdout.write(`${JSON.stringify(e)}\n`));
  let n = 0;
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const id = ++n;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      let body: Json = {};
      try {
        body = JSON.parse(raw.toString('utf8')) as Json;
      } catch {
        body = {};
      }
      const text = lastUserText(body);
      const rule = args.rules.find((r) => text.includes(r.marker) && (r.times === undefined || (used.get(r) ?? 0) < r.times));
      const base = { ts: new Date().toISOString(), wall: Date.now(), id, method: req.method, path: req.url, model: body.model ?? null };
      if (rule) {
        used.set(rule, (used.get(rule) ?? 0) + 1);
      }
      emit({ ...base, kind: 'request', rule: rule ? { ...rule, use: used.get(rule) } : null });
      if (rule?.action === 'status') {
        const status = rule.status ?? 500;
        const type = ERROR_TYPES[status] ?? 'api_error';
        const headers: Record<string, string> = { 'content-type': 'application/json', 'request-id': `req_injected_${id}` };
        if (rule.retryAfter !== undefined) {
          headers['retry-after'] = String(rule.retryAfter);
        }
        res.writeHead(status, headers);
        res.end(JSON.stringify({ type: 'error', error: { type, message: `Injected ${status} by the cancel-scenarios forwarder` }, request_id: `req_injected_${id}` }));
        emit({ ts: new Date().toISOString(), wall: Date.now(), id, kind: 'injected', status });
        return;
      }
      const headers: Json = { ...req.headers, host: upstream.host };
      delete headers['accept-encoding'];
      const send = upstream.protocol === 'https:' ? httpsRequest : httpRequest;
      const up = send(
        { protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80), method: req.method, path: `${upstream.pathname.replace(/\/$/, '')}${req.url ?? ''}`, headers: headers as Record<string, string> },
        (upRes) => {
          const pass = (): void => {
            emit({ ts: new Date().toISOString(), wall: Date.now(), id, kind: 'response', status: upRes.statusCode });
            res.writeHead(upRes.statusCode ?? 502, upRes.headers);
            let deltas = 0;
            let cut = false;
            upRes.on('data', (c: Buffer) => {
              if (cut) {
                return;
              }
              if (rule?.action === 'cut') {
                const s = c.toString('utf8');
                const before = deltas;
                deltas += (s.match(/event: content_block_delta/g) ?? []).length;
                if (deltas >= (rule.afterDeltas ?? 1)) {
                  // Pass through up to the chunk that crossed the line, then cut.
                  res.write(c);
                  cut = true;
                  emit({ ts: new Date().toISOString(), wall: Date.now(), id, kind: 'cut', deltasBefore: before, deltas });
                  req.socket.destroy();
                  up.destroy();
                  return;
                }
              }
              res.write(c);
            });
            upRes.on('end', () => {
              if (!cut) {
                res.end();
                emit({ ts: new Date().toISOString(), wall: Date.now(), id, kind: 'end' });
              }
            });
            upRes.on('error', (err) => emit({ ts: new Date().toISOString(), wall: Date.now(), id, kind: 'upstream-error', error: String(err) }));
            // A stream paused explicitly (hold) does not flow again when a
            // data listener is added.
            upRes.resume();
          };
          if (rule?.action === 'hold') {
            emit({ ts: new Date().toISOString(), wall: Date.now(), id, kind: 'hold', ms: rule.ms ?? 0 });
            upRes.pause();
            setTimeout(pass, rule.ms ?? 0);
          } else {
            pass();
          }
        },
      );
      up.on('error', (err) => {
        emit({ ts: new Date().toISOString(), wall: Date.now(), id, kind: 'upstream-error', error: String(err) });
        if (!res.headersSent) {
          res.writeHead(502);
        }
        res.end();
      });
      // The client going away (not the request body ending, which is what
      // req's own 'close' means).
      res.on('close', () => {
        if (!res.writableFinished) {
          emit({ ts: new Date().toISOString(), wall: Date.now(), id, kind: 'client-closed' });
          up.destroy();
        }
      });
      up.end(raw);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(args.port, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : args.port;
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const rules: Rule[] = [];
  let port = 0;
  let upstream = process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com';
  for (let i = 0; i < args.length; i += 2) {
    const [k, v] = [args[i], args[i + 1] ?? ''];
    if (k === '--port') {
      port = Number(v);
    } else if (k === '--upstream') {
      upstream = v;
    } else if (k === '--rule') {
      rules.push(JSON.parse(v) as Rule);
    } else {
      process.stderr.write(`unknown argument ${k}\n`);
      process.exit(2);
    }
  }
  const f = await startForwarder({ port, upstream, rules });
  process.stdout.write(`${JSON.stringify({ kind: 'listening', url: f.url, upstream, rules })}\n`);
  const stop = (): void => {
    void f.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
