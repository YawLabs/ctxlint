# ctxlint

[![npm version](https://img.shields.io/npm/v/@yawlabs/ctxlint)](https://www.npmjs.com/package/@yawlabs/ctxlint)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/YawLabs/ctxlint)](https://github.com/YawLabs/ctxlint/stargazers)
[![CI](https://github.com/YawLabs/ctxlint/actions/workflows/ci.yml/badge.svg)](https://github.com/YawLabs/ctxlint/actions/workflows/ci.yml)
[![Release](https://github.com/YawLabs/ctxlint/actions/workflows/release.yml/badge.svg)](https://github.com/YawLabs/ctxlint/actions/workflows/release.yml)

**Lint your AI agent context files and MCP server configs against your actual codebase.** Context linting + MCP config linting. 21+ context formats, 8 MCP clients, auto-fix. Works as a CLI, CI step, pre-commit hook, or MCP server.

Your `CLAUDE.md` is lying to your agent. Your `.mcp.json` has a hardcoded API key. ctxlint catches both.

## Why ctxlint?

Every AI coding tool ships a context file: `CLAUDE.md`, `.cursorrules`, `AGENTS.md`, `.mcp.json`. These files are the single most important interface between you and your agent — they tell it what to build, how to test, where things live.

But context files rot fast. You rename a file, change a build script, or switch from Jest to Vitest — and your `CLAUDE.md` still says the old thing. Your agent follows those stale instructions faithfully, then fails. You lose 10 minutes debugging what turns out to be a wrong path in line 12 of a markdown file.

Multiply that across a team with 5 context files, 3 MCP configs, and 2 people who touched the build system last week — and you have a real problem with no existing solution.

ctxlint is a linter purpose-built for this. It reads your context files, cross-references them against your actual codebase, and catches the drift before your agent does.

- **Instant startup** — ships as a single self-contained bundle with zero runtime dependencies. `npx` downloads ~200 KB and starts immediately
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

| Check | What it finds |
|-------|--------------|
| **Broken paths** | File references in context that don't exist in your project |
| **Wrong commands** | Build/test commands that don't match your package.json scripts or Makefile targets |
| **Stale context** | Context files not updated after recent code changes |
| **Token waste** | How much context window your files consume per session |
| **Redundancy** | Content the agent can already infer (e.g. "We use React" when react is in package.json) |
| **Contradictions** | Conflicting directives across context files (e.g. "use Jest" in one, "use Vitest" in another) |
| **Frontmatter** | Invalid or missing YAML frontmatter in Cursor .mdc, Copilot instructions, and Windsurf rules |
| **CI coverage** | Release/deploy workflows in `.github/workflows/` not documented in any context file |
| **CI secrets** | Secrets used in CI workflows (`${{ secrets.X }}`) not mentioned in context files |

## Supported Context Files

| File | Tool |
|------|------|
| `CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules/*.md` | Claude Code |
| `AGENTS.md`, `AGENT.md`, `AGENTS.override.md` | AAIF / Multi-agent standard |
| `.cursorrules`, `.cursor/rules/*.md`, `.cursor/rules/*.mdc`, `.cursor/rules/*/RULE.md` | Cursor |
| `.github/copilot-instructions.md`, `.github/instructions/*.md`, `.github/git-commit-instructions.md` | GitHub Copilot |
| `.windsurfrules`, `.windsurf/rules/*.md` | Windsurf |
| `GEMINI.md` | Gemini CLI |
| `.clinerules` | Cline |
| `.aiderules` | Aider |
| `.aide/rules/*.md` | Aide / Codestory |
| `.amazonq/rules/*.md` | Amazon Q Developer |
| `.goose/instructions.md`, `.goosehints` | Goose by Block |
| `.junie/guidelines.md`, `.junie/AGENTS.md` | JetBrains Junie |
| `.aiassistant/rules/*.md` | JetBrains AI Assistant |
| `.continuerules`, `.continue/rules/*.md` | Continue |
| `.rules` | Zed |
| `replit.md` | Replit |

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

| File | Client |
|------|--------|
| `.mcp.json` | Claude Code (universal project config) |
| `.cursor/mcp.json` | Cursor |
| `.vscode/mcp.json` | VS Code / GitHub Copilot |
| `.amazonq/mcp.json` | Amazon Q Developer |
| `.continue/mcpServers/*.json` | Continue |

With `--mcp-global`, also scans Claude Desktop, Cursor, Windsurf, and Amazon Q global configs.

### What MCP config checks catch

| Check | What it finds |
|-------|--------------|
| **Schema** | Invalid JSON, wrong root key (`servers` vs `mcpServers`), missing required fields |
| **Security** | Hardcoded API keys and Bearer tokens in git-tracked config files |
| **Commands** | Missing `cmd /c` wrapper for npx on Windows, broken file paths in args |
| **Deprecated** | SSE transport usage (deprecated March 2025, use Streamable HTTP) |
| **Env vars** | Wrong env var syntax for the client (`${VAR}` vs `${env:VAR}` vs `${{ secrets.VAR }}`) |
| **URLs** | Malformed URLs, localhost in project configs, missing path component |
| **Consistency** | Same server configured differently across client configs |
| **Redundancy** | Disabled servers, identical configs at multiple scopes |

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

- **[`MCP_CONFIG_LINT_SPEC.md`](./MCP_CONFIG_LINT_SPEC.md)** — 23 lint rules across 8 categories, the complete client/format reference, and implementation guidance. Tool-agnostic — any linter can implement it.
- **[`mcp-config-lint-rules.json`](./mcp-config-lint-rules.json)** — Machine-readable rule catalog for programmatic consumption by AI agents, CI systems, and other tools.

## Example Output

```
ctxlint v0.7.0

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
  --mcp-server         Start the MCP server (for IDE/agent integration)
  --watch              Re-lint on context file changes
  -V, --version        Output the version number
  -h, --help           Display help

Commands:
  init                 Set up a git pre-commit hook
```

**Available checks:** `paths`, `commands`, `staleness`, `tokens`, `redundancy`, `contradictions`, `frontmatter`, `ci-coverage`, `ci-secrets`, `mcp-schema`, `mcp-security`, `mcp-commands`, `mcp-deprecated`, `mcp-env`, `mcp-urls`, `mcp-consistency`, `mcp-redundancy`

Passing any `mcp-*` check name implies `--mcp`.

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

Exits with code 1 if any errors or warnings are found.

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
    rev: v0.7.0
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
    "aggregate": 4000
  },
  "contextFiles": ["CONVENTIONS.md", "docs/ai-rules.md"]
}
```

The `contextFiles` array adds custom file patterns to scan alongside the built-in list. Useful for project-specific context files like `CONVENTIONS.md`.

CLI flags override config file settings. Use `--config <path>` to load a config from a custom location.

## Use as MCP Server

ctxlint ships with an MCP server that exposes five tools (`ctxlint_audit`, `ctxlint_mcp_audit`, `ctxlint_validate_path`, `ctxlint_token_report`, `ctxlint_fix`). All read-only tools declare annotations so MCP clients can skip confirmation dialogs.

### With Claude Code

```bash
claude mcp add ctxlint -- npx -y @yawlabs/ctxlint --mcp-server
```

### With `.mcp.json` (Claude Code project config, Cursor, Windsurf)

Create `.mcp.json` in your project root:

macOS / Linux / WSL:

```json
{
  "mcpServers": {
    "ctxlint": {
      "command": "npx",
      "args": ["-y", "@yawlabs/ctxlint", "--mcp-server"]
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
      "args": ["/c", "npx", "-y", "@yawlabs/ctxlint", "--mcp-server"]
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
      "args": ["-y", "@yawlabs/ctxlint", "--mcp-server"]
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
      "args": ["-y", "@yawlabs/ctxlint", "--mcp-server"]
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

ctxlint is the reference implementation of two open specifications for linting AI agent interfaces. These specs are tool-agnostic — any linter, IDE extension, or CI system can implement them.

| Spec | What it covers |
|------|---------------|
| **[AI Context File Linting Spec](./CONTEXT_LINT_SPEC.md)** | 19 rules for validating context files (CLAUDE.md, .cursorrules, AGENTS.md, etc.) across 17 clients. Covers file formats, frontmatter schemas, path/command validation, staleness, token budgets, redundancy, and contradictions. |
| **[MCP Config Linting Spec](./MCP_CONFIG_LINT_SPEC.md)** | 23 rules for validating MCP server configs (.mcp.json, .cursor/mcp.json, .vscode/mcp.json, etc.) across 8 clients. Covers schema validation, hardcoded secrets, env var syntax, deprecated transports, and cross-file consistency. |

Both specs include machine-readable rule catalogs for programmatic consumption:
- [`context-lint-rules.json`](./context-lint-rules.json) — context file rules and 16 supported format definitions
- [`mcp-config-lint-rules.json`](./mcp-config-lint-rules.json) — MCP config rules and 8 client definitions

## Also By Yaw Labs

- [Yaw](https://yaw.sh) — The AI-native terminal
- [mcp.hosting](https://mcp.hosting) — MCP server proxy platform
- [Token Meter](https://tokenmeter.sh) — LLM spend tracking
- [Token Limit News](https://tokenlimit.news) — Weekly AI dev tooling newsletter

## License

MIT
