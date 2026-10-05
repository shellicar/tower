# Lint and format: Biome against Oxlint, Oxfmt and dprint

**Question.** What Stephen's old ESLint configs had that claude-cli's Biome
config misses; how Biome and Oxlint compare in coverage and behaviour; how
the formatters treat his objection that line breaks carry meaning.

**Method.** ESLint configs recovered from 57 of his repos; both linters run
on a copy of claude-cli and on fixtures; formatters run on core-di at the
commit before Biome was adopted, plus 11 synthetic constructs; docs and
changelogs read. Scratch in `/tmp/lint-compare/`, gone; no branch.

**Versions.** Biome 2.4.16 and 2.5.14; Oxlint 1.85.0 and 1.86.0;
oxlint-tsgolint 7.0.2003; Oxfmt 0.70.0; dprint 0.57.4 with
@dprint/typescript 0.96.1. Speed: medians of 5 runs.

**Found.**
- Oxlint lacks `noUndeclaredDependencies`. Its
  `no-unused-private-class-members` covers `#private` only, not TypeScript
  `private` or decorated fields.
- Oxlint can exit 0 while not running type-aware rules (without
  `--type-aware`), and drops rules from plugins that aren't enabled.
- Biome's and Oxfmt's output is byte-identical at width 320 and at 80. Both
  join the author's line breaks and split some lines by rule; no option
  changes that.
- dprint keeps the author's breaks, but always splits member decorators
  (`@dependsOn`).
- Biome needs `unsafeParameterDecoratorsEnabled` only for parameter
  decorators. Its type-aware rules (`noFloatingPromises` and others) are
  nursery in 2.4.16 and 2.5.14 and must be listed under `nursery`. 2.5.14
  deprecates `"recommended": true` for `"preset"`.
- Speed is sub-second for both, except Oxlint `--type-aware` (1.07 s). Both
  release about weekly, with breaking changes in minor releases.
- pnpm wrote `minimumReleaseAgeExclude` into the workspace file by itself
  when adding a package less than a day old.

**Resume comparison.** Not applicable.

**Used by.** [building.md](../participant/building.md): Biome stays.
