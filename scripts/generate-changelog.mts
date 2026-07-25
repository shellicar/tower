#!/usr/bin/env node
// Render one package's CHANGELOG.md from its changes.jsonl.
//
// Usage: node scripts/generate-changelog.mts <package-dir>
// The package's short name defaults to its directory's basename (towerd,
// bridge, helm, frontend, frontend-leptos); where a release's actual GitHub
// release tag differs from `<name>@<version>` (frontend ships as
// tower-svelte, frontend-leptos as tower-leptos), set "tag" explicitly on
// that release entry.

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RELEASES_BASE = 'https://github.com/shellicar/tower/releases/tag/';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

const config = JSON.parse(readFileSync(resolve(repoRoot, 'changes.config.json'), 'utf8'));
const categories: Record<string, string> = config.categories;
const categoryOrder = Object.keys(categories);

const packageDir = process.argv[2];
if (!packageDir) {
  console.error('usage: generate-changelog.mts <package-dir>');
  process.exit(1);
}

const absDir = resolve(packageDir);
const shortName = basename(absDir);

type Entry = { description: string; category: string; metadata?: Record<string, unknown> };
type ReleaseMarker = { type: 'release'; version: string; date: string; tag?: string; description?: string };
type Group = { entries: Entry[]; release: ReleaseMarker };

const rawLines = readFileSync(resolve(absDir, 'changes.jsonl'), 'utf8')
  .split('\n')
  .filter((l) => l.trim());

const groups: Group[] = [];
let pending: Entry[] = [];

for (const line of rawLines) {
  const obj = JSON.parse(line);
  if (obj.type === 'release') {
    groups.push({ entries: pending, release: obj });
    pending = [];
  } else {
    pending.push(obj);
  }
}
const unreleased = pending;

function tagUrl(release: ReleaseMarker): string {
  const tag = release.tag ?? `${shortName}@${release.version}`;
  return `${RELEASES_BASE}${tag}`;
}

function renderLine(entry: Entry): string {
  let text = entry.description;
  if (entry.metadata?.issue != null) {
    text += ` (#${entry.metadata.issue})`;
  }
  if (typeof entry.metadata?.ghsa === 'string') {
    const ghsa = entry.metadata.ghsa;
    text += ` ([${ghsa}](https://github.com/advisories/${ghsa}))`;
  }
  return `- ${text}`;
}

function renderEntries(entries: Entry[]): string {
  const byCategory: Record<string, Entry[]> = {};
  for (const entry of entries) {
    if (!byCategory[entry.category]) {
      byCategory[entry.category] = [];
    }
    byCategory[entry.category].push(entry);
  }
  return categoryOrder
    .filter((k) => byCategory[k]?.length)
    .map((k) => `### ${categories[k]}\n\n${byCategory[k].map(renderLine).join('\n')}`)
    .join('\n\n');
}

const PREAMBLE = ['', '', 'All notable changes to this project will be documented in this file.', '', 'The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),', 'and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).'].join('\n');

const parts: string[] = [`# Changelog${PREAMBLE}`];

if (unreleased.length > 0) {
  parts.push('\n## Unreleased');
  parts.push(`\n${renderEntries(unreleased)}`);
}

for (const { entries, release } of [...groups].reverse()) {
  parts.push(`\n## [${release.version}] - ${release.date}`);
  if (release.description != null) {
    parts.push(`\n${release.description}`);
  }
  if (entries.length > 0) {
    parts.push(`\n${renderEntries(entries)}`);
  }
}

if (groups.length > 0) {
  parts.push(
    `\n${[...groups]
      .reverse()
      .map((g) => `[${g.release.version}]: ${tagUrl(g.release)}`)
      .join('\n')}`,
  );
}

const output = `${parts.join('\n')}\n`;
const changelogPath = resolve(absDir, 'CHANGELOG.md');
writeFileSync(changelogPath, output);
console.log(`wrote ${changelogPath}`);
