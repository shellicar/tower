# claude-sdk-tools — Planned Work

## Config (#208)

The tools currently take no configuration. Everything is either hardcoded or passed
ad-hoc by the consumer. This is the foundation the other items depend on.

**Config loading**
- Load from `./.claude/tools-config.json` (local) and `~/.claude/tools-config.json` (home).
  Local takes priority; fields merge-overwrite (null in local means "use home value").
- Hot reload during idle phase, same pattern as the CLI config watcher.
- Zod schema for validation, coerce/default on invalid values rather than throwing.
- Publish a JSON schema for the config file so editors can validate it.

**Config resolution**
- Resolve config once at startup into a concrete `ResolvedConfig` object.
- Stop threading optional fields through every function call. Resolved config is passed
  to tool factories; they read from it, not from individual options.
- The existing CLI has this pattern — `claude-sdk-cli/src/cli-config/` is a reference.

---

## Better tool instructions (#209)

The tool descriptions drive how Claude uses the tools. They are currently minimal. Better
instructions would reduce mistakes and turn count.

Things worth covering:
- `PreviewEdit`: lead with the `lineEdits`/`textEdits` split; clarify that line numbers
  always reference the file before the call; show a combined example.
- `Exec`: structured args, no shell quoting, pipeline support, when to use `stdin`.
- Batching: call multiple read tools before deciding what to write; avoid a round-trip
  per small decision.
- Whether to deliver instructions as part of tool `description` fields or as a
  `<system-reminder>` block injected into the system prompt. The reminder approach
  keeps descriptions short and puts guidance where Claude refers to it during a turn.

---

## Find tool exclusions (#210)

The current `exclude` parameter is a list of directory names matched by basename.
Two improvements:

**Standard regex patterns**
- Change `exclude` from a list of directory names to a list of regex patterns matched
  against the full relative path.
- Default exclusions should cover `dist/`, `node_modules/`, and all dot directories
  (`^\..*/` catches `.git`, `.claude`, `.turbo`, etc.).

**Examples in the tool description**
- `pattern: \.(ts|js|svelte|vue)$` — source files
- `pattern: \.(md|html)$` — docs
- `exclude: ["dist", "node_modules", "^\\..*"]` — standard ignores

---

## LSP validation for file edits (#177)

Validate file edits in-memory against TypeScript's language server before writing to
disk. Rejects edits that introduce new type errors.

A POC exists at `/sandbox/lsp-poc/lsp-poc.js` (280 lines) demonstrating the wire
protocol, diagnostic diffing, and the before/after snapshot pattern.

Fits naturally between PreviewEdit and ConfirmEditFile. Open questions: blocking vs
advisory, pre-existing error baseline, opt-in via config.

---

## File modification tracking (#178)

Notify Claude when files it has read are modified outside its own actions, so it does
not operate on stale reads.

Three attribution categories: Claude wrote it, changed during exec (linter/formatter),
user changed it between turns. The `IFileSystem` layer is the natural home since it
already knows what gets read and written.

Design detail in issue #178.
