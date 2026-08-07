# Handoff: five proposed rules derived from a real agent session

**Inspected at:** v0.18.7 (`HEAD 62c0da1`)
**Derived from:** a full-pass review, fix, and release session on `@yawlabs/tailscale-mcp` (landed as `7d24203` on that repo's `main`). Every rule below traces to a defect that actually shipped, survived review, or wasted real time in that session — none are hypothetical.

> **STATUS UPDATE — three of the five have SHIPPED. Do not re-implement them.**
>
> | Section | Rule | State |
> |---|---|---|
> | 1 | `claims/total-vs-parts` | **open** — needs a new `claims` category in `context-lint-rules.json` |
> | 2 | `commands/unknown-subcommand` | **shipped** — `src/core/checks/cli-subcommands.ts` + `commands.ts` |
> | 3 | `commands/exit-status-masked` | **shipped** — `src/core/checks/exit-status.ts` + `commands.ts` |
> | 4 | `contradictions/directive-conflict` | **open** — the handoff's own "highest-FP-risk of the five" |
> | 5 | `session/unresolvable-sha` | **shipped** — `src/core/checks/session/unresolvable-sha.ts` |
>
> Two design notes the implementations added, worth reading before picking up 1 or 4:
>
> - **`fixtures/unknown-subcommand/` was inert against the shared command extractor.** `extractCommandReferences` gates on a fixed `COMMON_COMMANDS` list (npm/npx/make/cargo/...), so `./bin/tailscale-mcp doctor --json` yields ZERO command references and a rule reading `file.references.commands` would have shipped inert with a green unit suite. The check does its own scoped extraction instead, looking only for names the project declares in `package.json#bin`. Any future rule about a project-owned executable inherits this problem — verify extraction against the fixture before building on it.
> - **Static analysis of an entry file must ignore comments and string bodies.** `fixtures/unknown-subcommand/cli.js` carries the comment "an unknown subcommand in the docs reads as a hang"; a raw scan reads that `in` as the `in` operator, decides the dispatch is open, and bails on a perfectly closed one. `stripComments()` in `cli-subcommands.ts` produces the two views the resolver needs.

**Status of the remaining two: SPEC ONLY.** No catalog entries, no spec-table rows, no implementations. See [Why nothing was added to the catalogs](#why-nothing-was-added-to-the-catalogs) — for those two this is still deliberate and is the whole point of one of the rules.

What *is* in this branch: this document, plus five ready-to-run fixture directories under `fixtures/`.

## Coordination with `HANDOFF-ci-claim-and-bin-subcommand-rules.md`

A concurrent effort produced that handoff in this same checkout, sourced from `@yawlabs/postgres-mcp`. The two overlap on exactly one rule and are otherwise disjoint — read both.

- **`commands/unknown-subcommand` is one rule, not two.** That handoff's Finding 3 proposes the same check under the ID `commands/bin-subcommand-not-found` and then defers naming to this document. Use **`commands/unknown-subcommand`**. Implement it once, from [section 2 below](#2-commandsunknown-subcommand), which now resolves the open design question that handoff raised.
- **Its Findings 1, 2 and 4 do not overlap with anything here.** Finding 4 in particular is independently verified below and is load-bearing for this document's central argument.
- Both documents were written against `v0.18.7` / `62c0da1`.

Rule IDs here satisfy the **prefix-equals-category** invariant documented at `CONTRIBUTING.md:72` and enforced by `checkRuleIdPrefixes` (`src/core/__tests__/catalog-schema.test.ts:58-66`): `claims/`, `commands/`, `commands/`, `contradictions/`, `session/` each equal their rule's `category`. The `ci/*` allowlist is closed — nothing here needs to touch it.

---

## TL;DR

| Proposed rule | Catalog | Severity | Motivating real defect |
|---|---|---|---|
| `claims/total-vs-parts` | context | warning | README stated `89 tools` while its own enumerated sections summed to `93` |
| `commands/unknown-subcommand` | context | error | Release script told operators to run `<bin> doctor --json`; no such subcommand — it hung on stdio instead |
| `commands/exit-status-masked` | context | warning | `npx tsc --noEmit \| head -20 && echo "tsc clean"` printed `tsc clean` over a real type error |
| `contradictions/directive-conflict` | context | warning | Two always-loaded files: "do not use workflows unless requested" vs "default to workflows for every substantive task" |
| `session/unresolvable-sha` | session | warning | A memory attributed a change to a SHA that is not the commit that made it |

Existing rules I checked against and did **not** duplicate: `paths/not-found`, `skill/broken-ref`, `commands/script-not-found`, `commands/make-target-not-found`, `commands/npx-not-in-deps`, `contradictions/conflict`, `session/stale-memory`, `redundancy/duplicate-content`, `tier-tokens/hard-enforcement-missing`.

---

## Why nothing was added to the catalogs

The catalogs are the source of truth: `scripts/generate-catalog-prose.mjs` derives the `N rules` header in each spec and the README family-table counts *from* them. Adding a rule entry therefore makes the published spec and README advertise a rule that does not run.

That is precisely the defect class this handoff exists to catch — and it is the single most common thing the source session had to fix (a README claiming 89 tools, a build script naming a subcommand that did not exist, a code comment asserting a contract the code did not hold). Shipping unimplemented catalog entries here would reproduce it inside the linter meant to detect it.

**This is not hypothetical — ctxlint already has a live instance.** The concurrent handoff's Finding 4 reports it and I verified it independently at `62c0da1`:

| Published in `context-lint-rules.json` | Actually emitted by the implementation |
|---|---|
| `ci/no-release-docs` | `ci-coverage/no-release-docs` (`src/core/checks/ci-coverage.ts:96`) |
| `ci/undocumented-secret` | `ci-secrets/undocumented-secret` (`src/core/checks/ci-secrets.ts:127`) |

Those two catalog IDs are emitted by nothing. A user who reads the spec and writes a suppression or a CI filter for `ci/no-release-docs` silences nothing, and never finds out. The catalog is published API, so the fix is a judgement call about which side moves — that belongs to the other handoff, which owns the finding. It is cited here only as proof that "catalog entry without a matching emitter" is a failure this project can and does ship.

There is also a hard blocker for one of them. `src/core/__tests__/catalog-consistency.test.ts:117-135` asserts:

- every session catalog rule ID has an entry in `SESSION_IMPL_RULE_IDS`, and
- those mapped IDs are **exactly** the `ruleId` literals emitted under `src/core/checks/session/`.

So `session/unresolvable-sha` **cannot** be added to `agent-session-lint-rules.json` before its implementation emits that `ruleId`. Catalog and code must land in the same commit.

### Correct landing order per rule

1. Implement the check under `src/core/checks/` (or `src/core/checks/session/`) so it emits the `ruleId`.
2. Add the rule object to the catalog (shape below; `stability: "experimental"` for all five).
3. For a **session** rule only: add the `SESSION_IMPL_RULE_IDS` mapping entry.
4. Add the rule's row to the matching `*_SPEC.md` table — the per-rule prose tables are hand-authored, only counts are generated.
5. Run `npm run generate` to sync the count headers, then `npm run generate:check` to confirm.
6. `npm test` — `catalog-schema`, `catalog-consistency`, and `catalog-generate` all gate this.

Catalog object shape (required keys, from `schemas/ctxlint-catalog.schema.json`): `id`, `category`, `severity` (`error` | `warning` | `info`), `description`, `trigger`, `message`, `fixable`, `stability` (`stable` | `experimental`).

`claims` would be a **new category** and needs a `categories[]` entry in `context-lint-rules.json` alongside `paths`, `commands`, `staleness`, … The other four extend existing categories.

---

## 1. `claims/total-vs-parts`

**Fixture:** `fixtures/claim-total-vs-parts/`

A document states a total (`89 tools`) and separately enumerates parts (`(1 tool)`, `(17 tools)`, `(11 tools)`, `(4 tools)`). When the parts are a partition of the total, they must reconcile. In the source repo they did not: the total was 89, the sections summed to 93, and the gap was an opt-in group nobody re-counted. It shipped, and the wrong number was in the README for multiple releases.

```json
{
  "id": "claims/total-vs-parts",
  "category": "claims",
  "severity": "warning",
  "description": "A stated total disagrees with the sum of the enumerated parts in the same document.",
  "trigger": "A document states \"N <noun>\" and also enumerates sibling parts each stating \"(M <noun>)\", where the sum of M differs from N.",
  "message": "stated total {total} {noun} does not match the sum of enumerated parts ({sum})",
  "fixable": false,
  "stability": "experimental"
}
```

**Algorithm**

1. Extract candidate counts as `(\d+)\s+(\w+?)s?\b` with the matched noun normalized to lowercase singular. Skip fenced blocks.
2. Group by normalized noun. Require >= 3 occurrences of the noun to consider it at all.
3. Identify the **parts set**: counts appearing in structurally sibling positions — same-depth `<summary>` elements, same-level list items, or rows of one table. Identify the **total**: a count of the same noun outside that structure.
4. Report when `sum(parts) != total`.

**False-positive boundary (encoded in the fixture's `AGENTS.md`)**
The negative control deliberately includes profile bullets `(20 tools)` and `(29 tools)` that are *overlapping subsets*, not parts. A naive implementation that sums every `(N tools)` on the page fires there and is wrong. Only a structurally sibling set counts as a partition. **If you cannot identify a sibling set with confidence, emit nothing** — this rule is worthless if it cries wolf on every doc with numbers in it.

---

## 2. `commands/unknown-subcommand`

**Fixture:** `fixtures/unknown-subcommand/`

`commands/*` today validates `npm run` script names, make targets, and npx packages. It does not validate subcommands of the binary the repo itself ships. The source session found a release script instructing operators to verify a freshly built binary with `<bin> doctor --json` — there is no `doctor` subcommand. Worse than a no-op: unknown args fall through to MCP server startup, so the verification step blocks on stdio and reads as a hang.

```json
{
  "id": "commands/unknown-subcommand",
  "category": "commands",
  "severity": "error",
  "description": "A documented invocation of the project's own binary uses a subcommand the CLI does not implement.",
  "trigger": "A command invokes a name declared in package.json#bin with a leading non-flag argument that is not in the CLI's known subcommand set.",
  "message": "\"{cmd}\" — \"{sub}\" is not a subcommand of {bin} (known: {known})",
  "fixable": false,
  "stability": "experimental"
}
```

**Algorithm**

1. Build the owned-binary set from `package.json#bin` (keys, and basenames of values).
2. For each extracted command whose argv[0] resolves to one of those, take the first argument not starting with `-` as the candidate subcommand.
3. Resolve the known set by statically scanning the bin's entry source (see the resolved design question below). The fixture's `cli.js` is written in the hand-rolled-argv shape.
4. Report only when the known set was resolved **non-empty**. If it could not be determined, skip silently (or emit an `info`, mirroring `commands/package-json-missing`).

**Do not** execute the binary with `--help` to discover subcommands. The motivating bug is a CLI that *hangs* on unrecognized input; shelling out to it is how a linter inherits that hang.

### Resolved: Commander-only vs hand-rolled argv

`HANDOFF-ci-claim-and-bin-subcommand-rules.md` Finding 3 raises this and deliberately leaves it open: it recommends **Commander-only** detection, while this effort's fixture implies **literal-argv** detection. Its author is right that a wrong "that subcommand does not exist" is worse than silence. Resolution — **do both, tiered, with an explicit bail-out**:

1. **Commander first.** Statically match `.command('<name>')`. High confidence; covers the large Node-CLI population.
2. **Then hand-rolled argv**, but accept the extracted set only if it is *closed*: every comparison against `process.argv[2]` (or a variable directly assigned from it) is against a **string literal**, or a `.includes()` on a **literal array**.
3. **Bail silently the moment the dispatch is open.** If `argv[2]` is compared against a variable, an imported map, a computed key, `Object.keys(...)`, or is used to index a lookup table, emit nothing for that binary. This is the "computed or aliased subcommands" case, and it is exactly where literal-argv scanning would produce the confident-but-wrong finding.
4. **No recognizable dispatcher at all → emit nothing.** (This was the other handoff's explicit minimum ask; it is satisfied by 3 and 4 together.)
5. **Adopt its gating suggestion:** only attempt this when `bin` resolves into source. A bundled or minified `dist/index.js` is unparseable, and guessing at it is how the rule earns a reputation for noise.

Rationale for not taking the Commander-only recommendation as-is: every `@yawlabs/*-mcp` server hand-rolls its argv dispatch, and those repos are the entire corpus that produced this defect — twice, independently (tailscale-mcp and postgres-mcp both shipped a documented `doctor` subcommand that does not exist). A rule that structurally cannot fire on the codebases that generated the bug is not worth the catalog entry. The closed-set requirement in step 2 is what buys the coverage without the false positives, because it makes the detector's confidence explicit rather than assumed.

---

## 3. `commands/exit-status-masked`

**Fixture:** `fixtures/masked-exit-status/`

A shell pipeline's exit status is the last command's. `npx tsc --noEmit | head -20 && echo "tsc clean"` reports `head`'s success, so the `&&` fires and prints `tsc clean` over a real type error. This happened live during the source session: a type error was announced as clean, and because the `&&` chain continued, the test run that followed was silently skipped. Context files and skills are full of copy-paste verification snippets, and this class converts "prove it works" into "print that it works."

```json
{
  "id": "commands/exit-status-masked",
  "category": "commands",
  "severity": "warning",
  "description": "A verification command's exit status is masked by a pipe into a filter, so a following success claim cannot fail.",
  "trigger": "A verification command is piped into a pager/filter and the pipeline is followed by && plus a success-announcing command, without `set -o pipefail` in scope.",
  "message": "\"{cmd}\" — exit status comes from \"{filter}\", not \"{verifier}\"; the success claim cannot fail",
  "fixable": false,
  "stability": "experimental"
}
```

**Algorithm** — require **all four** conditions, which is what keeps this quiet:

1. The pipeline's **first** command is a verifier: `tsc`, `eslint`, `biome`, `vitest`, `jest`, `pytest`, `mypy`, `ruff`, `cargo test`, `go test`, or an `npm|pnpm|yarn|bun run <script>` whose script body starts with one.
2. It is piped into a filter/pager: `head`, `tail`, `grep`, `sed`, `awk`, `less`, `more`, `cat`, `tee`.
3. The pipeline is followed by `&&` and a success-announcing command — `echo`/`printf` whose literal matches `/\b(ok|clean|pass(ed)?|green|success|done)\b/i`.
4. No `set -o pipefail` (or `set -eo pipefail`) earlier in the same fenced block.

The fixture carries three negative controls, one per relaxable condition: no filter in the pipeline, `pipefail` in scope, and a pipe with no success claim (reading output through a pager is normal and must stay silent).

**Suggested fix text:** `set -o pipefail`, or drop the filter, or use `${PIPESTATUS[0]}`.

---

## 4. `contradictions/directive-conflict`

**Fixture:** `fixtures/directive-conflict/`

`contradictions/conflict` catches two files choosing mutually exclusive *config options* in the same category. It does not catch two *behavioural directives* disagreeing. In the source session, one always-loaded instruction said "do not use workflows or sub-agents unless the user requested it" while another always-loaded overlay said "default to authoring and running a Workflow for every substantive task." Both were live on every turn; the agent had to silently pick one, repeatedly, with no signal to the user that their configuration was self-contradictory.

```json
{
  "id": "contradictions/directive-conflict",
  "category": "contradictions",
  "severity": "warning",
  "description": "Two always-loaded context files give opposing behavioural directives about the same subject.",
  "trigger": "Two always-loaded files contain imperative directives with opposite polarity on the same normalized subject.",
  "message": "conflicting directives on \"{subject}\": {fileA} says {polarityA}, {fileB} says {polarityB}",
  "fixable": false,
  "stability": "experimental"
}
```

**Algorithm**

1. Restrict to the **always-loaded tier**. `tier-tokens/*` already computes this — reuse it. Directives in on-demand skills are scoped and may legitimately override.
2. Extract directives: `(NEVER|ALWAYS|DO NOT|DON'T|AVOID|DEFAULT TO|PREFER|ONLY|MUST NOT|MUST)\s+(.{0,60})`. `tier-tokens/hard-enforcement-missing` already scans NEVER/ALWAYS framing — share the extractor.
3. Normalize the predicate to a subject key: lowercase, strip articles/modals, lemmatize the head noun (`workflows` -> `workflow`).
4. Assign polarity: prohibitive (`NEVER`, `DO NOT`, `AVOID`, `MUST NOT`) vs prescriptive (`ALWAYS`, `DEFAULT TO`, `PREFER`, `MUST`).
5. Report when one subject key carries both polarities across two different files.

**False-positive boundary:** the fixture's two files carry an *identical* directive ("Always run the full suite before committing") as a negative control. Agreement is redundancy, not conflict — `redundancy/duplicate-content` owns that. Also beware the legitimate `NEVER x unless y` escape-hatch form; a bare polarity flip on a qualified directive is the most likely source of noise here. This is the highest-FP-risk rule of the five; consider shipping it `info` first.

---

## 5. `session/unresolvable-sha`

**Fixture:** `fixtures/stale-sha/`

`session/stale-memory` covers memories referencing dead *paths*. Memories and rules also accumulate git SHA citations, which rot faster than paths — a squash-merge rewrite invalidates every SHA in a branch.

```json
{
  "id": "session/unresolvable-sha",
  "category": "session",
  "severity": "warning",
  "description": "A memory or context file cites a git SHA that does not resolve in the repository.",
  "trigger": "A 7-40 character hex token outside code fences does not resolve via git cat-file.",
  "message": "cited commit {sha} does not resolve in this repository",
  "fixable": false,
  "stability": "experimental"
}
```

**Algorithm**

1. Extract `\b[0-9a-f]{7,40}\b` outside fenced blocks, and not preceded by `#` (hex colours).
2. Reject anything with a non-hex neighbour character, and any token that is a version-like string.
3. `git cat-file -t <token>` — report only when it does **not** resolve. Requires git, like `staleness/*`; declare `"requires": "git"` on the category or skip cleanly without a repo.

**Do not** try to filter by shape alone. The fixture includes `beadfaced` — nine hex characters that read as an English word — specifically because a pattern-only implementation fires on it. Resolution is what makes this precise, and it is why the check must be `git cat-file`-backed rather than regex-backed.

**Honest scope note:** the motivating instance was subtler than what this v1 catches. A project memory attributed a CI-removal change to `1b18b85`, which *does* resolve — it is simply not the commit that made the change (that was `14ef069`). Detecting *misattribution* means comparing the cited commit's subject/diff against the surrounding prose claim. That is a genuinely different, much fuzzier rule. **v1 should ship the crisp unresolvable check only**; misattribution is a stretch goal and should not be smuggled in under this rule ID.

---

## Fixtures added by this branch

| Directory | Positive cases | Negative controls |
|---|---|---|
| `fixtures/claim-total-vs-parts/` | `CLAUDE.md`: total 89 vs parts summing 33 | `AGENTS.md`: reconciled total, plus overlapping-subset bullets that must not be summed |
| `fixtures/unknown-subcommand/` | `CLAUDE.md`: `doctor` | `--version`, `validate-acl`; `cli.js` supplies the known set |
| `fixtures/masked-exit-status/` | `tsc \| head && echo`, `eslint \| tail && echo` | no-filter, `pipefail`-in-scope, no-success-claim |
| `fixtures/directive-conflict/` | workflows: prohibitive vs prescriptive across two always-loaded files | identical "always run the full suite" directive in both |
| `fixtures/stale-sha/` | `1b18b85`, `deadbee` | version numbers, 6-char hex, `#a1b2c3` colour, `beadfaced`, fenced SHA |

Each fixture carries an HTML comment stating the expected finding and, where it matters, *why* the negative control is the interesting half. None of them are wired into a test yet — they are inert until an implementation exists.

## Verification state of this branch

`vitest run` at the time of writing: **57 files, 1062 passed, 2 skipped, 0 failed**, and `node scripts/generate-catalog-prose.mjs --check` reports catalog-derived prose in sync. Fixtures are inert data; no catalog, spec, README, or source file was modified by this branch. If the suite is red when you pick this up, it is not from here.

Note that run happened in a shared checkout that also contained another session's uncommitted work (an in-progress edit to `src/utils/__tests__/tokens.test.ts`, plus the concurrent handoff). That work is **not** part of this branch — only this document and the five `fixtures/` directories were staged. Re-run the suite on a clean tree before treating the numbers above as a baseline for your own change.
