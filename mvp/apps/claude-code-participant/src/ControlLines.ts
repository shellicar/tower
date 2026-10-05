import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { dependsOn } from '@shellicar/core-di';
import { z } from 'zod';
import { SETTINGS_EFFORT_LEVELS } from './claudeCodeSettings.js';
import { ParticipantConfig } from './ParticipantConfig.js';
import { EFFORT_LEVELS, type ModelCell, ParticipantSettings, PERMISSION_MODES, THINKING_DISPLAYS, THINKING_TYPES } from './ParticipantSettings.js';

type Reply = Record<string, unknown>;

// Every line is held to its schema strictly: a stray or misspelt key that
// was quietly ignored would leave the operator believing something is set
// that isn't.

/** Refused rather than trimmed: whitespace-only names nothing, and a trimmed name isn't the one that was sent. */
const modelName = z
  .string()
  .min(1)
  .refine((name) => name === name.trim(), 'must not start or end with whitespace');

/** The model line merges: it sets the fields it names. Every field is a required setting, so none accepts null. */
const modelLine = z.strictObject({
  name: modelName.optional(),
  maxTokens: z.number().int().min(1).optional(),
  thinking: z.enum(THINKING_TYPES).optional(),
  thinkingDisplay: z.enum(THINKING_DISPLAYS).optional(),
  effort: z.enum(EFFORT_LEVELS).optional(),
});

const systemLine = z.strictObject({ preset: z.boolean(), text: z.string().optional() });

const permissionModeLine = z.enum(PERMISSION_MODES);

const contextLine = z.string().nullable();

// claudeSettings is Claude Code's own settings shape, which the participant
// doesn't own: only the keys it acts on are checked, and everything else
// passes through as sent. Each checked key replaces a required value, and a
// value Claude Code would drop (it drops an effortLevel outside its own set)
// would leave that value unset.
const claudeSettingsLine = z
  .looseObject({
    model: modelName.optional(),
    effortLevel: z.enum(SETTINGS_EFFORT_LEVELS).optional(),
    alwaysThinkingEnabled: z.boolean().optional(),
    permissions: z.looseObject({ defaultMode: z.enum(PERMISSION_MODES).optional() }).optional(),
  })
  .nullable();

const LONGEST_DEADLINE_MS = 600_000;
const deadline = z.number().int().min(1).max(LONGEST_DEADLINE_MS);

/** Configures how shutdown behaves, never asks for one: both deadlines are required and replaced together. */
const shutdownPolicyLine = z.strictObject({ gracefulMs: deadline, teardownMs: deadline });

const settingsLine = z.strictObject({});

function explain(error: z.ZodError): string {
  return error.issues.map((issue) => (issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message)).join('; ');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The stdio control lines: one JSON object in, one JSON object out, for every
 * line. Each line carries one key, named after what it sets; `settings`
 * reads everything back.
 */
export class ControlLines {
  @dependsOn(ParticipantSettings) private readonly settings!: ParticipantSettings;
  @dependsOn(ParticipantConfig) private readonly config!: ParticipantConfig;

  private readonly handlers: Record<string, (value: unknown) => Reply> = {
    model: (value) => this.model(value),
    system: (value) => this.system(value),
    permissionMode: (value) => this.permissionMode(value),
    context: (value) => this.context(value),
    claudeSettings: (value) => this.claudeSettings(value),
    shutdownPolicy: (value) => this.shutdownPolicy(value),
    settings: (value) => this.readBack(value),
  };

  public handle(line: string): Reply {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { error: 'unparseable' };
    }
    if (!isObject(parsed)) {
      return { error: 'unsupported' };
    }
    const keys = Object.keys(parsed);
    if (keys.length > 1) {
      return { error: `a control line carries exactly one key; this one carries ${keys.join(', ')}` };
    }
    const [key] = keys;
    const handler = key === undefined ? undefined : this.handlers[key];
    if (key === undefined || handler === undefined) {
      return { error: 'unsupported' };
    }
    const reply = handler(parsed[key]);
    this.settings.settled();
    return reply;
  }

  private model(value: unknown): Reply {
    const line = modelLine.safeParse(value);
    if (!line.success) {
      return { error: `invalid model: ${explain(line.error)}` };
    }
    this.settings.model = { ...this.settings.model, ...line.data } as ModelCell;
    return { model: this.settings.model };
  }

  private system(value: unknown): Reply {
    const line = systemLine.safeParse(value);
    if (!line.success) {
      return { error: `invalid system: ${explain(line.error)}` };
    }
    this.settings.system = line.data;
    return { system: 'set' };
  }

  private permissionMode(value: unknown): Reply {
    const line = permissionModeLine.safeParse(value);
    if (!line.success) {
      return { error: `invalid permissionMode: ${explain(line.error)}` };
    }
    this.settings.permissionMode = line.data;
    return { permissionMode: line.data };
  }

  private context(value: unknown): Reply {
    const line = contextLine.safeParse(value);
    if (!line.success) {
      return { error: `invalid context: ${explain(line.error)}` };
    }
    this.settings.context = line.data ?? undefined;
    return { context: line.data === null ? 'cleared' : 'set' };
  }

  /** Replaces the whole value: a caller who wants a patch reads `settings`, merges, and sends the result. */
  private claudeSettings(value: unknown): Reply {
    const line = claudeSettingsLine.safeParse(value);
    if (!line.success) {
      return { error: `invalid claudeSettings: ${explain(line.error)}` };
    }
    // What was sent, not what the schema read: keys it doesn't model pass
    // through untouched.
    this.settings.claudeSettings = value === null ? undefined : structuredClone(value as Record<string, unknown>);
    return { claudeSettings: value === null ? 'cleared' : 'set' };
  }

  /** Reaches the next stage to start: a stage already under way keeps the deadline it started with. */
  private shutdownPolicy(value: unknown): Reply {
    const line = shutdownPolicyLine.safeParse(value);
    if (!line.success) {
      return { error: `invalid shutdownPolicy: ${explain(line.error)}` };
    }
    this.settings.shutdownPolicy = { ...line.data };
    return { shutdownPolicy: this.settings.shutdownPolicy };
  }

  private readBack(value: unknown): Reply {
    const line = settingsLine.safeParse(value);
    if (!line.success) {
      return { error: `invalid settings: ${explain(line.error)}` };
    }
    const readiness = this.settings.readiness();
    return {
      settings: {
        model: this.settings.model,
        system: this.settings.system ?? null,
        permissionMode: this.settings.permissionMode ?? null,
        context: this.settings.context ?? null,
        claudeSettings: this.settings.claudeSettings ?? null,
        shutdownPolicy: this.settings.shutdownPolicy,
        missing: readiness.ready ? [] : readiness.missing,
        configDir: this.config.configDir,
        privateHome: this.config.privateHome,
        setpriv: this.config.setpriv,
      },
    };
  }
}

/**
 * Answers each line of `input` on `output` until `input` ends, one reply per
 * line, so a driver can pair replies with lines by position. Diagnostics go
 * to stderr, never `output`, which carries only replies.
 */
export async function runControlLines(input: Readable, output: Writable, lines: ControlLines): Promise<void> {
  const reader = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of reader) {
    output.write(`${JSON.stringify(lines.handle(line))}\n`);
  }
}
