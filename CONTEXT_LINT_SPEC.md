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
- A complete reference of context file formats across 17 AI coding clients (21+ file patterns)
- 21 lint rules organized into 9 categories with defined severities
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
  - [3.5 redundancy — inferable content](#35-redundancy--inferable-content)
  - [3.6 contradictions — cross-file conflicts](#36-contradictions--cross-file-conflicts)
  - [3.7 frontmatter — client metadata validation](#37-frontmatter--client-metadata-validation)
  - [3.8 ci-coverage — CI workflow documentation](#38-ci-coverage--ci-workflow-documentation)
  - [3.9 ci-secrets — CI secrets documentation](#39-ci-secrets--ci-secrets-documentation)
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

**Frontmatter fields:** `trigger` (required, one of: `always_on`, `glob`, `manual`, `model`).

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
| `trigger` | Yes | enum | When the rule activates. One of: `always_on`, `glob`, `manual`, `model`. |

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

**Recommended approach:** Use the `cl100k_base` tokenizer (GPT-4 family). If unavailable, estimate at ~4 characters per token.

**Track per file:** total token count and total line count.

---

## 3. Lint Rules

21 rules organized into 9 categories.

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

**Notes:**
- For `script-not-found`, include available scripts in the suggestion when possible.
- For `npx-not-in-deps`, suggest adding to `devDependencies`.
- Shorthand commands (`npm test`, `pnpm build`) should be validated against scripts as well.

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

### 3.5 tier-tokens — tier-aware token accounting

Reports token cost attributable to the **always-loaded** tier: files Claude Code (and similar agents) load into every session regardless of request. Complements `tokens` by surfacing which sections / files are costing budget every turn — and which inviolable rules need hook-based enforcement to actually bind.

"Always-loaded" basenames: `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `AGENTS.override.md`, `AGENT.md`, `GEMINI.md`, `.cursorrules`, `.windsurfrules`, `.clinerules`, `.aiderules`, `.continuerules`, `.rules`, `.goosehints`, `replit.md`, `.github/copilot-instructions.md`, `.junie/guidelines.md`, `.goose/instructions.md`. Rules files in `/rules/` directories are classified by frontmatter: if `paths:` is set they're path-scoped on-demand; otherwise they're always-loaded.

| Rule ID | Severity | Trigger | Message |
|---|---|---|---|
| `tier-tokens/section-breakdown` | info | Always-loaded file exceeds `tierBreakdown` tokens AND has H1/H2 sections | `{N} tokens loaded every session — heaviest top-level section(s): ...` |
| `tier-tokens/aggregate` | warning | Two or more always-loaded files combined exceed `tierAggregate` tokens | `{count} always-loaded files total {N} tokens — loaded every session` |
| `tier-tokens/hard-enforcement-missing` | info | Line in an always-loaded file uses inviolable framing (NEVER/ALWAYS/DO NOT/MUST NOT) with a backticked command, and no matching PreToolUse hook or `permissions.deny` entry exists in `.claude/settings.json` or `~/.claude/settings.json` | `Inviolable framing ("{line}") without a hook to back it up` |

**Note on overlap with `tokens`:** `tokens/info` and `tier-tokens/section-breakdown` both fire on a large CLAUDE.md. They're complementary — `tokens` is tier-agnostic ("this file is large"), `tier-tokens` adds the always-loaded attribution and demotion guidance. Use `--ignore tokens` or `--ignore tier-tokens` to pick one.

**Source:** [Claude Code memory docs](https://code.claude.com/docs/en/memory). Rule behavior is grounded in the documented loading model ("there's no guarantee of strict compliance" → hard-enforcement-missing; section-demotion-to-skills → structurally reduces per-session cost).

**Suggestions:**
- For `excessive`: `Consider splitting into focused sections or removing redundant content.`
- For `large`: `Consider trimming — research shows diminishing returns past ~300 lines.`
- For `aggregate`: `Consider consolidating or trimming to reduce per-session context cost.`

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
| `frontmatter/missing` | warning | File format requires frontmatter but none is present | `{format} file is missing frontmatter` |
| `frontmatter/missing-field` | warning | A required or recommended field is absent | `Missing "{field}" field in {format} frontmatter` |
| `frontmatter/invalid-value` | error | A field has an invalid value | `Invalid {field} value: "{value}"` |
| `frontmatter/no-activation` | info | File has frontmatter but no activation mechanism (no globs/alwaysApply/trigger) | `No activation field — rule may not be applied automatically` |

**Validation per format:**

| File type | Validated fields | Valid values |
|---|---|---|
| Cursor `.mdc` | `description` (required), `alwaysApply` (boolean), `globs` (pattern) | `alwaysApply`: `true` or `false` |
| Copilot `instructions/*.md` | `applyTo` (recommended) | Any glob pattern |
| Windsurf `rules/*.md` | `trigger` (required) | `always_on`, `glob`, `manual`, `model` |

---

### 3.9 ci-coverage — CI workflow documentation

Checks that release/deploy CI workflows are documented in context files. When agents encounter a project with CI release workflows but no documentation about how releases work, they guess — often incorrectly.

| Rule ID | Severity | Trigger | Message |
|---|---|---|---|
| `ci/no-release-docs` | info | `.github/workflows/` contains release/deploy/publish workflow(s) but no context file mentions the release process | `Release workflow(s) found but no context file documents the release process` |

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

**Detection algorithm:**

1. Check if `.github/workflows/` exists. If not, skip.
2. Read all `.yml`/`.yaml` files and extract `${{ secrets.NAME }}` references via regex.
3. Exclude GitHub-provided secrets: `GITHUB_TOKEN`, `ACTIONS_RUNTIME_TOKEN`, `ACTIONS_RUNTIME_URL`, `ACTIONS_CACHE_URL`, `ACTIONS_ID_TOKEN_REQUEST_TOKEN`, `ACTIONS_ID_TOKEN_REQUEST_URL`, `ACTIONS_RESULTS_URL`.
4. For each remaining secret, search all context files for the secret name (case-insensitive, flexible underscore/space matching).
5. Emit one info-level issue per undocumented secret.

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

Run per-file checks (paths, commands, staleness, tokens, redundancy, frontmatter) independently per file. These can be parallelized.

Run cross-file checks (aggregate tokens, duplicate content, contradictions, ci-coverage, ci-secrets) after all per-file parsing is complete. These need the full set of parsed files.

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
- [ctxlint](https://github.com/YawLabs/ctxlint) — reference implementation of both specifications
- [mcp-compliance](https://github.com/YawLabs/mcp-compliance) — tests MCP server behavior against the protocol spec
- [mcp.hosting](https://mcp.hosting) — managed MCP server hosting
