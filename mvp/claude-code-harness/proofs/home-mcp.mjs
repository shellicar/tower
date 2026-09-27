// Proof 26's stdio MCP server: reports what home it was started with. No
// dependencies; newline-delimited JSON-RPC as MCP's stdio transport speaks it.
// On start it appends one line to the log named by argv[2]; its one tool,
// home_probe, returns the same facts to the model.
//
//   node proofs/home-mcp.mjs <log file>

import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { createInterface } from 'node:readline';

const logFile = process.argv[2];

function facts() {
  // Inside a repo (P26_REPO), since the identity comes through includeIf.
  const repo = process.env.P26_REPO ?? '.';
  const ident = spawnSync('git', ['-C', repo, 'var', 'GIT_AUTHOR_IDENT'], { encoding: 'utf8' });
  const origins = spawnSync('git', ['-C', repo, 'config', '--show-origin', '--get-regexp', '^(user\\.|includeif\\.|include\\.)'], { encoding: 'utf8' });
  return {
    tag: process.env.P26_TAG ?? null,
    HOME: process.env.HOME ?? null,
    homedir: homedir(),
    passwdHome: userInfo().homedir,
    uid: process.getuid?.() ?? null,
    gitIdentInRepoExit: ident.status,
    gitConfigOrigins: [...new Set(origins.stdout.split('\n').filter(Boolean).map((l) => l.split('\t')[0]))],
  };
}

if (logFile) appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), event: 'start', ...facts() })}\n`);

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  if (req.id === undefined) return;
  if (req.method === 'initialize') {
    send({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: req.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'p26-home', version: '0.0.0' } } });
  } else if (req.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: req.id, result: { tools: [{ name: 'home_probe', description: 'Reports the HOME this MCP server was started with.', inputSchema: { type: 'object', properties: {} } }] } });
  } else if (req.method === 'tools/call') {
    const f = facts();
    if (logFile) appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), event: 'call', ...f })}\n`);
    send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: JSON.stringify(f) }] } });
  } else {
    send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'method not found' } });
  }
});
