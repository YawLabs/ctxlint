# ctxlint

[![npm version](https://img.shields.io/npm/v/@yawlabs/ctxlint)](https://www.npmjs.com/package/@yawlabs/ctxlint)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/YawLabs/ctxlint)](https://github.com/YawLabs/ctxlint/stargazers)
[![CI](https://github.com/YawLabs/ctxlint/actions/workflows/ci.yml/badge.svg)](https://github.com/YawLabs/ctxlint/actions/workflows/ci.yml)

**Lint your AI agent context files and MCP server configs against your actual codebase.** Context linting + MCP config linting. 21+ context formats, 8 MCP clients, auto-fix. Works as a CLI, CI step, pre-commit hook, or MCP server.

Your `CLAUDE.md` is lying to your agent. Your `.mcp.json` has a hardcoded API key. ctxlint catches both.

## Why ctxlint?

Context files rot fast. You rename a file, change a build script, or switch from Jest to Vitest — and your `CLAUDE.md` still says the old thing. Your agent follows those instructions faithfully, then fails.

- **Catches real problems** — broken paths, wrong commands, stale references, contradictions across files
- **Smart suggestions** — detects git renames and fuzzy-matches to suggest the right path
- **Auto-fix** — `--fix` rewrites broken paths automatically using git history
- **Token-aware** — shows how much context window your files consume and flags redundant content
- **Every AI tool** — supports Claude Code, Cursor, Copilot, Windsurf, Gemini, Cline, Aider, and 14 more
- **Multiple outputs** — text, JSON, and SARIF (GitHub Code Scanning)
- **MCP server** — 4 tools for IDE/agent integration with tool annotations for auto-approval

## Install

```bash
npm install -g @yawlabs/ctxlint
```

Or run directly:

```bash
npx @yawlabs/ctxlint
```

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

With `--mcp-global`, also scans Claude Desktop, Cursor, Windsurf, Cline, and Amazon Q global configs.

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
ctxlint v0.3.0

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
  --checks <list>      Comma-separated: paths, commands, staleness, tokens, redundancy, contradictions, frontmatter
  --ignore <list>      Comma-separated checks to skip
  --fix                Auto-fix broken paths using git history and fuzzy matching
  --format <fmt>       Output format: text, json, or sarif (default: text)
  --tokens             Show token breakdown per file
  --verbose            Show passing checks too
  --quiet              Suppress all output (exit code only, for scripts)
  --config <path>      Path to config file (default: .ctxlintrc in project root)
  --depth <n>          Max subdirectory depth to scan (default: 2)
  --mcp                Start the MCP server instead of running the linter
  -V, --version        Output the version number
  -h, --help           Display help

Commands:
  init                 Set up a git pre-commit hook
```

## Use in CI

```yaml
- name: Lint context files
  run: npx @yawlabs/ctxlint --strict
```

Exits with code 1 if any errors or warnings are found.

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
    rev: v0.3.0
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

ctxlint ships with an MCP server that exposes four tools (`ctxlint_audit`, `ctxlint_validate_path`, `ctxlint_token_report`, `ctxlint_fix`). All tools declare annotations so MCP clients can skip confirmation dialogs for read-only operations.

### With `.mcp.json` (Cursor, Windsurf, and other MCP clients)

Create `.mcp.json` in your project root:

macOS / Linux / WSL:

```json
{
  "mcpServers": {
    "ctxlint": {
      "command": "npx",
      "args": ["-y", "@yawlabs/ctxlint", "--mcp"]
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
      "args": ["/c", "npx", "-y", "@yawlabs/ctxlint", "--mcp"]
    }
  }
}
```

> **Tip:** This file is safe to commit — it contains no secrets.

### With Claude Code

```bash
claude mcp add ctxlint -- npx -y @yawlabs/ctxlint --mcp
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
