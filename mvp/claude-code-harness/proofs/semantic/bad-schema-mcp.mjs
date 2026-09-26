// A stdio MCP server (JSON-RPC, one message per line) offering one ordinary
// tool and one whose input schema the Anthropic API would reject, so Claude
// Code drops it and may announce that with mcp_dropped_tools_delta.
import { createInterface } from 'node:readline';

const tools = [
  { name: 'probe_ok', description: 'Returns OK.', inputSchema: { type: 'object', properties: {} } },
  { name: 'probe_bad', description: 'Has a schema the API rejects.', inputSchema: { type: 'object', properties: { x: { type: 'not-a-json-schema-type' } } } },
];

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
createInterface({ input: process.stdin }).on('line', (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  if (req.id === undefined) {
    return;
  }
  if (req.method === 'initialize') {
    send({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: req.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'bad-schema', version: '1.0.0' } } });
  } else if (req.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: req.id, result: { tools } });
  } else if (req.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: 'OK' }] } });
  } else {
    send({ jsonrpc: '2.0', id: req.id, result: {} });
  }
});
