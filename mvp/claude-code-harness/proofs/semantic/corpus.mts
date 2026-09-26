// Reading a recorded run offline: its main-thread entries in record order and
// its main-thread requests, grouped so each request is paired with the
// entries written since the previous response.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ApiMessage, Json } from './form.mts';

export function readJsonl(path: string): Json[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Json);
}

export interface Request {
  line: number;
  file: string;
  messageId: string;
  model: string;
  body: Json & { messages: ApiMessage[]; model: string; thread?: Json };
  response: Json | undefined;
}

export function mainRequests(runDir: string): Request[] {
  const dir = join(runDir, 'api-bodies');
  const index = join(dir, 'index.jsonl');
  if (!existsSync(index)) {
    return [];
  }
  return readJsonl(index).flatMap((e, i) => {
    if (e.query_source !== 'sdk') {
      return [];
    }
    const reqPath = join(dir, String(e.request_file));
    if (!existsSync(reqPath)) {
      return [];
    }
    const respPath = join(dir, String(e.response_file));
    const body = JSON.parse(readFileSync(reqPath, 'utf8')) as Request['body'];
    return [
      {
        line: i + 1,
        file: String(e.request_file),
        messageId: String(e.message_id),
        model: String(e.model),
        body,
        response: existsSync(respPath) ? (JSON.parse(readFileSync(respPath, 'utf8')) as Json) : undefined,
      },
    ];
  });
}

// The run's main-thread entries in record order: what the session store was
// given (after what load() returned, for a resume), else the transcript file.
export function runEntries(runDir: string, sessionId: string | undefined): { entries: Json[]; source: string } {
  const appends = join(runDir, 'store-appends.jsonl');
  if (existsSync(appends)) {
    const loaded = join(runDir, 'loaded-entries.jsonl');
    const before = existsSync(loaded) ? readJsonl(loaded) : [];
    const after = readJsonl(appends)
      .filter((a) => !(a.key as Json).subpath)
      .flatMap((a) => a.entries as Json[]);
    return { entries: [...before, ...after], source: existsSync(loaded) ? 'loaded-entries.jsonl + store-appends.jsonl' : 'store-appends.jsonl' };
  }
  const projects = join(runDir, 'config-dir', 'projects');
  if (existsSync(projects)) {
    for (const p of readdirSync(projects)) {
      for (const f of readdirSync(join(projects, p))) {
        if (f.endsWith('.jsonl') && (sessionId === undefined || f === `${sessionId}.jsonl`)) {
          return { entries: readJsonl(join(projects, p, f)), source: `config-dir/projects/${p}/${f}` };
        }
      }
    }
  }
  return { entries: [], source: 'none' };
}

export interface Group {
  request: Request;
  // Entries written after the previous response's last entry and before
  // this response's first, in record order.
  pending: Json[];
  // Index in the entry list of this response's first assistant entry.
  at: number;
}

export function groups(entries: Json[], requests: Request[]): Group[] {
  const main = entries.filter((e) => e.isSidechain !== true);
  const out: Group[] = [];
  // Everything written after the previous response started (a tool_result
  // can land between two pieces of one response: parallel tool calls) and
  // before this response's first piece.
  let from = 0;
  for (const r of requests) {
    const at = main.findIndex((e, i) => i >= from && e.type === 'assistant' && (e.message as Json | undefined)?.id === r.messageId);
    if (at < 0) {
      continue;
    }
    let start = from;
    if (out.length === 0) {
      // The first request of a resumed run: its history came from load().
      for (let i = at - 1; i >= 0; i -= 1) {
        if (main[i]?.type === 'assistant') {
          start = i + 1;
          break;
        }
      }
    }
    out.push({ request: r, pending: main.slice(start, at).filter((e) => e.type !== 'assistant'), at });
    from = at + 1;
  }
  return out;
}

export function sessionIdOf(runDir: string): string | undefined {
  const index = join(runDir, 'api-bodies', 'index.jsonl');
  if (!existsSync(index)) {
    return undefined;
  }
  const first = readJsonl(index).find((e) => e.query_source === 'sdk');
  return first ? String(first.session_id) : undefined;
}
