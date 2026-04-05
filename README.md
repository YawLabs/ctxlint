# ctxlint

Lint your AI agent context files against your actual codebase.

Your `CLAUDE.md` is lying to your agent. ctxlint catches it.

## Install

```bash
npm install -g ctxlint
```

Or run directly:

```bash
npx ctxlint
```

## What It Checks

| Check | What it finds |
|-------|--------------|
| **Broken paths** | File references in context that don't exist in your project |
| **Wrong commands** | Build/test commands that don't match your package.json scripts |
| **Stale context** | Context files not updated after recent code changes |
| **Token waste** | How much context window your files consume per session |
| **Redundancy** | Content the agent can already infer (e.g. "We use React" when react is in package.json) |

## Supported Context Files

| File | Tool |
|------|------|
| `CLAUDE.md`, `CLAUDE.local.md` | Claude Code |
| `AGENTS.md` | Multi-agent |
| `.cursorrules`, `.cursor/rules/*.md` | Cursor |
| `copilot-instructions.md` | GitHub Copilot |
| `.windsurfrules`, `.windsurf/rules/*.md` | Windsurf |
| `GEMINI.md` | Gemini |
| `JULES.md` | Jules |
| `.clinerules` | Cline |
| `CONVENTIONS.md` | General |

## Example Output

```
ctxlint v0.1.0

Scanning /Users/you/my-app...

Found 2 context files (1,847 tokens total)
  CLAUDE.md (1,203 tokens, 42 lines)
  AGENTS.md -> CLAUDE.md (symlink)

CLAUDE.md
  ✗ Line 12: src/auth/middleware.ts does not exist
    → Did you mean src/middleware/auth.ts? (renamed 14 days ago)
  ✗ Line 8: "pnpm test" — script "test" not found in package.json
  ⚠ Last updated 47 days ago. src/routes/ has 8 commits since.
  ℹ Line 3: "Express" is in package.json dependencies — agent can infer this

Summary: 2 errors, 1 warning, 1 info
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
  --checks <list>      Comma-separated: paths, commands, staleness, tokens, redundancy
  --ignore <list>      Comma-separated checks to skip
  --format json        Output as JSON (for programmatic use)
  --tokens             Show token breakdown per file
  --verbose            Show passing checks too
  -V, --version        Output the version number
  -h, --help           Display help
```

## Use in CI

```yaml
- name: Lint context files
  run: npx ctxlint --strict
```

Exits with code 1 if any errors or warnings are found.

## Use as MCP Server

ctxlint ships with an MCP server that exposes three tools (`ctxlint_audit`, `ctxlint_validate_path`, `ctxlint_token_report`):

```bash
# Claude Code
claude mcp add ctxlint -- node node_modules/ctxlint/dist/mcp/server.js

# Or run from source
claude mcp add ctxlint -- node /path/to/ctxlint/dist/mcp/server.js
```

## JSON Output

```bash
npx ctxlint --format json
```

Returns structured JSON with all file results, issues, and summary — useful for building integrations or dashboards.

## Also By Yaw Labs

- [Yaw](https://yaw.sh) — The AI-native terminal
- [mcp.hosting](https://mcp.hosting) — MCP server proxy platform
- [Token Meter](https://tokenmeter.sh) — LLM spend tracking
- [Token Limit News](https://tokenlimit.news) — Weekly AI dev tooling newsletter

## License

MIT
