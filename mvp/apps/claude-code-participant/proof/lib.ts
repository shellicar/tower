import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Json = Record<string, unknown>;

/** The participant app's directory. */
export const APP = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');

/**
 * Where config dirs, snapshots and working directories live; not committed.
 * Outside any git repository, so the git state Claude Code puts in a request
 * (gitStatus, safeguards.git_state) does not change with the checkout.
 */
export const WORK = '/tmp/tower-proof';

/** Where each run's results go; committed, but for the raw body logs. */
export const OUT = join(APP, 'proof', 'out');

/** What a run is asked to do, read from proof/plan.json at start. */
export type Plan = {
  run: string;
  /** `live`: drive the shapes and snapshot; `resume`: republish the saved changes and resume; `both`; `compare`: only rewrite the report from the saved requests. */
  phase: 'live' | 'resume' | 'both' | 'compare';
  shapes: string[];
  /**
   * Resume methods, each `local`, `raw` or `msg[:field,...]`, with a trailing
   * `@` for a resume that also passes resumeSessionAt.
   */
  methods: string[];
};

export function readPlan(): Plan {
  return JSON.parse(readFileSync(join(APP, 'proof', 'plan.json'), 'utf8')) as Plan;
}

// The control lines scripts/start.ts configures the participant with.
export const CONTROL_LINES: Json[] = [{ model: { name: 'claude-sonnet-5-5', maxTokens: 120000, thinking: 'adaptive', thinkingDisplay: 'summarized', effort: 'medium' } }, { system: { preset: true } }, { permissionMode: 'auto' }, { claudeSettings: { sandbox: { enabled: true, autoAllowBashIfSandboxed: true } } }];

/** What a shape's run left, read back by the resume and compare steps. */
export type ShapeMeta = {
  shape: string;
  id: string;
  world: string;
  cwd: string;
  configDir: string;
  snapshot: string;
};

export function shapeOutDir(run: string, shape: string): string {
  return join(OUT, run, shape);
}

export function readLines(path: string): Json[] {
  return existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Json)
    : [];
}

/** Every file name under `dir` ending in `suffix`. */
export function filesEnding(dir: string, suffix: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(suffix)) : [];
}
