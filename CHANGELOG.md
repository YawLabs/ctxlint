# Changelog

All notable changes to `@yawlabs/ctxlint` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
See [Versioning policy](#versioning-policy) below.

## [Unreleased]

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
