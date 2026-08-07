# Handoff: three proposed session rules derived from a live multi-session incident

**Inspected at:** `HEAD 13ec54a` (worktree off that SHA; `main` was moving during the work)
**Derived from:** a full-pass review, fix, coverage and ship-ready session on `@yawlabs/npmjs-mcp` (landed as `757e6e0` on branch `hardening/full-pass-followups` in that repo). Both rules below trace to something that actually went wrong in that session -- one of them destroyed a file.

**Status: SPEC ONLY.** No catalog entries, no spec-table rows, no implementations. Same reasoning as `HANDOFF-session-derived-rules.md`: `scripts/generate-catalog-prose.mjs` derives the published `N rules` counts from the catalogs, so a catalog entry without an emitter advertises a rule that does not run -- and `src/core/__tests__/catalog-consistency.test.ts:117-135` hard-blocks it for `session/*` anyway, since mapped IDs must exactly match the `ruleId` literals emitted under `src/core/checks/session/`.

## Coordination with the two handoffs already in this checkout

Read `HANDOFF-session-derived-rules.md` and `HANDOFF-ci-claim-and-bin-subcommand-rules.md` first. This document is disjoint from both except for one overlap, which it defers rather than duplicates.

- **`commands/exit-status-masked` (owned by `HANDOFF-session-derived-rules.md`) -- do not re-propose.** I hit that exact defect live in the source session and record it below as independent confirmation, not as a new rule.
- Nothing here touches the `ci/*` closed allowlist. Both proposed IDs use `session/` as prefix, satisfying the prefix-equals-category invariant at `CONTRIBUTING.md:72` / `checkRuleIdPrefixes`.

## TL;DR

| Proposed rule | Catalog | Severity | Motivating real defect |
|---|---|---|---|
| `session/shared-temp-path` | session | error | An agent backed a file up to a fixed `/tmp` path and restored from it; a concurrent session on another repo had overwritten it, and the restore wrote a *different package's* `package.json` into the repo |
| `session/unverified-gate-claimed-clean` | session | warning | An agent reported lint as "consistent with clean" from a tool that had segfaulted and emitted zero diagnostics |
| `session/default-branch-accumulation` | session | warning | 25 files of unrelated work accumulated uncommitted on `main` across a multi-hour session, in a repo with 11 concurrent agent worktrees |

---

## 1. `session/shared-temp-path`

### What happened

Mid-session the agent measured a packaging change by backing up `package.json`, editing it, and restoring:

```bash
node -e 'fs.writeFileSync("/tmp/pkg.bak", fs.readFileSync("package.json")); ...'
npm pack --dry-run
cp /tmp/pkg.bak package.json      # <-- restored the WRONG file
```

Between the write and the `cp`, a concurrent session working a sibling repo used the same `/tmp/pkg.bak` path. The restore wrote `@yawlabs/caddy-mcp` v1.3.1 -- different name, version, `bin`, and dependency set -- into `@yawlabs/npmjs-mcp`. It was caught only because the harness surfaced the external modification; had it not, a release from that tree would have published a package under the wrong identity.

`/tmp` is process-global and, under Git Bash on Windows, shared across every concurrent session on the machine. The agent's own operating instructions specified a session-scoped scratchpad directory for exactly this reason and it used `/tmp` anyway -- which is what makes this lintable rather than merely unlucky.

### Proposed check

Flag a session transcript where a **fixed, non-session-scoped temp path is written and later read back**. The signal is the pair, not either half:

- write to a literal path under `/tmp/`, `/var/tmp/`, `%TEMP%`, `$TMPDIR` with no session/PID/mktemp component, AND
- a later read/copy/restore from that same literal path.

Do not flag `mktemp` / `mktemp -d` output, or paths containing a session id, PID, or random component -- those are the correct form and are common in the same transcripts. Do not flag write-only or read-only use of a fixed temp path; a scratch file that is never read back cannot be clobbered into the workspace.

**Severity: error.** The failure is silent, cross-repo, and lands in tracked files.

**Fixture sketch:** `fixtures/session-shared-temp-path/` -- one transcript with the write/restore pair through `/tmp/pkg.bak` (expect 1 finding), one with the same shape through `$(mktemp)` (expect 0), one writing `/tmp/notes.txt` and never reading it (expect 0).

### Why existing rules miss it

`session/stale-memory` and `paths/not-found` are about references that do not resolve. This path resolves fine -- that is the problem. Nothing in the session catalog models *concurrency* hazards.

---

## 2. `session/unverified-gate-claimed-clean`

### What happened

The source session ran `biome check` roughly a dozen times across several turns. On this host (Windows ARM64) the biome binary segfaults during exit -- exit `139` under bash, `0xC0000005` under PowerShell -- via the npx wrapper, via the native `node_modules/@biomejs/cli-win32-arm64/biome.exe`, and unchanged by shell. It produced **zero bytes** of output every time.

The agent twice reported this as "zero diagnostics emitted, which is consistent with a clean run." That inference was wrong, and it took a deliberate experiment to disprove: running the same binary against a file with an unused variable and mangled formatting *also* produced zero bytes. The crash precedes diagnostic emission, so empty output carries no information about cleanliness at all.

The generalisable defect: **an agent treating a non-zero exit or an empty result as evidence of a passing gate.** In a session that ends "typecheck clean, tests pass, lint clean", the third clause was unsupported.

### Proposed check

Flag a session where a quality gate (lint / typecheck / test / build) is **asserted as passing or clean in prose while the corresponding tool invocation exited non-zero, was killed by a signal, or produced no output**.

Matching needs the tool result adjacent to the claim, which the session catalog already models for `session/stale-memory`. Suggested shape:

- find gate-shaped invocations (`lint`, `tsc`, `test`, `build`, `check`) and their exit status,
- find nearby assistant prose asserting a pass (`clean`, `passing`, `all green`, `no violations`, `0 errors`),
- flag when the two disagree.

Deliberately **not** flagged: prose that labels the state honestly -- "unverified", "could not verify", "crashed", "blocked". The rule targets the false claim, not the failed gate. A session that says "lint is UNVERIFIED because the runner crashed" is the correct outcome and must stay clean.

**Severity: warning.** It is a reporting defect rather than a broken artifact, but it is the reporting defect that lets broken artifacts through.

**Fixture sketch:** `fixtures/session-unverified-gate/` -- transcript asserting "lint clean" after an exit-139 invocation (expect 1), the same invocation followed by "lint UNVERIFIED -- runner crashed" (expect 0), and a genuine exit-0 lint followed by "lint clean" (expect 0).

### Relationship to `commands/exit-status-masked`

They are siblings on different surfaces and both are worth having.

`commands/exit-status-masked` (context catalog, owned by the other handoff) is static: it reads a *documented command* whose own shape discards the status, e.g. `npx tsc --noEmit | head -20 && echo "tsc clean"`.

This rule is dynamic: it compares a *claim in the session* against the *observed result*. It fires on a plain `pnpm lint` that crashed -- a command with nothing structurally wrong with it.

Independent confirmation of the other rule, from this same session: the agent ran

```bash
npx biome check src/ 2>&1 | tail -5; echo "biome exit=$?"
```

and reported `biome exit=0`. That `$?` is `tail`'s status, not biome's -- biome had segfaulted. That is `commands/exit-status-masked` exactly, produced live rather than hypothesised, and it is the reason the false "clean" claim survived as long as it did.

---

## 3. `session/default-branch-accumulation`

### What happened

The source session ran for hours across review, fix, coverage and audit phases, editing 25 files. Every one of those edits landed directly in the working tree of `main`, uncommitted, and it surfaced only during a ship-readiness audit at the very end -- not from any git-shaped signal along the way.

Two things made that worse than untidy. The repo's own operating instructions say to branch before committing on the default branch, so the end state was one the session was told to avoid. And the machine was running a fleet: the sibling repo this handoff was written against had 11 locked agent worktrees and a `main` whose `HEAD` moved three times during a single audit. A large uncommitted delta sitting on a shared default branch in that environment is one `git checkout --` or `git stash` away from being someone else's cleanup.

### Proposed check

Flag a session that **accumulates edits to a checkout on its default branch without an intervening commit**, above a threshold. Suggested shape:

- resolve the working branch (`git branch --show-current`, or the transcript's own git output) and compare against the repo default (`main` / `master`, or `origin/HEAD`),
- count distinct files written in the session,
- flag when the count crosses a threshold (start around 10) with no commit recorded in between.

Do not flag: sessions that branch first, sessions that commit as they go, or single-file edits on the default branch -- a one-line typo fix on `main` is normal and flagging it would make the rule noise. The defect is *accumulation*, not the first write.

**Severity: warning.** Nothing is corrupted; the risk is exposure -- reviewability, and collision in a fleet.

**Fixture sketch:** `fixtures/session-default-branch-accumulation/` -- a transcript with 20 file writes on `main` and no commit (expect 1), the same volume after a `git checkout -b` (expect 0), and 3 writes on `main` (expect 0, under threshold).

### Why existing rules miss it

Nothing in the session catalog models git state. This is the third rule here whose signal is *where the work landed* rather than *what it said*, which may argue for a small shared git-context extractor rather than three independent ones -- worth deciding before the first of them is implemented.

---

## Landing order (same as the sibling handoff)

1. Implement the check under `src/core/checks/session/` so it emits the `ruleId`.
2. Add the fixture directory and its expectations.
3. Add the catalog entry to `agent-session-lint-rules.json` **and** `SESSION_IMPL_RULE_IDS` in the same commit -- `catalog-consistency.test.ts:117-135` fails otherwise.
4. Regenerate prose (`pnpm run generate`) so the spec and README counts move together.

## What is NOT proposed here

The source session also found that an MCP server declaring `readOnlyHint: true` alongside `destructiveHint: true` is a spec contradiction, and that a test asserting the two must be strict opposites forces additive tools (`owner_add`, `team_create`, `hook_add`) to over-declare destructiveness -- which makes hosts over-prompt and trains users to click through the prompts that matter.

That is a real and statically checkable defect, but it lives in **MCP server implementations**, and the 29 `mcp-config` rules lint client `.mcp.json` files -- servers, commands, env, urls. There is no surface here that reads tool definitions, so this needs a new lint target rather than a new rule, and that is a product decision rather than a handoff item.
