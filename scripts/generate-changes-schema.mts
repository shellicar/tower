#!/usr/bin/env node
// Regenerate schema/shellicar-changes.schema.json from changes.config.json,
// so the allowed categories live in one place (the config) and the schema
// is always its derivative, never hand-edited out of sync.
//
// Usage: node scripts/generate-changes-schema.mts (from anywhere)

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

interface Config {
  categories: Record<string, string>;
}

const config: Config = JSON.parse(readFileSync(resolve(repoRoot, 'changes.config.json'), 'utf8'));
const categoryKeys = Object.keys(config.categories);
if (categoryKeys.length === 0) {
  throw new Error('changes.config.json has no categories defined');
}

const schema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  anyOf: [
    {
      type: 'object',
      properties: {
        type: { type: 'string', const: 'release' },
        version: { type: 'string' },
        date: { type: 'string' },
        tag: { type: 'string' },
        description: { type: 'string' },
        metadata: { type: 'object', propertyNames: { type: 'string' }, additionalProperties: {} },
      },
      required: ['type', 'version', 'date'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        type: { type: 'string', const: 'change' },
        description: { type: 'string' },
        category: { type: 'string', enum: categoryKeys },
        semver: { type: 'string', enum: ['major', 'minor', 'patch'] },
        metadata: { type: 'object', propertyNames: { type: 'string' }, additionalProperties: {} },
      },
      required: ['description', 'category'],
      additionalProperties: false,
    },
  ],
};

const outPath = resolve(repoRoot, 'schema/shellicar-changes.schema.json');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(schema, null, 2)}\n`);
