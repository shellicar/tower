// A local stand-in for the Messages API, so a resume's first request can be
// captured without the model answering. ANTHROPIC_BASE_URL points at it for
// a run. POST /v1/messages (exactly; count_tokens and everything else is
// forwarded) is answered here with a canned one-block text reply "OK", its
// body kept as sent on the wire; every other request goes to the upstream
// (the shell's ANTHROPIC_BASE_URL, or api.anthropic.com), so account calls
// such as the claude.ai connector list still reach the real service.
//
// Choices made for these runs, not decisions (TODO: undecided, the easiest
// thing that runs): the reply text, usage numbers and ids; accept-encoding
// dropped on forwarded requests.

import { writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';

type Json = Record<string, unknown>;

export interface FakeApi {
  url: string;
  // Every faked request, in arrival order.
  requests: { n: number; file: string; body: Json; wall: number }[];
  close(): Promise<void>;
}

function sse(model: string, n: number): string {
  const id = `msg_fake_${n}`;
  const ev = (type: string, data: Json): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  return [
    ev('message_start', { message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } }),
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'OK' } }),
    ev('content_block_stop', { index: 0 }),
    ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }),
    ev('message_stop', {}),
  ].join('');
}

export function startFakeApi(args: { upstream: string; dir: string; onEvent?: (e: Json) => void }): Promise<FakeApi> {
  const upstream = new URL(args.upstream);
  const emit = args.onEvent ?? (() => {});
  const requests: FakeApi['requests'] = [];
  let n = 0;
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const path = (req.url ?? '').split('?')[0];
      if (req.method === 'POST' && path === '/v1/messages') {
        n += 1;
        let body: Json = {};
        try {
          body = JSON.parse(raw.toString('utf8')) as Json;
        } catch {
          body = { unparsed: raw.toString('utf8') };
        }
        const file = join(args.dir, `wire-${String(n).padStart(3, '0')}.request.json`);
        writeFileSync(file, raw);
        requests.push({ n, file, body, wall: Date.now() });
        emit({ kind: 'faked', n, model: body.model ?? null, stream: body.stream ?? null, file });
        const model = String(body.model ?? 'unknown');
        if (body.stream === true) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': `req_fake_${n}` });
          res.end(sse(model, n));
        } else {
          res.writeHead(200, { 'content-type': 'application/json', 'request-id': `req_fake_${n}` });
          res.end(
            JSON.stringify({ id: `msg_fake_${n}`, type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }),
          );
        }
        return;
      }
      emit({ kind: 'forward', method: req.method, path: req.url });
      const headers: Json = { ...req.headers, host: upstream.host };
      delete headers['accept-encoding'];
      const send = upstream.protocol === 'https:' ? httpsRequest : httpRequest;
      const up = send(
        { protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80), method: req.method, path: `${upstream.pathname.replace(/\/$/, '')}${req.url ?? ''}`, headers: headers as Record<string, string> },
        (upRes) => {
          emit({ kind: 'forward-response', path: req.url, status: upRes.statusCode });
          res.writeHead(upRes.statusCode ?? 502, upRes.headers);
          upRes.pipe(res);
        },
      );
      up.on('error', (err) => {
        emit({ kind: 'upstream-error', path: req.url, error: String(err) });
        if (!res.headersSent) {
          res.writeHead(502);
        }
        res.end();
      });
      up.end(raw);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}
