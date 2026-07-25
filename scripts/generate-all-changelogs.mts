#!/usr/bin/env node
// Regenerate every package's CHANGELOG.md from its changes.jsonl.
//
// Discovers packages the same way validate-changes.mts does (every
// changes.jsonl in the repo), then runs the single-package generator on
// each.
//
// Usage: node scripts/generate-all-changelogs.mts (from anywhere)

import { execFileSync } from 'node:child_process';
import { glob } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const generator = resolve(scriptDir, 'generate-changelog.mts');

async function main() {
  const packageDirs: string[] = [];
  for await (const entry of glob('**/changes.jsonl', {
    cwd: repoRoot,
    exclude: (p) => p.includes('node_modules') || p.includes('target') || p.includes('.git'),
  })) {
    packageDirs.push(dirname(resolve(repoRoot, entry)));
  }

  if (packageDirs.length === 0) {
    console.error('no changes.jsonl files found');
    process.exit(2);
  }

  packageDirs.sort();

  for (const packageDir of packageDirs) {
    execFileSync('node', [generator, packageDir], { cwd: repoRoot, stdio: 'inherit' });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
