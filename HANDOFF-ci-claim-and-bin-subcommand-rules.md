# Handoff: three proposed rules (inverse-CI, zero-CI, bin subcommands) + one catalog/emitter ID mismatch

**Inspected at:** v0.18.7 (`HEAD 62c0da1`, branch `main`, clean tree)
**Sourced from:** a full-pass audit of the sibling repo `@yawlabs/postgres-mcp`, where four separate context/doc claims were confidently wrong in ways ctxlint does not currently catch. Each proposal below is a generalization of a defect that was actually found and fixed there, not a hypothetical.

Every claim cites `file:line` in THIS repo. Findings 1-3 are new rules; finding 4 is a bug in the shipped catalog and needs no new rule.

---

## TL;DR

| # | Proposal | Category | Kind |
|---|---|---|---|
| 1 | `ci-coverage/workflow-not-found` — context names a workflow file that is not on disk | `ci-coverage` | new rule |
| 2 | `ci-coverage/no-workflows` — context describes CI, repo has no workflows at all | `ci-coverage` | new rule |
| 3 | bin subcommand validation — **in flight elsewhere as `commands/unknown-subcommand`**; read that section for the one open design question, do not re-implement | `commands` | in flight |
| 4 | `ci/no-release-docs` and `ci/undocumented-secret` are published in the catalog but **never emitted** | `ci-coverage`, `ci-secrets` | bug |

Findings 1 and 2 are the **inverse** of what `ci-coverage` does today. `src/core/checks/ci-coverage.ts:82-102` reads: workflows exist on disk -> is the release process documented? It returns early (`:88`) when `.github/workflows` yields nothing. The failure mode found in postgres-mcp is the other direction — **docs assert a pipeline that does not exist** — and it is currently unreachable by any rule.

---

## Read this first: the rule-ID invariant

`CONTRIBUTING.md:72` documents a **prefix-equals-category** invariant, enforced by `checkRuleIdPrefixes` and asserted in `src/core/__tests__/catalog-schema.test.ts:62`. New rules must use their **full category** as the ID prefix. The two `ci/*` IDs are a closed legacy allowlist (`catalog-schema.test.ts:27-28`) and `CONTRIBUTING.md:72` says explicitly: *"Do not add new entries to that allowlist."*

So the new IDs are `ci-coverage/...` and `commands/...`, **not** `ci/...`. Getting this wrong fails `pnpm run test:run`.

---

## Finding 1 — `ci-coverage/workflow-not-found`

### What happened in the source repo

postgres-mcp deleted its `release.yml` when registry publish moved into `release.sh`, but three files still described it as live:

- a build script header: *"The binary BUILD is CI (release.yml on tag push); this manifest BUMP runs locally after."*
- a second script's comment asserting the same
- `.gitattributes`: *"CI lint fails with a full-file formatter diff on Windows runners"*

Meanwhile `release.sh` itself had been correctly updated and guarded every CI branch with `[ -f ".github/workflows/release.yml" ]`. So the repo simultaneously contained code that knew the workflow was gone and prose that did not. An agent reading the prose would wait for a CI run that never starts.

### Proposed trigger

A context file names a workflow file (`release.yml`, `ci.yaml`, `.github/workflows/<x>.yml`) that does not exist at that path.

The extraction is narrow on purpose: match an explicit `*.yml` / `*.yaml` token that is either preceded by `.github/workflows/` or is a bare filename appearing within N characters of a CI-ish word (`workflow`, `CI`, `Actions`, `pipeline`). Do **not** treat every `foo.yml` mention as a workflow claim — `docker-compose.yml` and `pnpm-workspace.yaml` will produce noise. Note `paths/not-found` already covers a bare `.github/workflows/release.yml` written as a **path**; this rule is for the *named-without-a-path* case (`release.yml on tag push`), which the path extractor does not treat as a path reference.

### Catalog entry

```json
{
  "id": "ci-coverage/workflow-not-found",
  "category": "ci-coverage",
  "severity": "warning",
  "description": "A context file describes a CI workflow file that does not exist in .github/workflows.",
  "trigger": "Context references a <name>.yml/.yaml workflow in a CI context, but no such file exists under .github/workflows.",
  "message": "{workflow} is described as a CI workflow but does not exist in .github/workflows",
  "fixable": false,
  "stability": "experimental"
}
```

`experimental` per `CONTRIBUTING.md:80` — the matching is heuristic, so this is a patch bump, not a minor.

---

## Finding 2 — `ci-coverage/no-workflows`

The high-signal degenerate case of finding 1, and worth its own ID because it can be near-zero-false-positive.

postgres-mcp has **no `.github/` directory at all**, yet four files talk about CI runners, CI lint gates, and tag-triggered builds. When `.github/workflows` is absent or empty *and* a context file matches the existing `RELEASE_DOC_PATTERNS` (`src/core/checks/ci-coverage.ts:10-23`), the docs are describing infrastructure that cannot run.

Most of the machinery already exists. `findReleaseWorkflows` (`:26`) and `contextMentionsRelease` (`:71`) are the two halves; today `checkCiCoverage` fires only on `workflows non-empty AND NOT documented` (`:88-90`). This rule is the opposite corner of the same 2x2:

| | context mentions release | context silent |
|---|---|---|
| **workflows exist** | ok | `ci-coverage/no-release-docs` (today) |
| **no workflows** | **`ci-coverage/no-workflows` (proposed)** | ok |

### Guard against the obvious false positive

A repo with no CI that documents `./release.sh` as a **local** flow is correct, not broken. `RELEASE_DOC_PATTERNS` currently matches `/npm\s+publish/i` and `/git\s+tag\s+v/i`, which a purely local release doc absolutely contains — firing on those alone would be wrong, and postgres-mcp's own `release.sh` is exactly that repo.

Narrow the trigger to phrasing that asserts *hosted* CI specifically: `CI`, `GitHub Actions`, `workflow`, `runner`, `on tag push`, `.yml`. Do not reuse `RELEASE_DOC_PATTERNS` unmodified. Fixture `fixtures/empty-project` is a good negative control; a new fixture with a CI-claiming CLAUDE.md and no `.github/` is the positive.

### Catalog entry

```json
{
  "id": "ci-coverage/no-workflows",
  "category": "ci-coverage",
  "severity": "warning",
  "description": "A context file describes hosted CI, but the repository has no workflow files.",
  "trigger": "Context asserts CI/GitHub Actions/runners while .github/workflows is absent or contains no workflow files.",
  "message": "Context describes CI but no workflows exist in .github/workflows",
  "fixable": false,
  "stability": "experimental"
}
```

---

## Finding 3 — bin subcommand validation — **ALREADY IN FLIGHT, read this before starting**

**Status: do not implement from this section.** While this handoff was being written, another agent was writing `fixtures/unknown-subcommand/` into this checkout (untracked at the time of writing; `CLAUDE.md` + `cli.js` + `package.json`, mtime 07:07:49). It targets the same defect under the rule ID **`commands/unknown-subcommand`** — and its fixture is the same scenario described below, down to a documented `doctor` subcommand on an MCP server binary whose unknown args fall through to server startup and read as a hang.

Their fixture is the authority on naming; **use `commands/unknown-subcommand`, not the `commands/bin-subcommand-not-found` ID proposed further down.** This section is kept only for the design tradeoff in "Step 3", which the two efforts answer *differently* and which someone should decide deliberately rather than by merge order:

- Their `cli.js` is annotated *"Minimal argv dispatch in the shape the detector must read: string-literal comparisons against `process.argv[2]`"* — i.e. they are building the hand-rolled-argv detector.
- The recommendation below is the opposite: **Commander-only, emit nothing when no recognizable dispatcher is found.**

Neither is obviously right. Literal-argv matching covers more real CLIs (including every `@yawlabs/*-mcp` server, which all hand-roll) but false-positives on any CLI whose subcommands are computed, aliased, or built from a table — and a wrong *"that subcommand does not exist"* is worse than silence, because the reader's correct doc looks broken. Whoever lands this should at minimum make the detector bail out silently when the entry file has no recognizable dispatcher at all, rather than treating "found no subcommands" as "the set is empty."

Also present and untracked from the same effort, unrelated to these findings: `fixtures/claim-total-vs-parts/`, `fixtures/directive-conflict/`, `fixtures/masked-exit-status/`.

### What happened in the source repo

postgres-mcp's binary-build script closed by printing verification steps to the operator:

```
Verify with:
    "<path>/postgres-mcp.exe" --version
    "<path>/postgres-mcp.exe" doctor --json
```

`doctor` was never implemented. The entrypoint handled only `version` / `--version`; every other argument fell through and silently started the stdio MCP server, so `postgres-mcp doctor --json` printed nothing and looked like a hang. The line was copy-paste from a sibling repo's template — exactly the drift ctxlint exists to catch.

### Why the existing `commands` check misses it

`src/core/checks/commands.ts:13` matches `npm run X` / `pnpm|yarn|bun [run] X` and `make X` (`:14`), validating against package.json scripts and the Makefile. A project's **own** bin has no equivalent. The irony worth noting: `doctor` already appears in that file's `PM_BUILTIN_SUBCOMMANDS` set (`:39`) — but that set is about *package-manager* subcommands, and does nothing for a project-owned binary.

### Proposed trigger

1. Read the `bin` field of package.json — `loadPackageJson` is already imported at `commands.ts:4`. Keys are the on-PATH command names.
2. In context files, match `<binName> <bareword>` where bareword is `[a-z][a-z0-9:-]*` and not flag-shaped.
3. Resolve the bin's entry file and extract its known subcommands.

Step 3 is the hard part and determines whether this ships. Two viable sources, in order of preference:

- **Commander** (ctxlint itself uses it — `commander` is a devDep, and `src/cli.ts` is the consumer): statically match `.command('<name>')` calls in the bin's source. Reliable for the many Node CLIs built on it.
- **Fallback:** scan for string literals compared against `argv[2]`, which is what postgres-mcp does (`if (subcommand === "version" ...)`).

**Recommendation:** ship the Commander path only, and emit nothing when no recognizable dispatcher is found. A rule that guesses at hand-rolled argv parsing will produce false positives on every CLI whose subcommands are computed rather than literal, and a false "that subcommand does not exist" is worse than silence. Mark `experimental` and consider gating on `bin` resolving into `src/` (a bundled `dist/index.js` is minified and unparseable).

### Catalog entry

```json
{
  "id": "commands/bin-subcommand-not-found",
  "category": "commands",
  "severity": "warning",
  "description": "A context file invokes a subcommand of this project's own binary that the binary does not implement.",
  "trigger": "Context contains `<bin> <subcommand>` where <bin> is a key of package.json `bin` and <subcommand> is not among the subcommands the entrypoint dispatches.",
  "message": "{bin} does not implement the {subcommand} subcommand",
  "fixable": false,
  "stability": "experimental"
}
```

---

## Finding 4 — WITHDRAWN. The premise was wrong.

> **RETRACTED.** This section originally claimed the catalog was wrong because
> it publishes `ci/no-release-docs` while the checks emit
> `ci-coverage/no-release-docs`, and a later pass escalated it to "11 of 72
> emitted ids are published nowhere" after finding the same shape across the
> session pillar.
>
> **Both claims were wrong.** The two-level scheme is deliberate and
> documented. `AGENT_SESSION_LINT_SPEC.md` section 3 ("Catalog rule IDs vs.
> reference-implementation ruleIds", line 352) states it outright: catalog IDs
> use the pillar-stable `session/<slug>` form and are "the cross-tool names to
> use in documentation, configuration, and issue reports", while the reference
> implementation namespaces the `ruleId` it emits in `--format json` by check
> module. The spec publishes the full correspondence table, and
> `src/core/__tests__/catalog-consistency.test.ts:94-137` pins it in both
> directions — catalog-to-map and map-to-emitted-literals — so neither side can
> drift silently. That test is exactly the guard I thought was missing.
>
> A `catalog-emitter-parity.test.ts` was added on this premise and has been
> removed; the catalog edits it motivated were reverted. Anyone reading the
> earlier version of this section should ignore it.
>
> **The one real (and small) residue:** the `ci` pillar uses the same two-level
> scheme as `session` but has no published correspondence table. The session
> mapping is documented in its spec and pinned by a test; the `ci/*` pair is
> only described as a "legacy" prefix exception in `CONTRIBUTING.md:72` and
> `catalog-schema.test.ts:20-29`, with nothing stating that
> `ci/no-release-docs` corresponds to the emitted `ci-coverage/no-release-docs`.
> That is a documentation gap worth closing — add the pair to
> `CONTEXT_LINT_SPEC.md` in the same shape as the session table — not a bug.
>
> Lesson for the next agent: a rule ID appearing in a catalog but not in
> `grep -r "ruleId:" src/` is NOT evidence of drift in this repo. Check the
> pillar's spec section 3 and `catalog-consistency.test.ts` first.

**Original text follows, retained only so the retraction has context. Do not act on it.**

| Catalog `id` | Emitted `ruleId` |
|---|---|
| `ci/no-release-docs` (`context-lint-rules.json`) | `ci-coverage/no-release-docs` (`src/core/checks/ci-coverage.ts:96`) |
| `ci/undocumented-secret` (`context-lint-rules.json`) | `ci-secrets/undocumented-secret` (`src/core/checks/ci-secrets.ts:127`) |

Verified: `ci/no-release-docs` and `ci/undocumented-secret` appear **nowhere** in `src/` except the allowlist itself (`catalog-schema.test.ts:27-28`) and a doc comment (`catalog-schema.ts:248-249`). There is no mapping layer. A downstream consumer that suppresses or filters on the published ID `ci/no-release-docs` matches nothing, forever.

`CONTRIBUTING.md:72` justifies the allowlist as *"their IDs are published API and stay as-is"* — but the linter does not emit them, so whatever is published API, it is not what the catalog says.

### Why no test caught it

`catalog-schema.test.ts` validates the catalog **against itself** — schema shape (`:38`), category cross-references (`:47`, `:52`), duplicate IDs (`:57`), prefix invariant (`:62`), allowlist entries still present (`:77`). Nothing compares catalog IDs to the `ruleId` values the checks actually emit, so the two can diverge indefinitely.

### Suggested fix

Decide which side is authoritative, then **add the parity test** — it is the durable part:

- **If the catalog is right** (`ci/*` really is published API): change the two emitters and delete nothing.
- **If the code is right** (likelier — `ci-coverage/*` satisfies the prefix invariant on its own): correct the two catalog IDs, drop the allowlist entirely, and simplify `checkRuleIdPrefixes`. This is a breaking change to two published rule IDs, so it needs a CHANGELOG note under the versioning policy.

Either way, add a test asserting every emitted `ruleId` exists in a catalog and vice versa. Emitted IDs are string literals in `src/core/checks/**`, so a static scan is enough; a runtime harness over the fixtures would be stronger.

---

## Suggested order

1. **Finding 4 first.** It is a real shipped bug, it is small, and the parity test it motivates protects the other rules from the same drift.
2. **Finding 2.** Most of the code exists in `ci-coverage.ts`; it is one more branch plus a narrower pattern set.
3. **Finding 1.** Same file, needs new extraction.
4. **Finding 3 is not on this list** — it is in flight under `commands/unknown-subcommand`. The only thing owed to it from here is the literal-argv-vs-Commander decision recorded in that section.

Per `CONTRIBUTING.md:169`, two new experimental rules = patch bump.

**Coordination note.** This document was written against `HEAD 62c0da1` on a clean tree, but four untracked fixture directories appeared in this checkout during the writing (07:07:34 through 07:08:16), so at least one other agent is working here. Nothing in this handoff modifies a tracked file except `src/utils/__tests__/tokens.test.ts`; the fixtures were read but not touched. Re-check `git status` before acting on any of this.

---

## Also changed in this handoff

`src/utils/__tests__/tokens.test.ts` — the `encoder construction failure` test used `return` inside the test body when `tiktoken` could not be resolved, so vitest reported it as **passing** on a machine without tiktoken. Converted to `it.skipIf(!tiktokenPath)` so an unrun test reports as skipped, matching `skill-scanner.test.ts:59` and `hook-coverage.test.ts:237`. The second early return (`if (!mod) return`) became an assertion — the module was just `require()`d, so a missing cache entry is a broken assumption, not a reason to no-op.

This was the only instance of that shape in the repo; the `it.skipIf` convention is otherwise followed. It is called out because the same pattern in postgres-mcp hid five tests that proved nothing (three `pg_top_queries`, two `pg_table_bloat`) because an optional postgres extension was absent — the tests were written to accept a "not installed" error as valid and returned early, so they went green for months while never executing the SQL they existed to cover.

---

## Not proposed, and why

- **Tool-annotation honesty** (an MCP tool advertising `readOnlyHint: true` while its description admits destructive reach). Came up in the source audit, but `mcp-config-lint` covers `.mcp.json` **server configs**, not tool definitions — the annotations are not in any file ctxlint reads. This belongs to `mcp-compliance`, which tests live servers over the wire.
- **`npm login --auth-type=web` in release scripts** and **`git add -u` never staging new files.** Both were real defects in postgres-mcp's `release.sh`. Checked: ctxlint's `release.sh` has neither pattern, and ctxlint does not use the `input as {...}` post-Zod cast that caused a third class of bug there. No action.
