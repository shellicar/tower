// Proof 18's stand-in for a server the participant passes itself: a stdio
// MCP server with one tool, speaking newline-delimited JSON-RPC by hand (no
// MCP SDK dependency). It shows whether a way of keeping the claude.ai
// connectors out also keeps a passed server out.

import { createInterface } from 'node:readline';

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) {
    return;
  }
  if (msg.method === 'initialize') {
    reply(msg.id, { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'tower-proof-18-dummy', version: '0.0.0' } });
  } else if (msg.method === 'tools/list') {
    reply(msg.id, { tools: [{ name: 'dummy_echo', description: 'Echoes its input. Proof 18 stand-in; never needed.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] });
  } else if (msg.method === 'tools/call') {
    reply(msg.id, { content: [{ type: 'text', text: String(msg.params?.arguments?.text ?? '') }] });
  } else {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } })}\n`);
  }
});
