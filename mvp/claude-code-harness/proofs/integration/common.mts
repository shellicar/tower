// Integration proof: what the scenarios share. The declared config values,
// the prompts, the endings' cells (from proofs/reconcile/run.mts), resets,
// and where evidence goes.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clean, fileStamp, iso, type Json, type Known, PACKAGE_ROOT, RUNS } from './lib.mts';
import type { Spec } from './participant.mts';

// TODO: undecided. The declared values (design.md, Undecided: values): each
// is passed explicitly, none is Claude Code's default by omission. Built:
//   effort 'medium'; system prompt Claude Code's preset (Claude Code as
//   Claude Code), no own text; permission mode 'auto' (the target; a cell's
//   tool refused by auto mode is reported, never routed around);
//   max tokens 32000 (under Haiku 4.5's 64k cap and the 128k of the others);
//   thinking adaptive + summarized (settled).
export const DECLARED = {
  effort: 'medium' as const,
  systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const },
  permissionMode: 'auto' as const,
  maxTokens: 32000,
  thinking: { type: 'adaptive' as const, display: 'summarized' as const },
};

export const WARM = 'Reply with the word READY only.';
export const PROBE = 'Reply with the word NEXT only.';
const HARD = 'Work out, carefully and step by step, how many integers from 1 to 300 are divisible by 3 or by 5 but not by 7.';
const NO_TOOLS = 'Answer in your reply itself; do not use any tools.';

export interface Cell {
  id: string;
  prompt: string;
  ending?: string;
  // Claude Code env for the live run only (the cell's trigger).
  env?: Record<string, string>;
  // Declared max tokens for every run of the cell (the limit cell's trigger
  // is the declared value itself).
  maxTokens?: number;
}

// Proof 23/24/reconcile's cells and triggers (proofs/reconcile/run.mts),
// the api-error cell's timeout included (RC_ERROR_TIMEOUT overrides there;
// INT_ERROR_TIMEOUT here), the limit cell's 64 (INT_LIMIT).
export function cells(model: string): Cell[] {
  const errorTimeout = process.env.INT_ERROR_TIMEOUT ?? (/haiku/.test(model) ? '100' : /fable/.test(model) ? '300' : '800');
  return [
    { id: 'normal', prompt: `What is 17 times 23? Work it out, then reply with the number only. ${NO_TOOLS}` },
    { id: 'thinking-only', prompt: `Think carefully about whether 391 is prime. Then end your turn with an empty reply: write no text at all, not even a single word or punctuation mark. ${NO_TOOLS}` },
    { id: 'limit', prompt: `${HARD} Reply with the number only. ${NO_TOOLS}`, maxTokens: Number(process.env.INT_LIMIT ?? '64') },
    { id: 'api-error', prompt: `What is 17 times 23? Work it out, then reply with the number only. ${NO_TOOLS}`, env: { API_TIMEOUT_MS: errorTimeout, CLAUDE_CODE_MAX_RETRIES: '2' } },
    { id: 'first-byte', prompt: `What is 17 times 23? Reply with the number only. ${NO_TOOLS}`, ending: 'first-byte' },
    { id: 'thinking', prompt: `${HARD} Reply with the number only. ${NO_TOOLS}`, ending: 'thinking' },
    { id: 'mid-text', prompt: `Write the numbers one to sixty in words, one per line, nothing else. ${NO_TOOLS}`, ending: 'mid-text' },
    { id: 'tool-input', prompt: 'Use the Write tool to create story.txt containing a 300-word story about a lighthouse keeper. Call the Write tool straight away, with no text before it.', ending: 'tool-input' },
    { id: 'tool-exec', prompt: 'Run this exact Bash command in the foreground (not in the background), once: `sleep 20; echo DONE`. Then reply with its output only.', ending: 'tool-exec' },
  ];
}

export const short = (model: string): string => model.replace(/^claude-/, '').replace(/[^A-Za-z0-9]/g, '');

export function specFor(agent: string, model: string, runDir: string, o: { maxTokens?: number; extraEnv?: Record<string, string>; skills?: string[]; ours?: Known[] } = {}): Spec {
  return {
    agent,
    runDir,
    model,
    maxTokens: o.maxTokens ?? DECLARED.maxTokens,
    thinking: DECLARED.thinking,
    effort: DECLARED.effort,
    systemPrompt: DECLARED.systemPrompt,
    permissionMode: DECLARED.permissionMode,
    skills: o.skills ?? [],
    ours: o.ours ?? [],
    ...(o.extraEnv ? { extraEnv: o.extraEnv } : {}),
  };
}

// A clean start for an agent: the tag guard first (liveClaudeCodes misses
// store-resumed Claude Codes; join 9), then the harness's reset script.
export function resetAgent(agent: string, log: (s: string) => void): void {
  const guard = spawnSync('node', ['proofs/tag-guard.mts', agent], { cwd: PACKAGE_ROOT, encoding: 'utf8' });
  log(`tag-guard ${agent}: exit ${guard.status} ${guard.stdout.trim()} ${guard.stderr.trim()}`);
  if (guard.status !== 0) {
    throw new Error(`tag guard refused to reset ${agent}`);
  }
  const r = spawnSync('pnpm', ['-s', 'reset-config-dir', agent], { cwd: PACKAGE_ROOT, encoding: 'utf8' });
  log(`reset-config-dir ${agent}: exit ${r.status} ${r.stdout.trim()} ${r.stderr.trim()}`);
  if (r.status !== 0) {
    throw new Error(`reset-config-dir refused ${agent}`);
  }
}

export class Evidence {
  readonly dir: string;
  constructor(label: string) {
    this.dir = join(RUNS, `int-${fileStamp()}-${label}`);
    mkdirSync(this.dir, { recursive: true });
  }
  path(...p: string[]): string {
    return join(this.dir, ...p);
  }
  write(name: string, value: unknown): string {
    const p = join(this.dir, name);
    writeFileSync(p, `${clean(typeof value === 'string' ? value : JSON.stringify(value, null, 2))}\n`);
    return p;
  }
}

export interface CheckRow {
  scenario: string;
  cell: string;
  check: string;
  pass: boolean;
  reason: string;
  evidence: string;
  detail?: Json;
}

export function printRow(r: CheckRow): void {
  process.stdout.write(`${iso()} ${r.pass ? 'PASS' : 'FAIL'} ${r.scenario}/${r.cell} ${r.check}: ${r.reason} [${r.evidence}]\n`);
}
