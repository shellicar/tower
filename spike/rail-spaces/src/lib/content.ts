import type { Row } from '../fixture';

// Stand-in message content, so a panel can be judged at the size it will
// really be. Derived from the conversation's id, so every panel is different
// and the same conversation reads the same way every reload.

export type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; name: string; input: unknown }
  | { type: 'tool_result'; content: string; is_error?: boolean };

export type Message = {
  id: string;
  role: 'user' | 'assistant';
  from?: { kind: string };
  content: Block[];
  ts: number;
};

export type Usage = {
  model: string;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  contextTokens: number;
  turns: number;
  costUsd: number;
};

function seed(text: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const asks = [
  'Have a look at this and tell me what you find.',
  'This is still failing on the second run. Why?',
  'Can you take it from here and finish it off.',
  'What changed? It worked yesterday.',
  'Go through it properly before you change anything.',
  'Do that, then show me the diff.',
];

const paras = [
  'The cause is narrower than it looks. One call site reads the list directly, so when the two states diverge it silently picks the older one and nothing downstream can tell.',
  'I checked both ends before touching anything. The fold is fine; what breaks is the order the two snapshots arrive in, which is not fixed and never was.',
  'Two of the three cases are already covered. The third only shows up when the process restarts mid-run, which is why it looked intermittent.',
  'That reads as working because the assertion is on the mechanism rather than on what came out. Change the implementation and it still passes.',
  'It is one line, but the line is load-bearing: removing it drops the correction that keeps the estimate honest across browser versions.',
];

const tools: { name: string; input: unknown; result: string }[] = [
  {
    name: 'Read',
    input: { paths: ['src/lib/concerns/rail.svelte.ts'] },
    result: '  1 | // concerns/rail.svelte.ts — the staleness rail\n  2 | import { type Clock } from ...\n… 412 more lines',
  },
  {
    name: 'Exec',
    input: { commands: [{ program: 'pnpm', args: ['test'] }], timeout: 180 },
    result: '✓ src/model/layout.test.ts (52 tests) 3ms\n\n Test Files  1 passed (1)\n      Tests  52 passed (52)',
  },
  {
    name: 'Match',
    input: { paths: ['src/lib'], pattern: 'placement|spaceOf' },
    result: 'src/lib/Rail.svelte:74:  {@const where = live.model.spaceOf(conv)}\nsrc/lib/Panels.svelte:21:  const away = ...',
  },
  {
    name: 'EditFile',
    input: { path: 'src/model/layout.ts', textEdits: [{ action: 'replace_text', oldString: '…', replacement: '…' }] },
    result: ' 215 |   railRows(convs: readonly ConvId[]): ConvId[] {\n+216 |     if (this.#search !== "") return …',
  },
  {
    name: 'Exec',
    input: { commands: [{ program: 'cargo', args: ['clippy', '--workspace'] }], timeout: 600 },
    result: 'error[E0308]: mismatched types\n  --> crates/towerd/src/views.rs:212:33\n   | expected `&str`, found `String`',
  },
];

export function messagesFor(row: Row): Message[] {
  const rand = seed(row.conv);
  const turns = 2 + Math.floor(rand() * 7);
  const title = row.title ?? row.conv;
  const messages: Message[] = [];
  let ts = row.lastEvent - turns * 11 * 60_000;

  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)] as T;

  messages.push({
    id: `${row.conv}-0`,
    role: 'user',
    from: { kind: 'human' },
    content: [{ type: 'text', text: `${title}\n\n${pick(asks)}` }],
    ts,
  });

  for (let turn = 0; turn < turns; turn += 1) {
    ts += 4 * 60_000 + Math.floor(rand() * 6 * 60_000);
    const blocks: Block[] = [];
    if (rand() < 0.6)
      blocks.push({
        type: 'thinking',
        thinking: `${pick(paras)}\n\nSo the thing to check first is whether ${title.toLowerCase()} is even reached on that path.`,
      });
    const body =
      rand() < 0.5
        ? `${pick(paras)}\n\n**What I changed**\n\n- \`${title}\`: the read now goes through the query rather than the array\n- one test pins the order, because that is the part that broke\n\n${pick(paras)}`
        : pick(paras);
    blocks.push({ type: 'text', text: body });
    if (rand() < 0.7) {
      const tool = pick(tools);
      blocks.push({ type: 'tool_use', name: tool.name, input: tool.input });
      messages.push({
        id: `${row.conv}-a${turn}`,
        role: 'assistant',
        from: { kind: 'agent' },
        content: blocks,
        ts,
      });
      ts += 20_000 + Math.floor(rand() * 90_000);
      messages.push({
        id: `${row.conv}-r${turn}`,
        role: 'user',
        content: [{ type: 'tool_result', content: tool.result, is_error: rand() < 0.15 }],
        ts,
      });
    } else {
      messages.push({
        id: `${row.conv}-a${turn}`,
        role: 'assistant',
        from: { kind: 'agent' },
        content: blocks,
        ts,
      });
      if (turn < turns - 1) {
        ts += 60_000 + Math.floor(rand() * 20 * 60_000);
        messages.push({
          id: `${row.conv}-u${turn}`,
          role: 'user',
          from: { kind: 'human' },
          content: [{ type: 'text', text: pick(asks) }],
          ts,
        });
      }
    }
  }

  const last = messages[messages.length - 1] as Message;
  last.ts = row.lastEvent;
  return messages;
}

export function usageFor(row: Row): Usage {
  const rand = seed(`${row.conv}-usage`);
  const turns = 3 + Math.floor(rand() * 40);
  const inputTokens = 2_000 + Math.floor(rand() * 30_000);
  const outputTokens = 3_000 + Math.floor(rand() * 60_000);
  const cacheCreationTokens = 20_000 + Math.floor(rand() * 400_000);
  const cacheReadTokens = 200_000 + Math.floor(rand() * 8_000_000);
  return {
    model: 'claude-sonnet-4-5-20250929',
    inputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    outputTokens,
    contextTokens: 20_000 + Math.floor(rand() * 150_000),
    turns,
    costUsd:
      (inputTokens * 3 + cacheCreationTokens * 3.75 + cacheReadTokens * 0.3 + outputTokens * 15) /
      1_000_000,
  };
}
