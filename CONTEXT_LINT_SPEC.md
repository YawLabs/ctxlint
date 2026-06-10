# AI Context File Linting Specification

**Version:** 1.0.0-draft
**Date:** 2026-04-07
**Maintained by:** [Yaw Labs](https://yaw.sh) / [ctxlint](https://github.com/YawLabs/ctxlint)
**License:** CC BY 4.0

---

## What is this?

AI coding agents are guided by context files — markdown documents like `CLAUDE.md`, `.cursorrules`, and `AGENTS.md` that tell the agent how a project works. These files reference source paths, build commands, frameworks, and conventions. When the code changes and the context files don't, the agent follows stale instructions and fails.

This specification defines a standard set of lint rules for validating AI agent context files across all major AI coding clients. It is tool-agnostic: any linter, IDE extension, CI check, or AI agent can implement these rules.

The specification includes:
- A complete reference of context file formats across 16 AI coding clients (21+ file patterns)
- 39 lint rules organized into 12 categories with defined severities
- A machine-readable rule and format catalog ([`context-lint-rules.json`](./context-lint-rules.json))
- Auto-fix definitions for rules that support automated correction
- Frontmatter schema requirements per client

**Companion specification:** [MCP Server Configuration Linting Specification](./MCP_CONFIG_LINT_SPEC.md) — covers linting for MCP server config files (`.mcp.json`, etc.), the tool-configuration counterpart to instruction-based context files.

**Reference implementation:** [ctxlint](https://github.com/YawLabs/ctxlint) (v0.3.0+)

---

## Table of contents

- [1. Context File Landscape Reference](#1-context-file-landscape-reference)
  - [1.1 What are context files?](#11-what-are-context-files)
  - [1.2 Supported formats by client](#12-supported-formats-by-client)
  - [1.3 Scoping and precedence](#13-scoping-and-precedence)
  - [1.4 Frontmatter schemas](#14-frontmatter-schemas)
- [2. Content Extraction](#2-content-extraction)
  - [2.1 Path reference detection](#21-path-reference-detection)
  - [2.2 Command reference detection](#22-command-reference-detection)
  - [2.3 Token counting](#23-token-counting)
- [3. Lint Rules](#3-lint-rules)
  - [3.1 paths — file reference validation](#31-paths--file-reference-validation)
  - [3.2 commands — build/script validation](#32-commands--buildscript-validation)
  - [3.3 staleness — freshness detection](#33-staleness--freshness-detection)
  - [3.4 tokens — context window budget](#34-tokens--context-window-budget)
  - [3.5 tier-tokens — tier-aware token accounting](#35-tier-tokens--tier-aware-token-accounting)
  - [3.6 redundancy — inferable content](#36-redundancy--inferable-content)
  - [3.7 contradictions — cross-file conflicts](#37-contradictions--cross-file-conflicts)
  - [3.8 frontmatter — client metadata validation](#38-frontmatter--client-metadata-validation)
  - [3.9 ci-coverage — CI workflow documentation](#39-ci-coverage--ci-workflow-documentation)
  - [3.10 ci-secrets — CI secrets documentation](#310-ci-secrets--ci-secrets-documentation)
  - [3.11 hook-coverage — hook enforcement coverage](#311-hook-coverage--hook-enforcement-coverage)
  - [3.12 content-secrets — inline secret detection](#312-content-secrets--inline-secret-detection)
- [4. Rule Catalog (machine-readable)](#4-rule-catalog-machine-readable)
- [5. Implementing This Specification](#5-implementing-this-specification)
- [6. Contributing](#6-contributing)

---

## 1. Context File Landscape Reference

### 1.1 What are context files?

Context files are markdown documents placed in a project repository that provide instructions to AI coding agents. They typically contain:

- **Project structure** — what files are where, how the codebase is organized
- **Build and test commands** — how to run, build, and test the project
- **Conventions** — coding style, naming patterns, architectural decisions
- **Constraints** — what to avoid, what not to change, security requirements

Every major AI coding client reads one or more context file formats. Some clients support scoped rules (applied only when certain files are open), frontmatter-driven activation, and override hierarchies.

### 1.2 Supported formats by client

#### Claude Code

| File pattern | Scope | Notes |
|---|---|---|
| `CLAUDE.md` | Project root | Primary context file. Loaded automatically. |
| `CLAUDE.local.md` | Project root | Personal overrides. Not committed to git. |
| `.claude/rules/*.md` | Rule-based | Individual rule files loaded by Claude Code. |

**Hierarchy:** `CLAUDE.local.md` overrides `CLAUDE.md`. Rules in `.claude/rules/` are additive.

#### AAIF / Multi-agent standard

| File pattern | Scope | Notes |
|---|---|---|
| `AGENTS.md` | Project root | Linux Foundation AAIF standard. Recognized by multiple clients. |
| `AGENT.md` | Project root | Singular variant. |
| `AGENTS.override.md` | Project root | Override layer. |

#### Cursor

| File pattern | Scope | Notes |
|---|---|---|
| `.cursorrules` | Project root | Legacy format. Plain text, no frontmatter. |
| `.cursor/rules/*.md` | Rule-based | Markdown rules. No frontmatter required. |
| `.cursor/rules/*.mdc` | Rule-based | MDC format. Requires YAML frontmatter. |
| `.cursor/rules/*/RULE.md` | Rule-based | Nested rule directory pattern. |

**MDC frontmatter fields:** `description` (required), `globs` (file targeting), `alwaysApply` (boolean).

#### GitHub Copilot

| File pattern | Scope | Notes |
|---|---|---|
| `.github/copilot-instructions.md` | Project-wide | Main instructions file. |
| `.github/instructions/*.md` | Scoped | Per-topic instruction files. Support `applyTo` frontmatter. |
| `.github/git-commit-instructions.md` | Commit scope | Instructions specific to commit message generation. |

**Frontmatter fields:** `applyTo` (glob pattern targeting specific files).

#### Windsurf

| File pattern | Scope | Notes |
|---|---|---|
| `.windsurfrules` | Project root | Legacy format. Plain text. |
| `.windsurf/rules/*.md` | Rule-based | Markdown rules with frontmatter. |

**Frontmatter fields:** `trigger` (required, one of: `always_on`, `glob`, `manual`, `model`, `model_decision`).

#### Gemini CLI

| File pattern | Scope | Notes |
|---|---|---|
| `GEMINI.md` | Project root | Loaded automatically by Gemini CLI. |

#### Cline

| File pattern | Scope | Notes |
|---|---|---|
| `.clinerules` | Project root | Plain text context file. |

#### Aider

| File pattern | Scope | Notes |
|---|---|---|
| `.aiderules` | Project root | No file extension. Plain text. |

#### Aide / Codestory

| File pattern | Scope | Notes |
|---|---|---|
| `.aide/rules/*.md` | Rule-based | Markdown rules in a dedicated directory. |

#### Amazon Q Developer

| File pattern | Scope | Notes |
|---|---|---|
| `.amazonq/rules/*.md` | Rule-based | Markdown rules in a dedicated directory. |

#### Goose (Block)

| File pattern | Scope | Notes |
|---|---|---|
| `.goose/instructions.md` | Project-wide | Main instructions file. |
| `.goosehints` | Project root | Legacy hint file format. |

#### JetBrains Junie

| File pattern | Scope | Notes |
|---|---|---|
| `.junie/guidelines.md` | Project-wide | Main guidelines file. |
| `.junie/AGENTS.md` | Project-wide | AAIF-compatible agent instructions. |

#### JetBrains AI Assistant

| File pattern | Scope | Notes |
|---|---|---|
| `.aiassistant/rules/*.md` | Rule-based | Markdown rules. |

#### Continue

| File pattern | Scope | Notes |
|---|---|---|
| `.continuerules` | Project root | Legacy format. |
| `.continue/rules/*.md` | Rule-based | Markdown rules. |

#### Zed

| File pattern | Scope | Notes |
|---|---|---|
| `.rules` | Project root | Plain text. No extension. |

#### Replit

| File pattern | Scope | Notes |
|---|---|---|
| `replit.md` | Project root | Context for Replit's AI assistant. |

### 1.3 Scoping and precedence

Context files operate at different scopes depending on the client:

**Project-wide** — loaded for every conversation. Examples: `CLAUDE.md`, `.cursorrules`, `GEMINI.md`. The agent always sees these.

**Rule-based** — loaded individually based on rules or file patterns. Examples: `.cursor/rules/*.mdc` (loaded when `globs` match the active file), `.github/instructions/*.md` (loaded when `applyTo` matches).

**Override** — layers over the base context. Examples: `CLAUDE.local.md` overrides `CLAUDE.md`, `AGENTS.override.md` overrides `AGENTS.md`.

**Precedence (when applicable):**
- Personal/local overrides project-wide defaults
- More specific rules override less specific ones
- Multiple context files are typically concatenated (additive), not replaced

### 1.4 Frontmatter schemas

Some context file formats require or support YAML frontmatter (delimited by `---`). This metadata controls when and how the file is activated by the client.

#### Cursor `.mdc` files

```yaml
---
description: Brief description of when this rule applies
globs: "src/**/*.ts"
alwaysApply: false
---
```

| Field | Required | Type | Description |
|---|---|---|---|
| `description` | Yes | string | Tells Cursor when to apply this rule. |
| `globs` | No | string or string[] | File patterns that trigger this rule. e.g., `"src/**/*.ts"` or `["*.ts", "*.tsx"]` |
| `alwaysApply` | No | boolean | If `true`, rule is always active regardless of globs. |

If neither `globs` nor `alwaysApply` is set, the rule may not be applied automatically.

#### GitHub Copilot instruction files

```yaml
---
applyTo: "src/**/*.ts"
---
```

| Field | Required | Type | Description |
|---|---|---|---|
| `applyTo` | Recommended | string | Glob pattern specifying which files this instruction applies to. |

#### Windsurf rule files

```yaml
---
trigger: always_on
---
```

| Field | Required | Type | Description |
|---|---|---|---|
| `trigger` | Yes | enum | When the rule activates. One of: `always_on`, `glob`, `manual`, `model`, `model_decision`. |

---

## 2. Content Extraction

Before lint rules can run, implementors must extract structured references from context file content. This section defines what to extract and how.

### 2.1 Path reference detection

Context files reference source paths (e.g., `src/auth/middleware.ts`, `config/*.yaml`). Implementors should extract these for validation.

**What counts as a path reference:**
- Forward-slash-separated segments with at least one directory separator: `src/utils/helper.ts`
- Relative paths: `./scripts/build.sh`, `../shared/types.ts`
- Glob patterns: `src/**/*.test.ts`
- Directory references: `src/components/`

**What to exclude:**
- URLs: `https://example.com/path`
- Version patterns: `v2.0/api`
- Common abbreviations: `n/a`, `I/O`, `e.g.`, `w/o`
- Archive extensions: `.deb/`, `.rpm/`, `.tar/`, `.zip/`
- Code inside language-tagged code blocks (```js, ```python, etc.) — these are examples, not project references

**Track per reference:** the path string, line number, column, and parent section heading (if any).

### 2.2 Command reference detection

Context files reference build and test commands (e.g., `npm run build`, `make test`). Implementors should extract these for validation.

**What counts as a command reference:**
- Lines prefixed with `$` or `>` followed by a command: `$ npm test`
- Content inside bash/shell/sh/zsh code blocks (or code blocks with no language specified)
- Inline backtick commands matching common command patterns

**Common command patterns to recognize:**
- Package manager scripts: `npm run`, `pnpm`, `yarn`, `bun`
- Build tools: `make`, `cargo`, `go build`, `go test`
- Test runners: `vitest`, `jest`, `pytest`, `mocha`
- Other tools: `npx`, `python`, `tsc`, `eslint`, `prettier`, `deno`

**Track per reference:** the command string, line number, column, and parent section heading.

### 2.3 Token counting

Context files consume an agent's context window. Counting tokens helps teams understand and optimize their context budget.

**Recommended approach:** Use the `cl100k_base` tokenizer (GPT-4 family). If unavailable, estimate with a charset-aware fallback: count CJK codepoints (Han, Hiragana, Katakana, Hangul) at ~1 token each and everything else at ~4 characters per token — a flat characters/4 estimate undercounts CJK content by roughly 4x.

**Accuracy:** all counts are soft estimates. `cl100k_base` diverges from Claude's (unpublished) tokenizer by roughly 10-20% on prose and more on code- or whitespace-heavy content, and the character-based fallback is coarser still. Thresholds built on these counts ([Section 3.4](#34-tokens--context-window-budget) / [3.5](#35-tier-tokens--tier-aware-token-accounting)) should be treated as budget guidance with tolerance, not exact accounting.

**Track per file:** total token count and total line count.

---

## 3. Lint Rules

39 rules organized into 12 categories.

Severity levels:
- **error** — the context file has a verifiably incorrect reference or invalid metadata. Should fail CI.
- **warning** — the context file has a likely problem worth investigating. May fail CI in strict mode.
- **info** — the context file has a potential improvement. Never fails CI.

### 3.1 paths — file reference validation

Validates that file paths referenced in context files exist in the project.

| Rule ID | Severity | Trigger | Message |
|---|---|---|---|
| `paths/not-found` | error | Referenced file or directory does not exist at the specified path | `{path} does not exist` |
| `paths/glob-no-match` | error | Glob pattern matches zero files | `{pattern} matches no files` |
| `paths/directory-not-found` | error | Referenced directory (path ending with `/`) does not exist | `{path} directory does not exist` |

**Suggestions:** When a path doesn't exist, implementors should:
1. Check git history for recent renames of the file (e.g., last 10 commits). If found: `Did you mean {newPath}? (renamed {N} days ago)`
2. Use fuzzy matching (Levenshtein distance) against existing project files. Threshold: `max(pathLength * 0.4, 5)`. If a match is found: `Did you mean {closestMatch}?`

**Auto-fixable:** `paths/not-found` — when a suggestion is available (via git rename or fuzzy match), replace the broken path with the suggested correction.

### 3.2 commands — build/script validation

Validates that commands referenced in context files are actually available in the project.

| Rule ID | Severity | Trigger | Message |
|---|---|---|---|
| `commands/script-not-found` | error | `npm run`, `pnpm`, `yarn`, or `bun` script name is not in `package.json#scripts` | `"{cmd}" — script "{name}" not found in package.json` |
| `commands/make-target-not-found` | error | `make` target is not in Makefile | `"{cmd}" — target "{name}" not found in Makefile` |
| `commands/no-makefile` | error | `make` command used but no Makefile exists | `"{cmd}" — no Makefile found in project` |
| `commands/npx-not-in-deps` | warning | `npx` package is not in dependencies or `node_modules/.bin` | `"{cmd}" — "{pkg}" not found in dependencies` |
| `commands/tool-not-found` | warning | Common tool (`vitest`, `jest`, `eslint`, etc.) is not in dependencies or `node_modules/.bin` | `"{cmd}" — "{tool}" not found in dependencies or node_modules/.bin` |
| `commands/package-json-missing` | info | `package.json` is missing or unparseable AND the file references at least one command that would otherwise have been validated | `package.json missing or unparseable — command checks skipped` |

**Notes:**
- For `script-not-found`, include available scripts in the suggestion when possible.
- For `npx-not-in-deps`, suggest adding to `devDependencies`.
- Shorthand commands (`npm test`, `pnpm build`) should be validated against scripts as well.
- When `package.json` can't be loaded, all script/shorthand/npx/tool validation silently skips. Surface that once per file via `package-json-missing` so the skip isn't invisible.

### 3.3 staleness — freshness detection

Detects context files that haven't been updated while their referenced code has changed. Requires git.

| Rule ID | Severity | Trigger | Message |
|---|---|---|---|
| `staleness/stale` | warning | Context file not updated in 30+ days AND referenced paths have commits since last update | `Last updated {days} days ago. {path} has {N} commits since.` |
| `staleness/aging` | info | Context file not updated in 14-30 days AND referenced paths have commits | Same format as above |

**Algorithm:**
1. Get the context file's last modification date from git history
2. For each path referenced in the file, count commits to that path since the file's last update
3. If there are commits to referenced paths and the file is old enough, flag it

**Thresholds:**
- Skip entirely if file was updated within 14 days
- `info` at 14-30 days with referenced path activity
- `warning` at 30+ days with referenced path activity

**Suggestion:** `Review and update this context file to reflect recent changes.`

### 3.4 tokens — context window budget

Monitors context file size to help teams manage context window consumption.

| Rule ID | Severity | Trigger | Message |
|---|---|---|---|
| `tokens/excessive` | error | Single file uses 8000+ tokens | `{N} tokens — consumes significant context window space` |
| `tokens/large` | warning | Single file uses 3000-7999 tokens | `{N} tokens — large context file` |
| `tokens/info` | info | Single file uses 1000-2999 tokens | `Uses ~{N} tokens per session` |
| `tokens/aggregate` | warning | All context files combined use 5000+ tokens AND there are multiple files | `{count} context files consume {N} tokens combined` |

**Default thresholds (configurable):**

| Threshold | Default | Description |
|---|---|---|
| `info` | 1000 | Per-file informational |
| `warning` | 3000 | Per-file warning |
| `error` | 8000 | Per-file error |
| `aggregate` | 5000 | Cross-file combined warning |
| `tierBreakdown` | 1000 | Triggers `tier-tokens/section-breakdown` on an always-loaded file |
| `tierAggregate` | 4000 | Triggers `tier-tokens/aggregate` across always-loaded files |

**Suggestions:**
- For `excessive`: `Consider splitting into focused sections or removing redundant content.`
- For `large`: `Consider trimming — research shows diminishing returns past ~300 lines.`
- For `aggregate`: `Consider consolidating or trimming to reduce per-session context cost.`

### 3.5 tier-tokens — tier-aware token accounting

Reports token cost attributable to the **always-loaded** tier: files Claude Code (and similar agents) load into every session regardless of request. Complements `tokens` by surfacing which sections / files are costing budget every turn — and which inviolable rules need hook-based enforcement to actually bind.

"Always-loaded" basenames: `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `AGENTS.override.md`, `AGENT.md`, `GEMINI.md`, `.cursorrules`, `.windsurfrules`, `.clinerules`, `.aiderules`, `.continuerules`, `.rules`, `.goosehints`, `replit.md`, `.github/copilot-instructions.md`, `.junie/guidelines.md`, `.goose/instructions.md`. Rules files in `/rules/` directories are classified by frontmatter: if `paths:` is set they're path-scoped on-demand; otherwise they're always-loaded.

| Rule ID | Severity | Trigger | Message |
|---|---|---|---|
| `tier-tokens/section-breakdown` | info | Always-loaded file reaches or exceeds `tierBreakdown` tokens (inclusive — a file at exactly the threshold fires) AND has H1/H2 sections | `{N} tokens loaded every session — heaviest top-level section(s): ...` |
| `tier-tokens/aggregate` | warning | Two or more always-loaded files total `tierAggregate` tokens or more (inclusive boundary) | `{count} always-loaded files total {N} tokens — loaded every session` |
| `tier-tokens/hard-enforcement-missing` | info | Line in an always-loaded file uses inviolable framing (NEVER/ALWAYS/DO NOT/MUST NOT) with a backticked command, and no matching PreToolUse hook or `permissions.deny` entry exists in the project's `.claude/settings.json` / `.claude/settings.local.json` (the user-global `~/.claude/settings.json` is consulted only on explicit opt-in) | `Inviolable framing ("{line}") without a hook to back it up` |

**Note on overlap with `tokens`:** `tokens/info` and `tier-tokens/section-breakdown` both fire on a large CLAUDE.md. They're complementary — `tokens` is tier-agnostic ("this file is large"), `tier-tokens` adds the always-loaded attribution and demotion guidance. Use `--ignore tokens` or `--ignore tier-tokens` to pick one.

**Source:** [Claude Code memory docs](https://code.claude.com/docs/en/memory). Rule behavior is grounded in the documented loading model ("there's no guarantee of strict compliance" → hard-enforcement-missing; section-demotion-to-skills → structurally reduces per-session cost).

### 3.6 redundancy — inferable content

Detects content that the agent can already infer from project metadata, reducing unnecessary context window consumption.

| Rule ID | Severity | Trigger | Message |
|---|---|---|---|
| `redundancy/tech-mention` | info | Context file explicitly mentions a technology that is already in `package.json` dependencies | `"{tech}" is in package.json {depType} — agent can infer this` |
| `redundancy/discoverable-dir` | info | Context file describes the location of a directory that exists and is trivially discoverable | `Directory "{dir}" exists and is discoverable — agent can find this by listing files` |
| `redundancy/duplicate-content` | warning | Two context files have 60%+ content overlap (by line) | `{file1} and {file2} have {N}% content overlap` |

**Technology detection patterns:**

When a package is in `dependencies` or `devDependencies`, flag context that explicitly states the project uses it. Match phrases like:
- `"use {tech}"`, `"using {tech}"`, `"built with {tech}"`
- `"we use {tech}"`, `"This is a {tech} project"`
- `"{tech} project"`, `"{tech} application"`

**Known package-to-technology mappings (partial list):**

| Package | Technology names to flag |
|---|---|
| `react` | React |
| `next` | Next.js, NextJS |
| `express` | Express |
| `fastify` | Fastify |
| `typescript` | TypeScript |
| `vue` | Vue, Vue.js |
| `angular` | Angular |
| `svelte` | Svelte, SvelteKit |
| `tailwindcss` | Tailwind, TailwindCSS |
| `prisma` | Prisma |
| `drizzle-orm` | Drizzle |
| `jest` | Jest |
| `vitest` | Vitest |
| `vite` | Vite |
| `webpack` | Webpack |
| `eslint` | ESLint |
| `prettier` | Prettier |
| `graphql` | GraphQL |
| `pg`, `postgres` | PostgreSQL, Postgres |
| `mysql2` | MySQL |
| `sqlite3`, `better-sqlite3` | SQLite |
| `redis`, `ioredis` | Redis |
| `mongoose` | Mongoose |
| `zod` | Zod |
| `axios` | Axios |
| `playwright` | Playwright |
| `cypress` | Cypress |
| `storybook` | Storybook |

Implementations should maintain and extend this mapping as the ecosystem evolves.

**Suggestion for `tech-mention`:** `~{N} tokens could be saved` (estimate tokens on the matching line).

**Suggestion for `duplicate-content`:** `Consider consolidating into a single context file.`

### 3.7 contradictions — cross-file conflicts

Detects conflicting directives across multiple context files. This is a cross-file check.

| Rule ID | Severity | Trigger | Message |
|---|---|---|---|
| `contradictions/conflict` | warning | Two context files specify different, mutually exclusive options in the same category | `{category} conflict: "{optionA}" in {fileA} vs "{optionB}" in {fileB}` |

**Contradiction categories and their mutually exclusive options:**

#### Testing framework
| Option | Example directives |
|---|---|
| Jest | "use Jest", "Jest for testing", "test with Jest" |
| Vitest | "use Vitest", "Vitest for testing", "test with Vitest" |
| Mocha | "use Mocha", "Mocha for testing" |
| pytest | "use pytest", "pytest for testing" |
| Playwright | "use Playwright", "Playwright for e2e" |
| Cypress | "use Cypress", "Cypress for e2e" |

#### Package manager
| Option | Example directives |
|---|---|
| npm | "use npm", "npm as the package manager", "always use npm" |
| pnpm | "use pnpm", "pnpm as the package manager" |
| yarn | "use yarn", "yarn as the package manager" |
| bun | "use bun", "bun as the package manager" |

#### Indentation style
| Option | Example directives |
|---|---|
| tabs | "use tabs", "tab indentation", "indent with tabs" |
| 2 spaces | "2-space indent", "indent with 2 spaces" |
| 4 spaces | "4-space indent", "indent with 4 spaces" |

#### Semicolons
| Option | Example directives |
|---|---|
| semicolons | "use semicolons", "always semicolons" |
| no semicolons | "no semicolons", "avoid semicolons", "omit semicolons" |

#### Quote style
| Option | Example directives |
|---|---|
| single quotes | "single quotes", "prefer single quotes" |
| double quotes | "double quotes", "prefer double quotes" |

#### Naming convention
| Option | Example directives |
|---|---|
| camelCase | "camelCase", "camel case for naming" |
| snake_case | "snake_case", "snake case for naming" |
| PascalCase | "PascalCase", "pascal case for naming" |
| kebab-case | "kebab-case", "kebab case for naming" |

#### CSS approach
| Option | Example directives |
|---|---|
| Tailwind | "use Tailwind", "Tailwind for styling" |
| CSS Modules | "use CSS Modules", "CSS Modules for styling" |
| styled-components | "use styled-components" |
| CSS-in-JS | "use CSS-in-JS" |

#### State management
| Option | Example directives |
|---|---|
| Redux | "use Redux", "Redux for state" |
| Zustand | "use Zustand", "Zustand for state" |
| MobX | "use MobX", "MobX for state" |
| Jotai | "use Jotai", "Jotai for state" |
| Recoil | "use Recoil", "Recoil for state" |

**Notes:**
- Only flag contradictions *across* files. A single file contradicting itself is unusual and likely intentional (e.g., "use camelCase for variables, PascalCase for components").
- Include the exact line numbers and text from both files in the detail.

### 3.8 frontmatter — client metadata validation

Validates YAML frontmatter required by specific clients. Only applies to file formats that use frontmatter.

| Rule ID | Severity | Trigger | Message |
|---|---|---|---|
| `frontmatter/missing` | warning (Cursor `.mdc`); info (Copilot, Windsurf) | File format requires or recommends frontmatter but none is present | `{format} file is missing frontmatter` |
| `frontmatter/unclosed` | error | Frontmatter opens with `---` but is never closed (every parsed field is suspect; the host loads the file with no frontmatter at all) | ``Frontmatter opens with `---` but is never closed`` |
| `frontmatter/missing-field` | warning | A required or recommended field is absent | `Missing "{field}" field in {format} frontmatter` |
| `frontmatter/invalid-value` | error (invalid `alwaysApply` / Windsurf `trigger`); warning (malformed `globs`) | A field has an invalid value | `Invalid {field} value: "{value}"` |
| `frontmatter/no-activation` | info | File has frontmatter but no activation mechanism (no globs/alwaysApply/trigger) | `No activation field — rule may not be applied automatically` |

**Validation per format:**

| File type | Validated fields | Valid values |
|---|---|---|
| Cursor `.mdc` | `description` (required), `alwaysApply` (boolean), `globs` (pattern) | `alwaysApply`: `true` or `false` |
| Copilot `instructions/*.md` | `applyTo` (recommended) | Any glob pattern |
| Windsurf `rules/*.md` | `trigger` (required) | `always_on`, `glob`, `manual`, `model`, `model_decision` |

**Notes:**
- `frontmatter/missing` severity is per-format: warning for Cursor `.mdc` (frontmatter is required there), info for Copilot instructions and Windsurf rules (frontmatter is optional/recommended).
- The `globs` branch of `frontmatter/invalid-value` only flags unmistakably malformed YAML (unbalanced brackets or quotes), at warning severity — Cursor accepts bare directory names (`globs: src`) and bare extensions, so a value isn't flagged merely for lacking `*` or `/`.

---

### 3.9 ci-coverage — CI workflow documentation

Checks that release/deploy CI workflows are documented in context files. When agents encounter a project with CI release workflows but no documentation about how releases work, they guess — often incorrectly.

| Rule ID | Severity | Trigger | Message |
|---|---|---|---|
| `ci/no-release-docs` | info | `.github/workflows/` contains release/deploy/publish workflow(s) but no context file mentions the release process | `Release workflow(s) found but no context file documents the release process` |

> **Rule-ID note:** `ci/no-release-docs` is the published catalog ID — a legacy shared `ci/` prefix that predates the prefix-equals-category convention (see CONTRIBUTING.md "Rule ID format"). The reference implementation emits this finding with ruleId `ci-coverage/no-release-docs` in JSON output.

**Detection algorithm:**

1. Check if `.github/workflows/` exists. If not, skip.
2. Scan workflow filenames for release-related patterns: `release`, `deploy`, `publish`, `cd`.
3. For workflows not matched by filename, read the YAML `name:` field and check for the same patterns.
4. If no release-related workflows exist, skip (only CI/test workflows — no documentation gap).
5. Search all context file content for release documentation phrases (e.g., "release process", "push a v* tag", "npm publish", "deploy to").
6. If no context file mentions release processes, emit one info-level issue.

---

### 3.10 ci-secrets — CI secrets documentation

Checks that secrets referenced in CI workflow files are mentioned in context files. Undocumented secrets are a common source of agent looping — agents try to create new tokens, pull from `.npmrc`, or guess at auth setup.

| Rule ID | Severity | Trigger | Message |
|---|---|---|---|
| `ci/undocumented-secret` | info | `${{ secrets.NAME }}` found in workflow YAML but `NAME` not mentioned in any context file | `CI secret "{name}" is used in {workflow} but not mentioned in any context file` |

> **Rule-ID note:** `ci/undocumented-secret` is the published catalog ID — the same legacy shared `ci/` prefix as `ci/no-release-docs`. The reference implementation emits this finding with ruleId `ci-secrets/undocumented-secret` in JSON output.

**Detection algorithm:**

1. Check if `.github/workflows/` exists. If not, skip.
2. Read all `.yml`/`.yaml` files and extract `${{ secrets.NAME }}` references via regex.
3. Exclude GitHub-provided secrets: `GITHUB_TOKEN`, `ACTIONS_RUNTIME_TOKEN`, `ACTIONS_RUNTIME_URL`, `ACTIONS_CACHE_URL`, `ACTIONS_ID_TOKEN_REQUEST_TOKEN`, `ACTIONS_ID_TOKEN_REQUEST_URL`, `ACTIONS_RESULTS_URL`.
4. For each remaining secret, search all context files for the secret name (case-insensitive, flexible underscore/space matching).
5. Emit one info-level issue per undocumented secret.

### 3.11 hook-coverage — hook enforcement coverage

The inverse of `tier-tokens/hard-enforcement-missing`. Where `tier-tokens` flags an inviolable rule that has *no* hook to enforce it, `hook-coverage` flags a hook (or permissions entry) that points at a script which no longer exists — a dead gate that silently no-ops. Claude Code cannot run a script that isn't on disk, so a `PreToolUse` hook whose `command` references a deleted/renamed file stops blocking anything, while the user still believes the protection is in place.

| Rule ID | Severity | Trigger | Message |
|---|---|---|---|
| `hook-coverage/dead-hook` | warning | A `hooks.<Event>[].hooks[].command` or `permissions.{allow,deny,ask}[]` entry in `.claude/settings.json` contains a path-shaped token that does not exist on disk | `{origin} references "{path}" which does not exist on disk — the gate silently no-ops` |

**Detection algorithm:**

1. Load settings from project `.claude/settings.json` and project `.claude/settings.local.json` (parsed as JSONC; missing files are skipped). The user-global `~/.claude/settings.json` is loaded only on explicit opt-in (`--hooks-global` in the reference implementation) so a default run never reads files outside the project directory.
2. For each hook command and each `permissions` list entry, tokenize on whitespace (respecting quotes) and keep tokens that look like script paths (a path separator + a script extension such as `.sh`/`.js`/`.py`/`.ps1`, or an explicit `./` `~/` `/` `$VAR/` `C:\` prefix). Inline tool matchers like `Bash(npm login)` yield no path tokens.
3. Resolve each path token: expand a leading `~` and the env vars Claude Code documents for settings paths — `$CLAUDE_PROJECT_DIR`, `$CLAUDE_CONFIG_DIR`, `$HOME`, `$USERPROFILE`. A token that still contains an unresolvable `$VAR` is skipped (it cannot be verified, and a false "dead hook" is worse than a missed one).
4. Emit one warning per resolved path that does not exist on disk, with the source file's line number for project files (the user-global file is noted inline).

**Stability:** experimental — the path-extraction heuristic is conservative by design (it prefers a missed dead hook over a false positive) and may broaden as more hook-command shapes are observed.

### 3.12 content-secrets — inline secret detection

Detects secrets pasted directly into context files. Context files usually end up committed to git, so an inline `AKIA...` or `sk-ant-...` in a heading or code block is a leak. This is the context-file counterpart of the MCP-config secret rules (`mcp-security/*` in the [MCP Config Linting Spec](./MCP_CONFIG_LINT_SPEC.md)) — same threat, different paste surface.

| Rule ID | Severity | Trigger | Message |
|---|---|---|---|
| `content-secrets/private-key-header` | error | Line contains `-----BEGIN [RSA \| EC \| DSA \| OPENSSH \| PGP ]PRIVATE KEY-----` | `Private key header detected in {file}` |
| `content-secrets/aws-access-key` | error | `AKIA` or `ASIA` (STS) prefix + 16 uppercase alphanumeric chars | `AWS access key detected in {file} ({prefix}...)` |
| `content-secrets/github-pat` | error | `ghp_`, `github_pat_`, or `ghs_`/`gho_`/`ghu_`/`ghr_` token shapes | `GitHub personal access token detected in {file} ({prefix}...)` |
| `content-secrets/anthropic-key` | error | `sk-ant-` + 20+ key chars | `Anthropic API key detected in {file} ({prefix}...)` |
| `content-secrets/openai-key` | error | `sk-` or `sk-proj-` + 20+ key chars | `OpenAI API key detected in {file} ({prefix}...)` |
| `content-secrets/npm-token` | error | `npm_` + 36+ alphanumeric chars | `npm token detected in {file} ({prefix}...)` |
| `content-secrets/slack-token` | error | `xox[bpoasr]-` + 10+ token chars | `Slack token detected in {file} ({prefix}...)` |
| `content-secrets/google-api-key` | error | `AIza` + exactly 35 key chars | `Google API key detected in {file} ({prefix}...)` |
| `content-secrets/stripe-secret` | error | `sk_live_` + 24+ alphanumeric chars | `Stripe live secret key detected in {file} ({prefix}...)` |

**Design principles:**

- **Precision over recall.** Patterns are well-defined vendor prefixes only; random high-entropy detection is deliberately omitted — it bites build IDs, commit SHAs, and version strings. A missed exotic format is fine; a noisy false positive that trains users to ignore the check is not.
- **Never leak the secret in output.** Emitted messages contain at most a 6-character redacted prefix plus an ellipsis — never the full matched value (the value landing in linter stderr/SARIF would itself be a leak vector).
- **Anthropic before OpenAI.** `sk-ant-` must be checked before the generic `sk-` pattern so the same substring isn't flagged twice (implementations may use per-line dedup keyed by match offset).

**Suppression rules (all reduce false positives):**

1. **Placeholder lines** — any line containing a placeholder token (`example`, `placeholder`, `your-key`, `<replace`, `redacted`, `xxxx`, `****`) is skipped entirely (line-scoped on purpose; see the implementation notes in `content-secrets.ts` for the recall trade-off).
2. **Placeholder wrappers** — a match wrapped in `${...}` or a hugging `<...>` placeholder is skipped.
3. **Commented examples** — a comment line (`#`, `//`, `--`, `<!--`) containing `fake` or `example` is skipped.
4. **Illustrative code fences** — content inside fences explicitly tagged `text`, `txt`, `example`, `pseudocode`, or `none` is skipped. Untagged fences are still scanned: a bare ``` fence is the most common way real `.env` contents get pasted into a context file.

**Suggestion:** `Move the secret to a .env or secret manager and reference it by name. If this token is real, rotate it immediately.`

**Stability:** experimental — the suppression heuristics (placeholder tokens, fence tags) may broaden as more paste shapes are observed; the vendor prefix patterns themselves are stable.

---

## 4. Rule Catalog (machine-readable)

A machine-readable JSON catalog of all rules and supported context file formats is available at [`context-lint-rules.json`](./context-lint-rules.json).

The catalog enables:
- AI agents to understand what context files exist in a project and what rules apply
- Tool authors to import rule definitions and format definitions programmatically
- CI systems to configure which rules to enable/disable
- Documentation generators to stay in sync with the rule set

See the JSON file for the full schema.

---

## 5. Implementing This Specification

### Discovery

Scan the project root (and optionally subdirectories up to a configurable depth) for the file patterns listed in [Section 1.2](#12-supported-formats-by-client). Skip `node_modules`, `.git`, `dist`, `build`, and `vendor` directories.

Support custom additional patterns via configuration for project-specific files (e.g., `CONVENTIONS.md`).

### Parsing

For each discovered file:
1. Read the file content
2. Parse markdown headings into a section tree
3. Extract path references and command references (see [Section 2](#2-content-extraction))
4. Count tokens
5. Parse frontmatter if the format requires it

### Checking

Run per-file checks (paths, commands, staleness, tokens, tier-tokens, redundancy, frontmatter, content-secrets) independently per file. These can be parallelized.

Run cross-file checks (aggregate tokens, duplicate content, contradictions, ci-coverage, ci-secrets, hook-coverage) after all per-file parsing is complete. These need the full set of parsed files.

### Reporting

Rules use the `category/rule-id` naming convention (e.g., `paths/not-found`, `contradictions/conflict`). For SARIF output, map to rule IDs as `ctxlint/paths`, `ctxlint/commands`, etc.

Severity mapping for SARIF: `error` → `error`, `warning` → `warning`, `info` → `note`.

### Fixing

The only auto-fixable rule category is `paths/not-found` (when a suggestion is available). Apply surgical string replacements on the affected line without reformatting the rest of the file.

---

## 6. Contributing

This specification is maintained at [github.com/YawLabs/ctxlint](https://github.com/YawLabs/ctxlint).

To propose changes:
- **New rules:** Open an issue describing the rule, its severity, trigger condition, and rationale.
- **New context file formats:** As new AI clients emerge, submit a PR adding their file patterns, scoping behavior, and any frontmatter requirements to Section 1.
- **New contradiction categories:** Submit a PR with the category name, mutually exclusive options, and example directives.
- **Corrections:** Open an issue with evidence (client docs, source code, or reproduction).

### Versioning

This specification follows semver:
- **Patch** (1.0.x): Typo fixes, clarifications, no rule changes
- **Minor** (1.x.0): New rules, new formats, new contradiction categories
- **Major** (x.0.0): Rules removed or semantics changed in breaking ways

### Related specifications and tools

- [AAIF AGENTS.md](https://github.com/anthropics/agents-spec) — Linux Foundation standard for multi-agent context files
- [Model Context Protocol Specification](https://spec.modelcontextprotocol.io/) — the protocol that MCP server configs serve
- [MCP Server Configuration Linting Specification](./MCP_CONFIG_LINT_SPEC.md) — companion spec for linting MCP server configs
- [ctxlint](https://github.com/YawLabs/ctxlint) — reference implementation of all four specifications
- [mcp-compliance](https://github.com/YawLabs/mcp-compliance) — tests MCP server behavior against the protocol spec
