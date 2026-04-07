# ctxlint

Lint your AI agent context files against your actual codebase.

Your `CLAUDE.md` is lying to your agent. ctxlint catches it.

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

ctxlint ships with an MCP server that exposes four tools (`ctxlint_audit`, `ctxlint_validate_path`, `ctxlint_token_report`, `ctxlint_fix`):

```bash
# Claude Code
claude mcp add ctxlint -- node node_modules/@yawlabs/ctxlint/dist/mcp/server.js

# Or run from source
claude mcp add ctxlint -- node /path/to/ctxlint/dist/mcp/server.js
```

## JSON Output

```bash
npx @yawlabs/ctxlint --format json
```

Returns structured JSON with all file results, issues, and summary — useful for building integrations or dashboards.

## Also By Yaw Labs

- [Yaw](https://yaw.sh) — The AI-native terminal
- [mcp.hosting](https://mcp.hosting) — MCP server proxy platform
- [Token Meter](https://tokenmeter.sh) — LLM spend tracking
- [Token Limit News](https://tokenlimit.news) — Weekly AI dev tooling newsletter

## License

MIT
