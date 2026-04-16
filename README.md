# ctxlint

[![npm version](https://img.shields.io/npm/v/@yawlabs/ctxlint)](https://www.npmjs.com/package/@yawlabs/ctxlint)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/YawLabs/ctxlint)](https://github.com/YawLabs/ctxlint/stargazers)
[![CI](https://github.com/YawLabs/ctxlint/actions/workflows/ci.yml/badge.svg)](https://github.com/YawLabs/ctxlint/actions/workflows/ci.yml)
[![Release](https://github.com/YawLabs/ctxlint/actions/workflows/release.yml/badge.svg)](https://github.com/YawLabs/ctxlint/actions/workflows/release.yml)

**Lint your AI agent context files, MCP server configs, and session data against your actual codebase.** Context linting + MCP config linting + session auditing. 21+ context formats, 8 MCP clients, cross-project consistency, auto-fix. Works as a CLI, CI step, pre-commit hook, or MCP server.

Your `CLAUDE.md` is lying to your agent. Your `.mcp.json` has a hardcoded API key. ctxlint catches both.

## Why ctxlint?

Every AI coding tool ships a context file: `CLAUDE.md`, `.cursorrules`, `AGENTS.md`, `.mcp.json`. These files are the single most important interface between you and your agent — they tell it what to build, how to test, where things live.

But context files rot fast. You rename a file, change a build script, or switch from Jest to Vitest — and your `CLAUDE.md` still says the old thing. Your agent follows those stale instructions faithfully, then fails. You lose 10 minutes debugging what turns out to be a wrong path in line 12 of a markdown file.

Multiply that across a team with 5 context files, 3 MCP configs, and 2 people who touched the build system last week — and you have a real problem with no existing solution.

ctxlint is a linter purpose-built for this. It reads your context files, cross-references them against your actual codebase, and catches the drift before your agent does.

- **Instant startup** — ships as a single self-contained bundle with zero runtime dependencies. `npx` downloads a ~400 KB tarball and starts immediately
- **Catches real problems** — broken paths, wrong commands, stale references, contradictions across files
- **Smart suggestions** — detects git renames and fuzzy-matches to suggest the right path
- **Auto-fix** — `--fix` rewrites broken paths automatically using git history
- **Token-aware** — shows how much context window your files consume and flags redundant content
- **Every AI tool** — supports Claude Code, Cursor, Copilot, Windsurf, Gemini, Cline, Aider, and 14 more
- **Multiple outputs** — text, JSON, and SARIF (GitHub Code Scanning)
- **MCP server** — 6 tools for IDE/agent integration with tool annotations for auto-approval
- **Watch mode** — `--watch` re-lints automatically when context files change

## Install

Run directly (no install needed):

```bash
npx @yawlabs/ctxlint
```

### Project install (recommended for teams)

```bash
npm install -D @yawlabs/ctxlint
# or
pnpm add -D @yawlabs/ctxlint
```

Then add to your `package.json` scripts:

```json
{
  "scripts": {
    "lint:ctx": "ctxlint --strict"
  }
}
```

### Global install

```bash
npm install -g @yawlabs/ctxlint
```

Useful if you want `ctxlint` available in every project without per-project setup.

## What It Checks

| Check                 | What it finds                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------- |
| **Broken paths**      | File references in context that don't exist in your project                                   |
| **Wrong commands**    | Build/test commands that don't match your package.json scripts or Makefile targets            |
| **Stale context**     | Context files not updated after recent code changes                                           |
| **Token waste**       | How much context window your files consume per session                                        |
| **Redundancy**        | Content the agent can already infer (e.g. "We use React" when react is in package.json)       |
| **Contradictions**    | Conflicting directives across context files (e.g. "use Jest" in one, "use Vitest" in another) |
| **Frontmatter**       | Invalid or missing YAML frontmatter in Cursor .mdc, Copilot instructions, and Windsurf rules  |
| **CI coverage**       | Release/deploy workflows in `.github/workflows/` not documented in any context file           |
| **CI secrets**        | Secrets used in CI workflows (`${{ secrets.X }}`) not mentioned in context files              |
| **Missing secrets**   | GitHub secrets set on sibling repos but missing from current project                          |
| **Diverged configs**  | Canonical config files (CI, tsconfig, etc.) drifting across sibling projects                  |
| **Missing workflows** | GitHub Actions workflows present in 2+ siblings but absent here                               |
| **Stale memory**      | Claude Code memory entries referencing paths that no longer exist                             |
| **Duplicate memory**  | Near-duplicate memories across projects (>60% content overlap)                                |
| **Loop detection**    | Agent stuck in loops — repeated commands or cyclic patterns in session history                |

## Supported Context Files

| File                                                                                                 | Tool                        |
| ---------------------------------------------------------------------------------------------------- | --------------------------- |
| `CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules/*.md`                                                 | Claude Code                 |
| `AGENTS.md`, `AGENT.md`, `AGENTS.override.md`                                                        | AAIF / Multi-agent standard |
| `.cursorrules`, `.cursor/rules/*.md`, `.cursor/rules/*.mdc`, `.cursor/rules/*/RULE.md`               | Cursor                      |
| `.github/copilot-instructions.md`, `.github/instructions/*.md`, `.github/git-commit-instructions.md` | GitHub Copilot              |
| `.windsurfrules`, `.windsurf/rules/*.md`                                                             | Windsurf                    |
| `GEMINI.md`                                                                                          | Gemini CLI                  |
| `.clinerules`                                                                                        | Cline                       |
| `.aiderules`                                                                                         | Aider                       |
| `.aide/rules/*.md`                                                                                   | Aide / Codestory            |
| `.amazonq/rules/*.md`                                                                                | Amazon Q Developer          |
| `.goose/instructions.md`, `.goosehints`                                                              | Goose by Block              |
| `.junie/guidelines.md`, `.junie/AGENTS.md`                                                           | JetBrains Junie             |
| `.aiassistant/rules/*.md`                                                                            | JetBrains AI Assistant      |
| `.continuerules`, `.continue/rules/*.md`                                                             | Continue                    |
| `.rules`                                                                                             | Zed                         |
| `replit.md`                                                                                          | Replit                      |

## MCP Server Config Linting

ctxlint also lints MCP server configuration files — the JSON configs that tell AI clients which tools to connect to. These are context interfaces too: they shape what your agent can do.

```bash
# Lint context files + MCP configs
npx @yawlabs/ctxlint --mcp

# Lint only MCP configs
npx @yawlabs/ctxlint --mcp-only

# Include global/user-level configs (Claude Desktop, Cursor, Windsurf, etc.)
npx @yawlabs/ctxlint --mcp-global
```

### What MCP config files are scanned

| File                          | Client                                 |
| ----------------------------- | -------------------------------------- |
| `.mcp.json`                   | Claude Code (universal project config) |
| `.cursor/mcp.json`            | Cursor                                 |
| `.vscode/mcp.json`            | VS Code / GitHub Copilot               |
| `.amazonq/mcp.json`           | Amazon Q Developer                     |
| `.continue/mcpServers/*.json` | Continue                               |

With `--mcp-global`, also scans Claude Desktop, Cursor, Windsurf, and Amazon Q global configs.

### What MCP config checks catch

| Check           | What it finds                                                                          |
| --------------- | -------------------------------------------------------------------------------------- |
| **Schema**      | Invalid JSON, wrong root key (`servers` vs `mcpServers`), missing required fields      |
| **Security**    | Hardcoded API keys and Bearer tokens in git-tracked config files                       |
| **Commands**    | Missing `cmd /c` wrapper for npx on Windows, broken file paths in args                 |
| **Deprecated**  | SSE transport usage (deprecated March 2025, use Streamable HTTP)                       |
| **Env vars**    | Wrong env var syntax for the client (`${VAR}` vs `${env:VAR}` vs `${{ secrets.VAR }}`) |
| **URLs**        | Malformed URLs, localhost in project configs, missing path component                   |
| **Consistency** | Same server configured differently across client configs                               |
| **Redundancy**  | Disabled servers, identical configs at multiple scopes                                 |

### Example MCP config output

```
MCP Configs
  .mcp.json
    ✗ mcp-security    Server "api": hardcoded Bearer token in a git-tracked file
    ✗ mcp-deprecated  Server "old-svc": SSE transport is deprecated — use "http"
    ✓ mcp-schema
    ✓ mcp-commands
  .cursor/mcp.json
    ✗ mcp-env  Server "api": Cursor uses ${env:VAR}, not ${VAR}
    ✓ mcp-schema
  .vscode/mcp.json
    ✗ mcp-schema  .vscode/mcp.json must use "servers" as root key, not "mcpServers"

Cross-file
    ⚠ Server "api" is configured differently in .mcp.json and .cursor/mcp.json
    ℹ Server "db" is in .mcp.json but missing from .cursor/mcp.json

Summary: 3 errors, 2 warnings, 1 info
```

### MCP Config Linting Specification

The full specification for MCP config linting rules, the cross-client config landscape, and a machine-readable rule catalog are published as open specifications:

- **[`MCP_CONFIG_LINT_SPEC.md`](./MCP_CONFIG_LINT_SPEC.md)** — 43 lint rules across 8 categories, the complete client/format reference, and implementation guidance. Tool-agnostic — any linter can implement it.
- **[`mcp-config-lint-rules.json`](./mcp-config-lint-rules.json)** — Machine-readable rule catalog for programmatic consumption by AI agents, CI systems, and other tools.

## Session Linting

ctxlint can audit AI agent session data — history files and memory entries — for cross-project consistency. Session checks compare your current project against sibling repos to catch drift and missing setup.

```bash
# Lint context files + session data
npx @yawlabs/ctxlint --session

# Lint only session data
npx @yawlabs/ctxlint --session-only
```

Session checks are **opt-in** because they access files outside the project directory (agent history in your home directory, sibling repos in the parent directory).

### What session files are scanned

| Agent       | History                   | Memory                             |
| ----------- | ------------------------- | ---------------------------------- |
| Claude Code | `~/.claude/history.jsonl` | `~/.claude/projects/*/memory/*.md` |
| Codex CLI   | `~/.codex/history.jsonl`  | —                                  |

### What session checks catch

| Check                 | What it finds                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Missing secrets**   | `gh secret set` ran on 2+ sibling repos but not this one                                                                                         |
| **Diverged configs**  | Shared config files (CI workflows, tsconfig, .prettierrc, etc.) with 20-90% line overlap — enough to be related, different enough to be drifting |
| **Missing workflows** | GitHub Actions workflows in 2+ siblings but absent from this project                                                                             |
| **Stale memory**      | Memory entries referencing file paths that no longer exist                                                                                       |
| **Duplicate memory**  | Near-duplicate memory entries across projects (>60% overlap)                                                                                     |
| **Loop detection**    | Agent stuck in a loop — 3+ consecutive identical commands, or cyclic A,B,A,B patterns                                                            |
| **Memory index overflow** | `MEMORY.md` exceeds Claude Code's documented 200-line / 25KB session-load cap, so entries past the cap are invisible to the agent            |

### Session Linting Specification

- **[`AGENT_SESSION_LINT_SPEC.md`](./AGENT_SESSION_LINT_SPEC.md)** — 8 lint rules, the agent session data landscape across 8 agents, sibling detection strategy, and implementation guidance.
- **[`agent-session-lint-rules.json`](./agent-session-lint-rules.json)** — Machine-readable rule catalog.

## Example Output

```
ctxlint v0.9.10

Scanning /Users/you/my-app...

Found 2 context files (1,847 tokens total)
  CLAUDE.md (1,203 tokens, 42 lines)
  AGENTS.md -> CLAUDE.md (symlink)

CLAUDE.md
  ✗ Line 12: src/auth/middleware.ts does not exist
    → Did you mean src/middleware/auth.ts? (renamed 14 days ago)
  ✗ Line 8: "pnpm test" — script "test" not found in package.json
  ⚠ Last updated 47 days ago. src/routes/ has 8 commits since.
  ⚠ testing framework conflict: "Vitest" in CLAUDE.md vs "Jest" in AGENTS.md
  ℹ Line 3: "Express" is in package.json dependencies — agent can infer this

Summary: 2 errors, 2 warnings, 1 info
  Token usage: 1,203 tokens per agent session
  Estimated waste: ~55 tokens (redundant content)
```

## Options

```
Usage: ctxlint [options] [path]

Arguments:
  path                 Project directory to scan (default: ".")

Options:
  --strict             Exit code 1 on any warning or error (for CI)
  --checks <list>      Comma-separated checks to run (see below)
  --ignore <list>      Comma-separated checks to skip
  --fix                Auto-fix broken paths using git history and fuzzy matching
  --format <fmt>       Output format: text, json, or sarif (default: text)
  --tokens             Show token breakdown per file
  --verbose            Show passing checks too
  --quiet              Suppress all output except errors (exit code only)
  --config <path>      Path to config file (default: .ctxlintrc in project root)
  --depth <n>          Max subdirectory depth to scan (default: 2)
  --mcp                Enable MCP config linting alongside context file checks
  --mcp-only           Run only MCP config checks, skip context file checks
  --mcp-global         Also scan user/global MCP config files (implies --mcp)
  --session            Enable session audit checks (cross-project consistency)
  --session-only       Run only session checks, skip context and MCP checks
  --mcp-server         Start the MCP server (alias: `serve` subcommand)
  --watch              Re-lint on context file changes
  -V, --version        Output the version number
  -h, --help           Display help

Commands:
  init                 Set up a git pre-commit hook
```

**Available checks:** `paths`, `commands`, `staleness`, `tokens`, `tier-tokens`, `redundancy`, `contradictions`, `frontmatter`, `ci-coverage`, `ci-secrets`, `mcp-schema`, `mcp-security`, `mcp-commands`, `mcp-deprecated`, `mcp-env`, `mcp-urls`, `mcp-consistency`, `mcp-redundancy`, `session-missing-secret`, `session-diverged-file`, `session-missing-workflow`, `session-stale-memory`, `session-duplicate-memory`, `session-loop-detection`, `session-memory-index-overflow`

Passing any `mcp-*` check name implies `--mcp`. Passing any `session-*` check name implies `--session`.

## Watch Mode

```bash
npx @yawlabs/ctxlint --watch
```

Re-lints automatically when any context file, MCP config, or `package.json` changes. Useful during development when you're editing context files alongside code.

## Use in CI

```yaml
- name: Lint context files
  run: npx @yawlabs/ctxlint --strict
```

### Exit Codes

| Code | Meaning |
|---|---|
| `0` | Success — no issues, or issues below the strict threshold |
| `1` | Strict mode caught at least one error or warning (`--strict` is set) |
| `2` | Config error, invalid CLI option, or internal failure |

In non-strict mode ctxlint always exits `0` — it's a reporting tool by default. Pass `--strict` to enforce in CI.

### GitHub Action

```yaml
- name: Lint context files
  uses: yawlabs/ctxlint-action@v1
```

Or with options:

```yaml
- name: Lint context files
  uses: yawlabs/ctxlint-action@v1
  with:
    args: '--strict --mcp'
```

### SARIF Output (GitHub Code Scanning)

```yaml
- name: Lint context files
  run: npx @yawlabs/ctxlint --format sarif > ctxlint.sarif

- name: Upload SARIF
  uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: ctxlint.sarif
```

## Auto-fix

```bash
npx @yawlabs/ctxlint --fix
```

When a broken path was renamed in git or has a close match in the project, `--fix` rewrites the context file automatically.

## Pre-commit Hook

### Built-in

```bash
npx @yawlabs/ctxlint init
```

Sets up a git pre-commit hook that runs `ctxlint --strict` before each commit.

### pre-commit framework

Add to your `.pre-commit-config.yaml`:

```yaml
repos:
  - repo: https://github.com/yawlabs/ctxlint
    rev: v0.9.10
    hooks:
      - id: ctxlint
```

## Config File

Create a `.ctxlintrc` or `.ctxlintrc.json` in your project root:

```json
{
  "checks": ["paths", "commands", "tokens", "contradictions", "frontmatter"],
  "ignore": ["redundancy"],
  "strict": true,
  "tokenThresholds": {
    "info": 500,
    "warning": 2000,
    "error": 5000,
    "aggregate": 4000,
    "tierBreakdown": 1000,
    "tierAggregate": 4000
  },
  "contextFiles": ["CONVENTIONS.md", "docs/ai-rules.md"]
}
```

The `contextFiles` array adds custom file patterns to scan alongside the built-in list. Useful for project-specific context files like `CONVENTIONS.md`.

### Config Reference

| Field | Type | Default | Meaning |
|---|---|---|---|
| `checks` | `string[]` | all checks | Checks to run. Check names include `paths`, `commands`, `tokens`, `tier-tokens`, `redundancy`, `contradictions`, `frontmatter`, `staleness`, `ci-coverage`, `ci-secrets`, plus any `mcp-*` / `session-*`. |
| `ignore` | `string[]` | `[]` | Checks to skip, evaluated after `checks`. |
| `strict` | `boolean` | `false` | Exit non-zero on any warning or error. |
| `tokenThresholds` | `object` | see below | Per-file and cross-file token thresholds. |
| `tokenThresholds.info` | `number` | `1000` | Per-file info threshold for `tokens/info`. |
| `tokenThresholds.warning` | `number` | `3000` | Per-file warning threshold for `tokens/large`. |
| `tokenThresholds.error` | `number` | `8000` | Per-file error threshold for `tokens/excessive`. |
| `tokenThresholds.aggregate` | `number` | `5000` | Cross-file total threshold for `tokens/aggregate`. |
| `tokenThresholds.tierBreakdown` | `number` | `1000` | Always-loaded file threshold for `tier-tokens/section-breakdown`. |
| `tokenThresholds.tierAggregate` | `number` | `4000` | Combined always-loaded threshold for `tier-tokens/aggregate`. |
| `contextFiles` | `string[]` | `[]` | Extra glob patterns to scan alongside the built-in list. |
| `mcp` | `boolean` | `false` | Enable MCP config checks by default (same as `--mcp`). |
| `mcpGlobal` | `boolean` | `false` | Also scan user/global MCP configs (same as `--mcp-global`). |

Config file resolution order: `.ctxlintrc` → `.ctxlintrc.json` in the project root. Use `--config <path>` to point elsewhere. CLI flags override config fields.

CLI flags override config file settings. Use `--config <path>` to load a config from a custom location.

## Use as MCP Server

ctxlint ships with an MCP server that exposes six tools (`ctxlint_audit`, `ctxlint_mcp_audit`, `ctxlint_session_audit`, `ctxlint_validate_path`, `ctxlint_token_report`, `ctxlint_fix`). All read-only tools declare annotations so MCP clients can skip confirmation dialogs.

Launch it with the `serve` subcommand (or the equivalent `--mcp-server` flag, kept for back-compat):

```bash
npx -y @yawlabs/ctxlint serve
```

### With Claude Code

```bash
claude mcp add ctxlint -- npx -y @yawlabs/ctxlint serve
```

### With `.mcp.json` (Claude Code project config, Cursor, Windsurf)

Create `.mcp.json` in your project root:

macOS / Linux / WSL:

```json
{
  "mcpServers": {
    "ctxlint": {
      "command": "npx",
      "args": ["-y", "@yawlabs/ctxlint", "serve"]
    }
  }
}
```

Windows:

```json
{
  "mcpServers": {
    "ctxlint": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@yawlabs/ctxlint", "serve"]
    }
  }
}
```

> **Tip:** This file is safe to commit — it contains no secrets.

### With VS Code / GitHub Copilot

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "ctxlint": {
      "command": "npx",
      "args": ["-y", "@yawlabs/ctxlint", "serve"]
    }
  }
}
```

### With Claude Desktop

Add to your Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "ctxlint": {
      "command": "npx",
      "args": ["-y", "@yawlabs/ctxlint", "serve"]
    }
  }
}
```

## JSON Output

```bash
npx @yawlabs/ctxlint --format json
```

Returns structured JSON with all file results, issues, and summary — useful for building integrations or dashboards.

## Specifications

ctxlint is the reference implementation of three open specifications for linting AI agent interfaces. These specs are tool-agnostic — any linter, IDE extension, or CI system can implement them.

| Spec                                                           | What it covers                                                                                                                                                                                                                     |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[AI Context File Linting Spec](./CONTEXT_LINT_SPEC.md)**     | 19 rules for validating context files (CLAUDE.md, .cursorrules, AGENTS.md, etc.) across 17 clients. Covers file formats, frontmatter schemas, path/command validation, staleness, token budgets, redundancy, and contradictions.   |
| **[MCP Config Linting Spec](./MCP_CONFIG_LINT_SPEC.md)**       | 43 rules for validating MCP server configs (.mcp.json, .cursor/mcp.json, .vscode/mcp.json, etc.) across 8 clients. Covers schema validation, hardcoded secrets, env var syntax, deprecated transports, and cross-file consistency. |
| **[Agent Session Linting Spec](./AGENT_SESSION_LINT_SPEC.md)** | 7 rules for auditing agent session data (history, memory) across 8 agents. Covers cross-project secret consistency, config drift, stale memory, and loop detection.                                                                |

All specs include machine-readable rule catalogs for programmatic consumption:

- [`context-lint-rules.json`](./context-lint-rules.json) — context file rules and 16 supported format definitions
- [`mcp-config-lint-rules.json`](./mcp-config-lint-rules.json) — MCP config rules and 8 client definitions
- [`agent-session-lint-rules.json`](./agent-session-lint-rules.json) — session lint rules and 8 agent data source definitions

## Also By Yaw Labs

- [Yaw](https://yaw.sh) — The AI-native terminal
- [mcp.hosting](https://mcp.hosting) — MCP server proxy platform
- [Token Meter](https://tokenmeter.sh) — LLM spend tracking
- [Token Limit News](https://tokenlimit.news) — Weekly AI dev tooling newsletter

## License

MIT
