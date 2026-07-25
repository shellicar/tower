#!/usr/bin/env node
// Validate every changes.jsonl in the repo against changes.config.json's
// categories. Hand-rolled rather than schema+ajv: the shape is two small
// object variants, not worth a dependency for.
//
// Usage: node scripts/validate-changes.mts (from anywhere)

import { readFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

interface Config {
  categories: Record<string, string>;
}

const config: Config = JSON.parse(readFileSync(resolve(repoRoot, 'changes.config.json'), 'utf8'));
const categoryKeys = new Set(Object.keys(config.categories));
const semverValues = new Set(['major', 'minor', 'patch']);

const changeFields = new Set(['type', 'description', 'category', 'semver', 'metadata']);
const releaseFields = new Set(['type', 'version', 'date', 'tag', 'description', 'metadata']);

function validateEntry(entry: unknown): string[] {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return ['entry must be an object'];
  }
  const obj = entry as Record<string, unknown>;
  const errors: string[] = [];

  if (obj.type === 'release') {
    for (const key of Object.keys(obj)) {
      if (!releaseFields.has(key)) errors.push(`unexpected field "${key}"`);
    }
    if (typeof obj.version !== 'string') errors.push('"version" must be a string');
    if (typeof obj.date !== 'string') errors.push('"date" must be a string');
    if ('tag' in obj && typeof obj.tag !== 'string') errors.push('"tag" must be a string');
    if ('description' in obj && typeof obj.description !== 'string') errors.push('"description" must be a string');
    return errors;
  }

  if ('type' in obj && obj.type !== 'change') {
    errors.push(`"type" must be "change" or "release", got ${JSON.stringify(obj.type)}`);
  }
  for (const key of Object.keys(obj)) {
    if (!changeFields.has(key)) errors.push(`unexpected field "${key}"`);
  }
  if (typeof obj.description !== 'string') errors.push('"description" must be a string');
  if (typeof obj.category !== 'string' || !categoryKeys.has(obj.category)) {
    errors.push(`"category" must be one of ${[...categoryKeys].join(', ')}, got ${JSON.stringify(obj.category)}`);
  }
  if ('semver' in obj && (typeof obj.semver !== 'string' || !semverValues.has(obj.semver))) {
    errors.push(`"semver" must be one of major, minor, patch, got ${JSON.stringify(obj.semver)}`);
  }
  return errors;
}

async function main() {
  const files: string[] = [];
  for await (const entry of glob('**/changes.jsonl', {
    cwd: repoRoot,
    exclude: (p) => p.includes('node_modules') || p.includes('target') || p.includes('.git'),
  })) {
    files.push(resolve(repoRoot, entry));
  }

  type Failure = { file: string; line: number; message: string };
  const failures: Failure[] = [];

  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (raw === undefined || raw.trim() === '') continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        failures.push({ file, line: i + 1, message: `invalid JSON: ${(err as Error).message}` });
        continue;
      }

      const errors = validateEntry(parsed);
      if (errors.length > 0) {
        failures.push({ file, line: i + 1, message: errors.join('; ') });
      }
    }
  }

  if (failures.length > 0) {
    for (const f of failures) {
      console.error(`error validating ${f.file}:${f.line}`);
      console.error(f.message);
    }
    const n = failures.length;
    console.error(`\n${n} error${n === 1 ? '' : 's'}`);
    process.exit(1);
  }

  console.log(`no errors found (${files.length} file${files.length === 1 ? '' : 's'})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
