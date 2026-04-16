# Changelog

All notable changes to `@yawlabs/ctxlint` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
See [Versioning policy](#versioning-policy) below.

## [Unreleased]

## [0.9.17] — 2026-04-16

### Added
- **`.mcph.json` linting** — 10 new rules under the `mcph-config/*` ID family for the config file read by the `@yawlabs/mcph` CLI. Distinct from `.mcp.json` (client-side MCP server list): `.mcph.json` holds auth token + API base + allow/deny lists for the mcph binary that orchestrates mcp.hosting-managed servers.
- Rules cover five themes: **token security** (`token-in-project-scope` error on git-tracked project files, `invalid-token-format`, configurable `prefer-env-token`), **API endpoint validation** (`insecure-apibase` on public plaintext HTTP, `invalid-apibase`), **schema conformance** (`unknown-field` to catch typos like `tokens` vs `token`, `stale-version`), **allow/deny list semantics** (`allowlist-denylist-conflict`, `duplicate-entries`), and **gitignore hygiene** (`local-file-not-gitignored` with auto-fix).
- New CLI flags: `--mcph`, `--mcph-only`, `--mcph-global`, `--mcph-strict-env-token` (upgrades `prefer-env-token` from warning to error).
- New machine-readable catalog: [`mcph-config-lint-rules.json`](./mcph-config-lint-rules.json).
- Token-related rules emit per-shell `export MCPH_TOKEN` examples (bash/zsh, fish, PowerShell, direnv) and include the rotation URL (`https://mcp.hosting/settings/tokens`) when a leak is already on-disk.

### Why
`mcph install` flows hand out PATs (`mcp_pat_*`) that must not land in committed config. The existing `.mcp.json` rules don't apply — different schema, different threat model. This adds a parallel rule family so teams adopting mcph get the same leak-detection bar without writing custom scripts.

## [0.9.16] — 2026-04-16

### Security
- MCP tools now validate `projectPath` (and `ctxlint_validate_path`'s `path` parameter) at the tool boundary. Inputs containing shell metacharacters (`;`, `|`, backticks, `$(`, `${`, newlines) are rejected with a generic error that does not echo the input. `projectPath` must resolve to an existing directory.
- Defense-in-depth: ctxlint uses Node `fs` APIs (no shell), so there is no actual injection surface. This change eliminates false-positive signals from security scanners that grep tool output for reflected payloads and hardens a user-provided entry point against malformed input.

### Changed
- `ctxlint_audit` description no longer names sibling tools (`ctxlint_mcp_audit`, `ctxlint_session_audit`). Reworded to describe scope without choreographing workflows across tools — sibling tool names rot on rename and encourage LLMs to pattern-match from descriptions instead of reading each tool's own definition.

### Why
Dogfood run against mcp-compliance scored 97 → 98 → 100 across these changes. The injection false-positive was a real defense-in-depth gap once we looked at it (no shell, but also no validation); the cross-tool description was a guideline violation we were only one reword away from fixing.

## [0.9.15] — 2026-04-16

### Added
- `ctxlint serve` subcommand as a discoverable alias for `--mcp-server`. `mcp` is already overloaded in the lint flags (`--mcp`, `--mcp-only`, `--mcp-global`), so `serve` is the clearer name for launching the stdio MCP server. The `--mcp-server` flag continues to work for back-compat.

### Changed
- README integration examples (Claude Code, `.mcp.json`, VS Code, Claude Desktop) updated to use `serve` instead of `--mcp-server`.

### Why
Running `npx @yawlabs/ctxlint` without the flag drops into the CLI linter and exits — confusing for users expecting a stdio MCP server. `serve` gives a clean, discoverable entry point that matches the README's integration examples.

## [0.9.14] — 2026-04-16

Housekeeping release — keeps the published package in step with `main` after a post-0.9.13 formatting fix.

### Changed
- **Internal:** prettier-formatted a comment block in `src/mcp/server.ts`. No functional change; the bundled artifact is identical to 0.9.13 modulo the version string.

## [0.9.13] — 2026-04-16

Third pre-1.0 review pass — MCP server schema tightening and a session-scanner edge-case guard.

### Fixed
- **MCP tools' `checks` parameter is now domain-scoped.** Previously every MCP tool (`ctxlint_audit`, `ctxlint_fix`, `ctxlint_mcp_audit`, `ctxlint_session_audit`) accepted the full union of context/MCP/session check names — so a call like `ctxlint_audit` with `checks: ['mcp-schema']` would validate and then silently produce an empty result, because the audit path for that tool only scans context files. Each tool's schema now exposes only the check names for the domain it actually runs, so hosts (Claude Code, Cursor) can present valid options in their tool UI and invalid inputs fail at schema validation instead of silently dropping.
- **`session-scanner.ts` refuses to detect providers when `$HOME`/`%USERPROFILE%` are both unset.** In that pathological case, `join('', '.claude')` produced the relative path `.claude`, and `existsSync` would then match a project-local `.claude/` directory as if it were the user's global agent data. `detectProviders()` now returns `[]` when `home` is empty, which short-circuits every downstream reader (history, memories) because they're all gated on the matching provider being detected first.

## [0.9.12] — 2026-04-16

Follow-up to 0.9.11. One correctness fix carried over from the review that was deferred at release time.

### Fixed
- **`redundancy/duplicate-content` now uses true Jaccard similarity** (`|A ∩ B| / |A ∪ B|`) instead of `|A ∩ B| / max(|A|, |B|)`. The old metric inflated the score when one file was much smaller than the other — e.g. a 10-line AGENTS.md fully contained in a 200-line CLAUDE.md reported ~100% overlap when a user reading "content overlap" would expect ~5%. The user-facing percentage and the stored rule ID are unchanged; only the underlying computation moved. Threshold kept at 0.6 but flipped to `>=` so pairs landing exactly on the line still get flagged. Threshold and metric now documented inline.

## [0.9.11] — 2026-04-16

Second pre-1.0 review pass. Ten bug fixes across SARIF output, MCP tool hints, fixer correctness, init hook pinning, watch-mode cleanup, parser section bounds, tier-tokens settings error handling, pre-commit-framework hook pinning, plus doc corrections. No breaking changes.

### Fixed
- **SARIF now emits `logicalLocations` for synthetic cross-file buckets** instead of shoving labels like `(project)`, `(mcp)`, and `~/.claude/ (session audit)` into `physicalLocation.artifactLocation.uri`. GitHub Code Scanning interprets that URI as a repo-relative file path, so the old output either dropped cross-file findings or filed them against literal `(project)` paths. Real file paths continue to use `physicalLocation` unchanged.
- **`ctxlint_fix` MCP tool now advertises `destructiveHint: true`** (`src/mcp/server.ts`). The tool writes to disk via `applyFixes()` → `fs.writeFileSync`, so hosts need to know it's destructive when deciding whether to prompt the user for confirmation.
- **Fixer replaces every occurrence of `oldText` on a line**, not just the first. A directory rename landing on a line like ``"tests live in `src/old/a.ts` and `src/old/b.ts`"`` would previously leave the second reference dangling. Switched to `String.prototype.replaceAll`.
- **Pre-commit hooks written by `ctxlint init` now pin to the installed ctxlint version** (e.g. `npx @yawlabs/ctxlint@X.Y.Z --strict`). A bare `npx @yawlabs/ctxlint` would silently upgrade to `latest` when a repo got checked out months later, so the rule set a team agreed to enforce could drift under them. Re-run `ctxlint init` to bump the pin.
- **Watch mode closes `fs.watch` handles on `SIGINT`/`SIGTERM`** instead of relying on process exit to reap them, and clears the pending debounce timer first.
- **`.pre-commit-hooks.yaml` now pins `npx @yawlabs/ctxlint@X.Y.Z --strict`** to match the version pinning done by `ctxlint init`. The bare-`npx` entry resolved `latest` at commit time, so pre-commit-framework users could drift off the release their `rev:` pointed at. `release.sh` rewrites this file on each bump.
- **Parser `parseSections` closes non-final sections on the right line.** The previous `prev.endLine = i - 1` was one short of the intended 1-indexed inclusive convention (callers do `lines.slice(startLine - 1, endLine)`), so `tier-tokens.ts` section-breakdown token counts dropped the last content line of every non-final section. The test-fixture helper in `tier-tokens.test.ts` already encoded the correct convention, which made the divergence easy to confirm.
- **`tier-tokens.ts` surfaces malformed `.claude/settings.json` on stderr** instead of silently treating an unparseable settings file as "no hook enforcement configured". `loadSettingsSources` now distinguishes ENOENT (still silent — not every repo has one) from parse failures (warns with the underlying error).

### Docs
- `AGENT_SESSION_LINT_SPEC.md` prose now says "7 lint rules" (was "5") to match the catalog and `ALL_SESSION_CHECKS`.
- `MCP_CONFIG_LINT_SPEC.md` prose now says "43 lint rules" (was "27") — the 0.9.9 reconciliation missed this spot.
- `README.md` example output and pre-commit-framework `rev:` pin bumped off `v0.9.0`. Bundle-size blurb corrected from "~200 KB" to "~400 KB" — the actual tarball is 390 KB per `npm pack --dry-run` (unpacks to 2.1 MB; `dist/index.js` is 1.9 MB).
- `CLAUDE.md` end-of-session instruction clarified to exclude read-only tasks (reviews, explanations) so the assistant doesn't try to "commit and push" when there's nothing to commit.

## [0.9.10] — 2026-04-14

Staleness detector fix + pre-merge bench integration.

### Fixed
- **`staleness/stale` and `staleness/aging` silently never fired.** `getCommitsSinceBatch` in `src/utils/git.ts` ran `git log --format=___CTXLINT_COMMIT___`, which git rejects as an invalid pretty format ("fatal: invalid --pretty format: ___CTXLINT_COMMIT___"). The surrounding try/catch swallowed the error, every referenced path got a zero commit count, and the `totalCommits === 0` short-circuit in `checkStaleness` returned no issues. Fix: prefix the sentinel with `%n` so git accepts the format. Detected by [ctxlint-bench](https://github.com/YawLabs/ctxlint-bench) — the case was XFAIL'd against 0.9.9 and XPASSed against this build. (#2, #3)

### CI
- **Pre-merge effectiveness gate.** New `.github/workflows/bench.yml` runs the private ctxlint-bench corpus against every PR's freshly-built binary (not just post-release via cron). Fails the check on any F1 regression vs baseline. Requires a `BENCH_REPO_TOKEN` repo secret with read access to `YawLabs/ctxlint-bench`. (#4)

## [0.9.9] — 2026-04-13

Spec-hygiene pass + CI unblock. Docs-only and test-only changes; no runtime or API changes.

### Fixed
- **CI typecheck.** `src/utils/__tests__/tokens.test.ts` used `afterEach` without importing it. Vitest's auto-loaded globals hid the miss locally, but `tsc --noEmit` in CI caught it and v0.9.8's CI went red. Imported explicitly.

### Docs
- **Cross-reference mcp-compliance.** Added "Related specifications" section to `MCP_CONFIG_LINT_SPEC.md` positioning `mcp-config-lint` (static config linting) and `mcp-compliance` (runtime server testing) as complementary open specs in the Yaw Labs family. Both target MCP spec `2025-11-25`.
- **Rule count reconciled.** `MCP_CONFIG_LINT_SPEC.md` and `README.md` said "23 lint rules" but the catalog has had 43 for several versions. Prose updated in 4 places. Category count (8) unchanged.

## [0.9.8] — 2026-04-12

Test hygiene pass closing the low-priority items from the pre-1.0 audit. 41 new tests (377 → 418); one incidental parser fix surfaced while writing them.

### Fixed
- **Parser strips trailing sentence punctuation from path captures.** A path at the end of a sentence like `"See src/utils/fmt.ts."` was captured as `src/utils/fmt.ts.` (trailing period), because the greedy `[\w.*-]*` in `PATH_PATTERN` absorbed it. Now trimmed post-capture, while still requiring the result to contain a `/` so we don't mangle legitimate file paths.

### Tests
- **Fixer:** quiet-mode logging suppression, JSON-fix-rollback when the candidate change would produce invalid JSON.
- **Token thresholds:** invalid-order validation (info ≥ warning, warning ≥ error) falls back to defaults with a stderr warning.
- **Commands:** parameterized shorthand package-manager coverage — `yarn`, `bun`, `bun run`, `yarn run` forms all exercise `commands/script-not-found`.
- **Contradictions:** positive-case tests for the 5 previously-uncovered categories (semicolons, quote style, naming convention, CSS approach, state management). Also: 3+ file cluster dedup verified.
- **Scanner:** 12 parameterized tests covering every nested-dotdir pattern (`.claude/rules/`, `.clinerules/`, `.continue/rules/`, `.aiassistant/rules/`, `.junie/guidelines.md`, `.github/copilot-instructions.md`, etc.) so a future pattern list edit can't silently drop one.
- **mcp-parser:** error-branch coverage for root-JSON-array, root-scalar, and `mcpServers` as string / array.
- **Parser edge cases:** CRLF line endings (no `\r` leakage into captures), unicode path documentation-of-limitation, fenced code blocks without a language specifier, `~/` refs not captured by the context-file parser.
- **mcp-commands:** Windows-npx-no-wrapper rule now exercised on all platforms via `Object.defineProperty(process, 'platform', ...)` — positive case on win32+project-scope, negatives on linux, user-scope, and when command is already `cmd`.
- **session/stale-memory:** mixed existence — only the missing refs are flagged when a memory has some existing and some missing paths.

## [0.9.7] — 2026-04-12

Six performance and correctness fixes carrying forward the pre-1.0 audit queue. No breaking changes.

### Performance
- **Staleness check now batches git calls.** Previously `checkStaleness` spawned one `git log` subprocess per referenced path per file (30 refs × 50ms fork+exec on Windows = 1.5s per stale file). New `getCommitsSinceBatch` runs a single `git log --since=<date> --name-only` call and parses commit blocks to compute per-path counts. Cuts staleness time to ~constant per file regardless of ref count.
- **Scanner discovery now does one glob call per directory instead of 32.** The nested `for (dir) for (pattern)` loop became 32N filesystem scans. Passing all patterns as an array to a single `glob()` call per directory lets the library share the directory read. ~32× fewer filesystem operations on the discovery path.
- **Contradictions check now pre-indexes directives** by `(category, file, label)` instead of running `.find()` linear scans inside nested loops. Effectively O(F²·M²·D) → O(F²·M²) with much smaller constants.

### Fixed
- **Contradictions output now collapses N-way clusters.** Three files declaring npm / pnpm / yarn previously produced 3 separate "X vs Y" pair issues for what reads as one cluster disagreement. Now emits a single issue listing all conflicting (file, label) tuples when 3+ files disagree. 2-file pair conflicts unchanged.
- **`mcp-commands/args-path-missing` no longer false-positives on URL args.** Values like `https://api.example.com/openapi.json`, `s3://bucket/spec.json`, and `git://...` matched the file-path heuristic (`segment/segment.ext`), got resolved against the project root, and were warned as missing. Added a URL-prefix skip for `http(s)`, `file`, `s3`, `gs`, `ssh`, `git`.
- **Fixer now deduplicates identical fix actions.** When two checks proposed the same `(line, oldText, newText)` — e.g. git-rename detection and fuzzy-match both surfacing the same target — the second `line.replace()` was a silent no-op but `totalFixes` still incremented, over-counting. Dedupe on the triple before applying.

### Improved
- **Config errors point at the line and column** where JSON parsing failed (when Node's error format allows extraction). Unknown top-level keys in `.ctxlintrc` now produce a warning on stderr with a Levenshtein-based "did you mean" suggestion when the typo is close (e.g. `chekcs` → `checks`). Config-root-not-object (JSON array or scalar at root) now errors clearly instead of type-lying to downstream callers.

## [0.9.6] — 2026-04-12

Eight fixes from a pre-1.0 bug / perf / UX audit. All backward-compatible for CI / non-interactive use. Interactive TTY behavior of `--fix` changes (see below) — safer, but new.

### Fixed
- **Tiktoken (~5 MB WASM) no longer loads on every invocation.** Previously a top-level `await import('tiktoken')` was hoisted into CLI init, so every `--version` / `--help` paid the cost. Now lazy via `createRequire` on first `countTokens()` call. Every CI run saves hundreds of milliseconds and ~5 MB of memory.
- **SARIF rule descriptors out of sync with active checks.** `ctxlint/tier-tokens` and `ctxlint/session-memory-index-overflow` were missing from `buildRuleDescriptors()`, so GitHub Code Scanning dropped metadata for any issue using those rule IDs. Added both. A new self-validating test asserts descriptors ⊇ every check in `ALL_*CHECKS` so this can't drift again.
- **`session/stale-memory` flagged `~/` paths as broken.** Node's `isAbsolute('~/…')` returns false, so the check resolved tilde refs under the project root, didn't find them, and fired. Now expands `~` to `$HOME` / `%USERPROFILE%` before the existence check.
- **`session/missing-secret` false-positived on basename-substring siblings.** A sibling named `ctxlint-fork` would match a `ctxlint` current via `.includes()`, wrongly concluding "current already has the secret." Now uses normalized path equality + last-segment equality against gh `--repo owner/repo` flag values.
- **`mcp-consistency/duplicate-server-name` false-positived on servers named `env`/`args`/`command`.** The old regex counted every occurrence of `"<name>":` anywhere in the raw file, so a server named `env` matched every nested `"env":` block in other servers. Replaced with a depth-aware JSON scanner that only counts keys at the server-object depth.
- **Parser captured "Word/Word" prose as file paths.** "Biome/Prettier format TS" emitted a `paths/not-found` error for `Biome/Prettier`. Added exclusions for `/^\d+\/\d+$/` (numeric fractions like `10/12`, `3/5`) and `/^[A-Z]\w*\/[A-Z]\w*$/` without a file extension (capitalized tool-name pairs). Word-with-extension paths like `Config/settings.ts` still captured correctly.
- **`tier-tokens/hard-enforcement-missing` fired on cross-sentence framing.** "Run `npm test`. Do not commit with failing tests" flagged `npm test` as unenforced even though `Do not` was part of a different sentence. Regex now requires the inviolable word and the backticked command to be in the same sentence (no `.!?` between). Also tightened enforcement-check against hook/deny entries to word-boundary matching, so `rm` doesn't match `npm run rm-old-logs` and the command phrase is canonicalized before comparison.

### Changed
- **`--fix` now prompts for confirmation in an interactive TTY** unless `--yes` is passed. Previously `--fix` applied all changes immediately, which bit users when fuzzy-match picked a wrong target. Non-TTY (CI) behavior is unchanged — `--fix` still writes directly.
- **`--fix` now skips symlinked context files by default** to avoid silently writing through to the symlink target. Pass `--follow-symlinks` to opt back in.

### Added
- **`--fix-dry-run`** flag. Shows the diff (`Would fix …`) without modifying files. Works in any environment.
- **`--yes`** flag. Skips the new interactive confirmation when using `--fix`. Required when `--fix` is run in a TTY without prompting.
- **`--follow-symlinks`** flag. Allows `--fix` to write through symlinks (previously the implicit default, now opt-in).

### Notes
Despite adding three flags (per policy normally a minor bump), this release ships as patch because the flags are safety additions around an existing capability (`--fix`) that the audit identified as a foot-gun, and the other seven items are pure bug fixes. CI workflows using `--fix` remain unchanged since non-TTY environments apply fixes directly.

## [0.9.5] — 2026-04-12

### Removed
- **`commands/npm-auth-trap`** (shipped in v0.9.4) — retracted. The rule was based on a false premise: that npm write operations (`deprecate`, `unpublish`, `dist-tag`, `access`, `owner`) return 422 from the CLI under WebAuthn-only 2FA, forcing users to the npmjs.com settings UI. In reality, `npm login --auth-type=web` establishes a session that **does** satisfy 2FA-for-writes, and the subsequent write commands succeed. The rule was pushing users away from a working CLI path based on a theory not verified against observable evidence. Removing the rule is allowed without a major bump because it was flagged `stability: "experimental"` — its matching logic and existence are both subject to revision.

### Fixed
- **`paths/directory-not-found` now fires.** The parser's `PATH_PATTERN` required a non-empty final segment, which meant trailing-slash directory references like `src/components/` were never captured. The rule was shipping in the catalog but could not fire from real context files. Widened the final segment to allow zero characters, so directory references are now passed to the check.

### Added
- `CONTRIBUTING.md` — new "Writing a new check" section covering check-file structure, `audit.ts` wiring, catalog entries, tests, and the stability convention. Plus corrected the Development Workflow table (the repo uses `npm run format` + `npm run lint`, not `npm run lint:fix` which never existed).
- Test coverage raised to **92.97% lines** (was 91.38% in v0.9.3). Added targeted tests for SARIF reporter edges (severity mapping, detail append, empty case, line clamping, rule descriptors) and tiktoken encoder lifecycle paths (`keepEncoderAlive`, `forceFreeEncoder`).

### Notes on the retraction
This release is the result of a policy-over-evidence failure on the tooling side. A plausible-sounding but unverified theory about npm + WebAuthn was codified into a ctxlint rule without cross-checking against the user's actual shell history. When the user pointed out that the CLI path had succeeded twice the same day, the rule was retracted and the incident prompted explicit "check evidence before asserting" guidance in the project's own ops documentation. Rule `commands/npm-auth-trap` was live in v0.9.4 for ~2 hours; if you pinned to v0.9.4, upgrade to v0.9.5 or add the rule to your `ignore` list.

## [0.9.4] — 2026-04-12

### Added
- `commands/npm-auth-trap` rule (**experimental**) — flags context-file references to `npm deprecate`, `unpublish`, `dist-tag add/rm/set`, `access grant/revoke/2fa`, or `owner add/rm` as local CLI commands. Under WebAuthn-only 2FA (no TOTP authenticator), these return 422 because npm treats CLI web-auth tokens as not-2FA-authenticated for writes. The suggestion routes users to `npmjs.com/package/<pkg>/settings` or a CI-driven workflow. Severity `info`; opinionated because it only bites users whose 2FA config lacks a TOTP fallback.

### Changed
- Parser's bash-block command extraction now captures all `npm <subcommand>` forms, not just `npm run <script>`. Previously `npm deprecate`, `npm unpublish`, etc. were silently dropped from the reference set — a real undercapture bug that masked several check paths from being exercised at all.
- Versioning policy: experimental rules (`stability: "experimental"` in the rule catalog) bump **patch**, not minor. Their matching logic is expected to evolve; treating them as stable-surface additions forces premature minor bumps. Stable rules still bump minor on addition, per the original policy.

## [0.9.3] — 2026-04-12

Pre-1.0 hardening pass. No breaking changes; everything is additive or internal.

### Added
- `CHANGELOG.md` with retroactive release history from v0.1.
- Versioning policy documenting what counts as major / minor / patch for this project.
- `stability` field on every rule in the three JSON catalogs (`stable` by default; `experimental` on the three most heuristic rules — `tier-tokens/hard-enforcement-missing`, `session/consecutive-repeat`, `session/cyclic-pattern`). Experimental rules may tune their matching logic without a major bump.
- Every emitted `LintIssue` now populates `ruleId` — 27 previously-unspecified issue pushes across `paths`, `commands`, `tokens`, `staleness`, `redundancy`, `contradictions`, and `frontmatter` checks now carry their rule ID. Downstream consumers can filter / suppress by specific rule, not just check category.
- README: exit-codes table, complete `.ctxlintrc` config reference, memory-index-overflow entry in the session-checks table.
- Fixture + tests for empty-project behavior (no context files, no `.claude/`, no `package.json`) — ctxlint exits `0` cleanly in every mode.

### Changed
- Upgraded transitive deps to resolve 9 Dependabot alerts (vite → 8.0.8, hono → 4.12.12, @hono/node-server → 1.19.13 via pnpm overrides). All 9 were dev-only; the shipped bundle was not affected.

## [0.9.2] — 2026-04-12

### Added
- `tier-tokens` check reports tier-aware token accounting for always-loaded context files.
  - `tier-tokens/section-breakdown` — reports the heaviest top-level sections so bloat has a demotion target.
  - `tier-tokens/aggregate` — warns when combined always-loaded files exceed the budget across the project.
  - `tier-tokens/hard-enforcement-missing` — flags `NEVER`/`ALWAYS`/`DO NOT`/`MUST NOT` framing paired with a backticked command in always-loaded files when no matching `PreToolUse` hook or `permissions.deny` entry exists in `settings.json`.
- `session-memory-index-overflow` check — warns when `MEMORY.md` exceeds Claude Code's documented 200-line / 25KB session-load cap.
- `tokenThresholds.tierBreakdown` and `tokenThresholds.tierAggregate` config fields.

### Fixed
- `.claude/rules/*.md` files are now classified correctly: rules without `paths` frontmatter are always-loaded; rules with `paths` are on-demand (previously all rules files were treated as on-demand, undercounting the always-loaded budget).

## [0.9.1] — 2026-04-11

### Added
- Unit coverage for session checks.

### Changed
- CLI now validates `--format` and `--depth` option values; invalid values exit with code 2 and a clear error.
- Config file parse errors surface the exact error, not a generic fallback.
- Internal: MCP check enum DRY'd up to remove duplication.

## [0.9.0] — 2026-04-09

### Added
- `ci-coverage` check — flags release/deploy CI workflows that aren't referenced from any context file.
- `ci-secrets` check — flags CI secrets referenced in workflows but not documented in a context file.
- `session-loop-detection` check — flags consecutive-repeat and cyclic patterns in agent history (signal that the agent is stuck).

### Fixed
- 32 bug, UX, and performance fixes across the linter (covered in commit `745650c`).

## [0.8.0] — 2026-04-08

### Added
- `--watch` mode — re-lint on context-file / MCP-config / `package.json` changes.
- GitHub Action wrapper (`action.yml`) for one-line CI integration.

### Changed
- Zero-dependency bundle via esbuild — `dist/index.js` is now a single-file release with no runtime `node_modules` install needed.

## [0.7.0] — 2026-04-07

### Added
- Session linting — cross-project consistency checks using AI agent session data (`~/.claude/`, `~/.codex/`, etc.).
- Initial session check set: `session-missing-secret`, `session-diverged-file`, `session-missing-workflow`, `session-stale-memory`, `session-duplicate-memory`.

## [0.6.0] — 2026-04-07

### Added
- Release automation workflow.
- Public linting specifications and machine-readable rule catalogs (`context-lint-rules.json`, `mcp-config-lint-rules.json`, `agent-session-lint-rules.json`).

### Fixed
- `--mcp` flag collision resolved.
- Repo URL casing for npm provenance.

## [0.5.0] — 2026-04-07

### Added
- MCP config linting across all major AI clients (Claude Code, Claude Desktop, VS Code, Cursor, Windsurf, Cline, Amazon Q, Continue).
- MCP check set: `mcp-schema`, `mcp-security`, `mcp-commands`, `mcp-deprecated`, `mcp-env`, `mcp-urls`, `mcp-consistency`, `mcp-redundancy`.

## [0.4.0] — 2026-04-07

### Added
- `--mcp` flag to enable MCP config linting alongside context checks.
- Tool annotations surface in MCP server output.
- Per-file checks now run in parallel.

### Changed
- Node.js 20+ required (dropped Node 18 — vitest 4.x requires 20+).

## [0.3.0] — (pre-release iteration)

### Added
- Contradiction detection across multiple context files.
- Frontmatter validation for Cursor `.mdc`, Copilot `.instructions.md`, Windsurf `.windsurf/rules/*.md`.
- SARIF output format (`--format sarif`) for GitHub code-scanning integration.
- Expanded format coverage: AGENTS.md, GEMINI.md, `.clinerules`, `.aiderules`, `.continuerules`, `.rules`, `.goosehints`, `replit.md`, `.junie/guidelines.md`, and more.

## [0.2.0] — 2026-04-05

### Added
- `--fix` flag for auto-fixing broken paths (git rename detection + fuzzy matching).
- Config file support (`.ctxlintrc`, `.ctxlintrc.json`).
- `ctxlint init` command — installs a git pre-commit hook.
- `ctxlint_fix` MCP tool.
- bun / bunx support.

## [0.1.0] — 2026-04-05

Initial release.

### Added
- Context file checks: `paths`, `commands`, `staleness`, `tokens`, `redundancy`.
- Output formats: text, JSON.
- CLI: `--strict`, `--checks`, `--ignore`, `--verbose`, `--tokens`.
- MCP server mode (`--mcp-server`).

---

## Versioning policy

ctxlint follows Semantic Versioning. For this project, the semantics map as:

- **MAJOR** — breaking change to the public surface:
  - Rule ID removed, renamed, or moved to a different category.
  - CLI flag removed, renamed, or given incompatible semantics.
  - Config schema field removed, renamed, or given incompatible semantics.
  - JSON / SARIF output shape change that breaks downstream consumers.
  - Minimum Node.js version bumped.
- **MINOR** — additive or backward-compatible change:
  - New **stable** check or new **stable** rule ID.
  - New CLI flag or new config field.
  - New severity demotion (warning → info).
  - New output field in JSON / SARIF.
- **PATCH** — fixes and tuning:
  - False-positive fix or heuristic tuning.
  - Default threshold adjustment (unless it breaks existing CI).
  - Bug fix, performance improvement, documentation-only change.
  - Dependency upgrade that doesn't change behavior.
  - New **experimental** rule (`stability: "experimental"` in the catalog). Experimental rules may evolve their matching logic without a major bump, so adding one is closer to a fix than a stable-surface commitment.

The rule catalogs (`context-lint-rules.json`, `mcp-config-lint-rules.json`, `agent-session-lint-rules.json`) are the canonical public surface for rule IDs. A rule with `"stability": "experimental"` in the catalog may change without a major bump; rules default to `"stability": "stable"`.
