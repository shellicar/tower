#!/usr/bin/env node
// Which workspace crates a git diff actually touches, and which crates are
// affected as a result (transitively depend on a touched one) — exact, not
// heuristic: it reads the same dep-info files rustc writes for its own
// incremental rebuilds (after `cargo check --workspace --tests`, which
// forces macro expansion — concat!/env!/include_str! resolve to their real
// paths, same as the `fixture!` macro in crates/wire/tests/scenarios.rs),
// then walks the crate dependency graph from `cargo metadata`.
//
// Usage: node scripts/affected-crates.mts <baseRef> [--tier=modified|affected] [--format=json|cargo-args]
// Run from mvp/. <baseRef> is anything `git diff --name-only <baseRef>` accepts.
// Default output is { modified, affected } as JSON. --format=cargo-args with a
// --tier prints `-p name -p name2 ...` (or nothing, on an empty tier) — ready
// to splice into a cargo invocation: `cargo build $(... --format=cargo-args --tier=affected)`.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const workspaceRoot = resolve(process.cwd());
const targetDir = join(workspaceRoot, 'target');

function run(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

interface CargoTarget {
  name: string;
  src_path: string;
}
interface CargoDependency {
  name: string;
  path?: string;
}
interface CargoPackage {
  name: string;
  manifest_path: string;
  targets: CargoTarget[];
  dependencies: CargoDependency[];
}
interface CargoMetadata {
  packages: CargoPackage[];
  workspace_members: string[];
}

function loadMetadata(): CargoMetadata {
  const raw = run('cargo', ['metadata', '--format-version', '1', '--no-deps'], workspaceRoot);
  return JSON.parse(raw) as CargoMetadata;
}

// The Makefile-style dep-info format rustc writes: `output: dep1 dep2 ...`,
// continuation lines ending in `\`, spaces in paths escaped as `\ `.
function parseDepInfo(content: string): string[] {
  const joined = content.replace(/\\\n/g, ' ');
  const firstColon = joined.indexOf(':');
  if (firstColon === -1) return [];
  const depsPart = joined.slice(firstColon + 1);
  return depsPart
    .split(/(?<!\\) /)
    .map((p) => p.trim().replace(/\\ /g, ' '))
    .filter((p) => p.length > 0);
}

// Every .d file under target/{debug,release}{,/deps}, keyed by the target
// name it was built for (strip the `lib` prefix and the `-<hash>` suffix
// cargo appends to files under deps/).
function collectDepInfoByTarget(): Map<string, Set<string>> {
  const byTarget = new Map<string, Set<string>>();
  const dirs = ['debug', 'debug/deps', 'release', 'release/deps'].map((d) => join(targetDir, d));
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.d')) continue;
      const stem = entry.slice(0, -2).replace(/^lib/, '').replace(/-[0-9a-f]{16}$/, '');
      const files = parseDepInfo(readFileSync(join(dir, entry), 'utf8'));
      const set = byTarget.get(stem) ?? new Set<string>();
      for (const f of files) set.add(resolve(f));
      byTarget.set(stem, set);
    }
  }
  return byTarget;
}

function main(): void {
  const args = process.argv.slice(2);
  const baseRef = args.find((a) => !a.startsWith('--'));
  if (!baseRef) {
    process.stderr.write('usage: affected-crates.mts <baseRef> [--tier=modified|affected] [--format=json|cargo-args]\n');
    process.exit(1);
  }
  const tierArg = args.find((a) => a.startsWith('--tier='))?.slice('--tier='.length);
  const formatArg = args.find((a) => a.startsWith('--format='))?.slice('--format='.length) ?? 'json';
  if (tierArg !== undefined && tierArg !== 'modified' && tierArg !== 'affected') {
    process.stderr.write(`--tier must be "modified" or "affected", got ${tierArg}\n`);
    process.exit(1);
  }
  if (formatArg !== 'json' && formatArg !== 'cargo-args') {
    process.stderr.write(`--format must be "json" or "cargo-args", got ${formatArg}\n`);
    process.exit(1);
  }

  run('cargo', ['check', '--workspace', '--tests'], workspaceRoot);

  const metadata = loadMetadata();
  const depInfoByTarget = collectDepInfoByTarget();

  // A library target's dep-info transitively includes its own path
  // dependencies' source (rustc reads wire's .rs files to compile bridge,
  // which depends on it) — correct for rustc's own rebuild tracking, wrong
  // for "whose crate does this file belong to". A file counts as a given
  // package's own only if it sits under that package's manifest directory,
  // or under no workspace package's directory at all (the fixture files
  // outside every crate's own tree, which is the actual case this tool
  // exists to catch — ordinary cross-crate source is already handled by the
  // dependency-graph walk below, not by file attribution).
  const packageDirs = metadata.packages.map((p) => join(p.manifest_path, '..'));
  function ownerDir(file: string): string | undefined {
    return packageDirs.find((dir) => file === dir || file.startsWith(dir + '/'));
  }

  // package name -> its own file set (union over every target it owns).
  const filesByPackage = new Map<string, Set<string>>();
  // package name -> names of workspace-internal packages it depends on.
  const dependsOn = new Map<string, Set<string>>();
  const packageNames = new Set(metadata.packages.map((p) => p.name));
  const dirByPackage = new Map(metadata.packages.map((p) => [p.name, join(p.manifest_path, '..')]));

  for (const pkg of metadata.packages) {
    const ownDir = dirByPackage.get(pkg.name)!;
    const fileSet = filesByPackage.get(pkg.name) ?? new Set<string>();
    for (const target of pkg.targets) {
      const targetFiles = depInfoByTarget.get(target.name);
      if (!targetFiles) continue;
      for (const f of targetFiles) {
        const owner = ownerDir(f);
        if (owner === undefined || owner === ownDir) fileSet.add(f);
      }
    }
    filesByPackage.set(pkg.name, fileSet);

    const deps = dependsOn.get(pkg.name) ?? new Set<string>();
    for (const dep of pkg.dependencies) {
      if (dep.path && packageNames.has(dep.name)) deps.add(dep.name);
    }
    dependsOn.set(pkg.name, deps);
  }

  const gitRoot = run('git', ['rev-parse', '--show-toplevel'], workspaceRoot).trim();
  const diffOutput = run('git', ['diff', '--name-only', baseRef], workspaceRoot);
  const changedFiles = new Set(
    diffOutput
      .split('\n')
      .filter((l) => l.length > 0)
      .map((f) => resolve(gitRoot, f)),
  );

  const modified = new Set<string>();
  for (const [pkg, files] of filesByPackage) {
    for (const f of changedFiles) {
      if (files.has(f)) {
        modified.add(pkg);
        break;
      }
    }
  }

  // dependents: reverse of dependsOn, then walk it forward from `modified`.
  const dependents = new Map<string, Set<string>>();
  for (const [pkg, deps] of dependsOn) {
    for (const dep of deps) {
      const set = dependents.get(dep) ?? new Set<string>();
      set.add(pkg);
      dependents.set(dep, set);
    }
  }

  const affected = new Set(modified);
  const queue = [...modified];
  while (queue.length > 0) {
    const pkg = queue.pop()!;
    for (const dep of dependents.get(pkg) ?? []) {
      if (!affected.has(dep)) {
        affected.add(dep);
        queue.push(dep);
      }
    }
  }

  const result = { modified: [...modified].sort(), affected: [...affected].sort() };

  if (formatArg === 'cargo-args') {
    const names = result[tierArg ?? 'affected'];
    process.stdout.write(names.map((n) => `-p ${n}`).join(' '));
    return;
  }

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

main();
