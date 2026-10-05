// The `changes.message` schema and the per-kind `fields` schemas, copied
// from docs/spec/conversation.md (Message schemas) with the spec's doc
// comments left out: the parts a published message is checked against. Keep
// in step with the spec.

import { z } from 'zod';

/** ISO-8601 timestamp with a real UTC offset (e.g. 2026-07-07T21:00:00+10:00). */
const ts = z.iso.datetime({ offset: true });

const openEnum = <T extends readonly [string, ...string[]]>(values: T) => z.enum(values).or(z.string());

const sender = z.looseObject({
  kind: openEnum(['human', 'agent', 'orchestrator']),
  userId: z.string().optional(),
});

const contentBlocks = z.array(z.looseObject({ type: z.string() }));

const turnRef = { queryId: z.string(), turnId: z.string() };

const messageExtras = {
  kind: z.string().optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
  audience: z.looseObject({ model: z.boolean(), user: z.boolean() }).optional(),
  userContent: contentBlocks.optional(),
  scope: z.looseObject({ replaces: openEnum(['before']), except: z.array(z.string()) }).optional(),
  at: ts.optional(),
};

const message = z.looseObject({ ts, instanceId: z.string().optional(), id: z.string(), ...turnRef, role: openEnum(['user', 'assistant', 'system']), from: sender.optional(), content: contentBlocks, ...messageExtras });

const tokenCount = z.number().int().nonnegative();
const messageKindFields: Record<string, z.ZodType> = {
  'turn-finished': z.looseObject({ durationMs: z.number().nonnegative(), endedAt: ts.optional() }),
  interrupted: z.looseObject({ during: openEnum(['turn', 'tool-use']).optional() }),
  'tool-call-note': z.looseObject({ reason: openEnum(['incomplete', 'interrupted', 'result-missing', 'denied', 'skipped']).optional() }),
  'api-error': z.looseObject({ error: z.string().optional(), status: z.number().int().optional() }),
  'no-response': z.looseObject({}),
  'task-finished': z.looseObject({
    taskId: z.string().optional(),
    toolUseId: z.string().optional(),
    status: openEnum(['completed', 'failed']).optional(),
    summary: z.string().optional(),
    name: z.string().optional(),
    durationMs: z.number().nonnegative().optional(),
    toolUses: z.number().int().nonnegative().optional(),
    tokens: tokenCount.optional(),
  }),
  'subagent-report': z.looseObject({ agentType: z.string().optional() }),
  compaction: z.looseObject({
    trigger: openEnum(['auto', 'manual']).optional(),
    durationMs: z.number().nonnegative().optional(),
    preTokens: tokenCount.optional(),
    postTokens: tokenCount.optional(),
    preservedIds: z.array(z.string()).optional(),
  }),
  date: z.looseObject({ date: z.iso.date().optional() }),
  'total-tokens-reminder': z.looseObject({ tokensLeft: tokenCount.optional() }),
};

/**
 * What is wrong with a published `changes.message` body against the spec:
 * the message schema, `fields` sent with every `kind`, and a declared kind's
 * `fields` against that kind's schema. Empty when it conforms.
 */
export function messageProblems(body: unknown): string[] {
  const parsed = message.safeParse(body);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  }
  const { kind, fields } = parsed.data;
  if (kind === undefined) {
    return [];
  }
  if (fields === undefined) {
    return [`kind ${kind}: no fields`];
  }
  const schema = messageKindFields[kind];
  if (schema === undefined) {
    return [];
  }
  const checked = schema.safeParse(fields);
  return checked.success ? [] : checked.error.issues.map((issue) => `fields.${issue.path.join('.')} (${kind}): ${issue.message}`);
}
