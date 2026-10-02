// The conversation shapes the proof runs live (phase A). Each is a list of
// steps driven over the bus; a resume then sends the probe on top of what the
// shape left behind.

export type Step =
  /** A say, waited for until its query closes. */
  | { say: string }
  /** A say, then a second say `afterMs` later while the first query still runs; waits until the conversation is quiet. */
  | { say: string; midTurn: string; afterMs: number }
  /** A say, then waits for `closed` queries in all (a background task's notification starts one of its own). */
  | { say: string; closed: number };

export type Shape = {
  name: string;
  /** Files written into the conversation's working directory before it starts. */
  files?: Record<string, string>;
  steps: Step[];
};

export const SHAPES: readonly Shape[] = [
  {
    name: 'text',
    steps: [{ say: 'Reply with exactly one word: lighthouse. Do not use any tools.' }, { say: 'Now reply with exactly one word: harbour. Do not use any tools.' }],
  },
  {
    name: 'thinking',
    steps: [{ say: 'Think it through carefully, without using any tools: a bat and a ball cost 1.10 in total, the bat costs 1.00 more than the ball. What does the ball cost, and why is the intuitive answer wrong? Answer in two sentences.' }],
  },
  {
    name: 'tool',
    files: { 'note.txt': 'The first word of this file is: marmalade. The second line is irrelevant.\n' },
    steps: [{ say: 'Use the Read tool on note.txt in the current directory and tell me its first word after "is:". Reply with just that word.' }],
  },
  {
    name: 'parallel',
    files: { 'a.txt': 'alpha-content\n', 'b.txt': 'bravo-content\n' },
    steps: [{ say: 'Read a.txt and b.txt in the current directory with two Read tool calls in the same response (in parallel). Then reply with both contents on one line.' }],
  },
  {
    name: 'midturn',
    steps: [{ say: 'Use the Bash tool to run `sleep 12; echo first-done`, then reply with the output.', midTurn: 'Also, when you reply, add the word banana at the end.', afterMs: 6000 }],
  },
  {
    name: 'background',
    steps: [{ say: 'Start a background task with the Bash tool (run_in_background true) that runs `sleep 5; echo bg-finished`. After starting it, reply with the single word: started. Do not wait for it.', closed: 2 }],
  },
  {
    name: 'compact',
    steps: [{ say: 'Reply with exactly one word: one. Do not use any tools.' }, { say: 'Reply with exactly one word: two. Do not use any tools.' }, { say: '/compact' }],
  },
];

/** The prompt a resume sends: the request this carries is what the two methods are compared on. */
export function probeFor(shape: string): string {
  return `PROBE-${shape.toUpperCase()}: reply with exactly one word, no tools.`;
}
