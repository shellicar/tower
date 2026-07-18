# Tool error reporting: tool types & error layers

General design guidance for error handling across the structured tools (Exec, Find,
DeleteFile, …). **Exec already embodies this model**; the read/batch tools should follow it.

**Why-anchor:** the *reasoning* this applies lives in the tool philosophy
(`tower/docs/tool-philosophy.md`); this doc is the *design* applying it.

The whole thing reduces to one question — *who bounds the scope, the caller or the tool?* —
which determines both the safety model and the error-reporting model.

---

## Two error layers

Every failure is one of two kinds, handled differently:

- **Request-level** — the operation can't start, or the request is invalid →
  **hard error, no results.** The request itself is unfulfillable.
  - Exec: structural/semantic validation, or a blocked command.
  - Find: `ENOENT` on the root path.
  - DeleteFile: a malformed/invalid request.
- **Item-level** — one item *within a started, valid operation* fails →
  **collected and returned *with* the results, as a successful invocation.** It ran and did
  what it could.
  - Exec: a command's non-zero exit / 126 / 127 / timeout — carried per-command in
    `stderr` + `exitCode`.
  - Find: a per-directory `EPERM` during traversal.
  - DeleteFile: a single file that couldn't be deleted.

**The dividing line:** is the failure about the *request*, or about an *item within* a
request that already started? Request-level → hard error. Item-level → bag + success.

**Item failures are independent unless the items are genuinely dependent.** One unreadable
directory must not abort the traversal; one failed delete must not abort the batch. Exec
expresses dependency *explicitly* through its operators (`&&` propagates failure, `;` does
not), so the caller chooses per edge — there is no baked-in global policy to get wrong.

**Implementation note:** Exec's per-command results array *is* a natural item-level error
bag — every command already carries its own `stderr`/`exitCode`. Discovery/batch tools have
no per-item `stderr` channel, so they need an **explicit `errors: [...]` field** to reach
parity. Partial success is meaningless if the result shape can't say "these 18 succeeded,
these 2 failed, here's why."

---

## Two tool types

Whether item-level errors can *flood* depends on who bounds the scope:

- **Enumeration tools** — the caller names every item; the error count is
  **bounded by the input**.
  - Exec (you list the commands), DeleteFile (you name every file).
  - This is also a *safety* property: explicit enumeration is what makes the action
    approvable. You can't approve `DeleteFile *` — you don't know what it will do. The same
    choice that bounds the action bounds the error surface.
- **Discovery tools** — the tool discovers an arbitrary set; the error count is
  **unbounded**.
  - Find (walks a tree whose size it doesn't know).

---

## The reporting model — two questions

1. **Report *that* errors happened (and that the result is partial)?**
   → **Always. Never suppressible.** A result that looks complete but isn't is the
   silent-correction failure: it breaks the caller's mental model. Partiality is always
   signalled.

2. **How much *detail*?** → governed by tool type:
   - **Enumeration (bounded):** always-on full detail is safe (errors ≤ input). Opt-*out*
     to suppress is a fine refinement (e.g. Exec's `stderr` → `/dev/null`), not a need.
   - **Discovery (unbounded):** **summary by default** (count + grouping + a small sample),
     **full detail opt-in.** The detail is bounded *by construction* — small whether 5 or
     5,000 items failed.

---

## Ref is a backstop, not a design

The default path must be intrinsically bounded so it never floods. "Dump everything and let
`Ref` catch the overflow" builds the flood in and hopes the net holds. `Ref` is insurance
for the rare opted-into-detail-and-genuinely-large case — not the architecture. You don't
skip the trapeze lessons because there's a net.

---

## The unifying principle

**Who bounds the scope — the caller (enumeration) or the tool (discovery) — determines both
the safety model and the error-reporting model.** The same property that makes `DeleteFile *`
un-approvable is what makes a discovery tool's errors unbounded. Decide a tool's *type*
first; its error layers and verbosity model fall out:

| | Enumeration (Exec, DeleteFile) | Discovery (Find) |
|---|---|---|
| Scope bounded by | the caller (named items) | nothing (tool discovers) |
| Request-level error | invalid input → hard fail | bad root → hard fail |
| Item-level errors | per-item, bounded by input | per-item, unbounded |
| Report *that* errors occurred | always | always |
| Error *detail* | full (opt-out to suppress) | summary default, detail opt-in |
| Approvable as a wildcard? | no — must enumerate | n/a (read-only) |
