# MCP Config Linting — ctxlint Implementation Plan

**Status:** Draft
**Date:** 2026-04-07
**Target:** ctxlint v0.4.0

> This is the **ctxlint-specific implementation plan**. For the public, tool-agnostic specification of rules, client behaviors, and the MCP config landscape, see [`MCP_CONFIG_LINT_SPEC.md`](../../MCP_CONFIG_LINT_SPEC.md) at the repo root.

## Overview

This document describes how ctxlint implements the [MCP Server Configuration Linting Specification](../../MCP_CONFIG_LINT_SPEC.md). It maps the spec's rules and data model onto ctxlint's existing scanner/parser/checks/reporter/fixer pipeline.

## Goals

1. Discover and validate MCP config files across all major AI clients
2. Catch security issues (hardcoded API keys in committed configs)
3. Catch structural errors (missing fields, wrong root keys, invalid JSON)
4. Catch compatibility issues (wrong env var syntax, Windows npx quirks, deprecated SSE transport)
5. Cross-file consistency checks (same server configured differently across clients)
6. Auto-fix where possible (following ctxlint's existing `--fix` pattern)

## Non-goals

- Network reachability checks (pinging remote URLs) — too slow, too flaky
- npm version staleness for stdio packages — out of scope for a linter
- Linting the MCP server's *behavior* (that's what mcp-compliance does)

---

## MCP Config Landscape Reference

This section documents the full MCP config landscape as of April 2026. Implementation should use this as the source of truth for what to scan, parse, and validate.

### Config format

Every MCP config file uses a JSON object with a root key containing server entries. Each server entry is keyed by name and describes how to connect.

**Two transport types matter:**

**stdio** — client launches a local subprocess, communicates over stdin/stdout:
```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "@some/mcp-server"],
      "env": { "DEBUG": "true" }
    }
  }
}
```

**Streamable HTTP** — client connects to a remote URL over HTTP:
```json
{
  "mcpServers": {
    "my-server": {
      "type": "http",
      "url": "https://my-server.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${API_KEY}"
      }
    }
  }
}
```

**SSE** — deprecated as of March 2025 spec update. Still works in most clients but should be migrated to Streamable HTTP. Uses `"type": "sse"`.

### Server entry fields

| Field | Type | Used by | Description |
|---|---|---|---|
| `type` | `"stdio"` \| `"http"` \| `"sse"` | All | Transport. Defaults to `stdio` if `command` present |
| `command` | string | stdio | Executable to launch |
| `args` | string[] | stdio | Arguments passed to command |
| `env` | Record<string, string> | stdio | Environment variables for the subprocess |
| `url` | string | http/sse | Remote endpoint URL |
| `headers` | Record<string, string> | http/sse | HTTP headers sent with requests |
| `disabled` | boolean | Cline | Whether server is disabled |
| `autoApprove` | string[] | Cline | Tool names to auto-approve |
| `timeout` | number (ms) | Amazon Q | Max wait time (default 60000) |
| `oauth` | object | Claude Code | OAuth config (clientId, callbackPort, etc.) |
| `headersHelper` | string | Claude Code | Shell command that outputs JSON headers |

### File locations by client

#### Project-level (relative to project root)

| File path | Client | Root key |
|---|---|---|
| `.mcp.json` | Claude Code (universal) | `mcpServers` |
| `.cursor/mcp.json` | Cursor | `mcpServers` |
| `.vscode/mcp.json` | VS Code / GitHub Copilot | **`servers`** (not `mcpServers`) |
| `.amazonq/mcp.json` | Amazon Q Developer | `mcpServers` |
| `.continue/mcpServers/*.json` | Continue | varies |

#### User/global-level

| File path | Client | Root key | Platform |
|---|---|---|---|
| `~/.claude.json` | Claude Code | `mcpServers` | All |
| `~/.claude/settings.json` | Claude Code | `mcpServers` | All |
| `~/.cursor/mcp.json` | Cursor | `mcpServers` | All |
| `~/Library/Application Support/Claude/claude_desktop_config.json` | Claude Desktop | `mcpServers` | macOS |
| `%APPDATA%\Claude\claude_desktop_config.json` | Claude Desktop | `mcpServers` | Windows |
| `~/.codeium/windsurf/mcp_config.json` | Windsurf | `mcpServers` | All |
| `~/.aws/amazonq/mcp.json` | Amazon Q | `mcpServers` | All |
| Cline globalStorage path | Cline | `mcpServers` | All |

### Environment variable syntax by client

| Client | Syntax | Example |
|---|---|---|
| Claude Code | `${VAR}` or `${VAR:-default}` | `${API_KEY}` |
| Cursor | `${env:VAR}` | `${env:API_KEY}` |
| Continue | `${{ secrets.VAR }}` | `${{ secrets.API_KEY }}` |
| Windsurf | `${env:VAR}` (some fields) | `${env:API_KEY}` |

### Override precedence (Claude Code)

When the same server name exists at multiple scopes, most specific wins:

1. **Local** (highest) — personal config for this project (`~/.claude.json` under project path key)
2. **Project** — `.mcp.json` at repo root
3. **User** (lowest) — `~/.claude.json` top-level `mcpServers`

Cursor: project `.cursor/mcp.json` overrides global `~/.cursor/mcp.json`.
Amazon Q: workspace `.amazonq/mcp.json` overrides global `~/.aws/amazonq/mcp.json`. Server names must be unique across both.
VS Code: workspace `.vscode/mcp.json` overrides user-level config.

### Platform-specific gotchas

**Windows + npx:** On native Windows (not WSL), stdio configs using `npx` must wrap with `cmd /c`:
```json
{
  "command": "cmd",
  "args": ["/c", "npx", "-y", "@some/mcp-server"]
}
```
Without this, the subprocess fails to spawn. This is the #1 Windows MCP config issue.

**Claude.ai connectors:** Only support remote servers (Streamable HTTP). No stdio. If a project uses stdio-only servers, they cannot be used from claude.ai without hosting them remotely.

---

## Architecture

### How it maps to ctxlint's existing pipeline

```
Scanner  →  Parser  →  Checks  →  Reporter  →  Fixer
  ↓           ↓          ↓          ↓           ↓
 Add MCP    New JSON   8 new      Works       JSON-aware
 file       parser     check      as-is       fix
 patterns   path       modules                application
```

### New types

Add to `src/core/types.ts`:

```typescript
// --- MCP config types ---

export type McpCheckName =
  | 'mcp-schema'
  | 'mcp-security'
  | 'mcp-commands'
  | 'mcp-deprecated'
  | 'mcp-env'
  | 'mcp-urls'
  | 'mcp-consistency'
  | 'mcp-redundancy';

// Extend the existing CheckName union
export type CheckName =
  | 'paths'
  | 'commands'
  | 'staleness'
  | 'tokens'
  | 'redundancy'
  | 'contradictions'
  | 'frontmatter'
  | McpCheckName;

export type McpClient =
  | 'claude-code'
  | 'claude-desktop'
  | 'vscode'
  | 'cursor'
  | 'windsurf'
  | 'cline'
  | 'amazonq'
  | 'continue';

export type McpTransport = 'stdio' | 'http' | 'sse' | 'unknown';

export type McpConfigScope = 'project' | 'user' | 'global';

export interface McpServerEntry {
  name: string;
  transport: McpTransport;
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // http/sse
  url?: string;
  headers?: Record<string, string>;
  // client-specific
  disabled?: boolean;
  autoApprove?: string[];
  timeout?: number;
  oauth?: Record<string, unknown>;
  headersHelper?: string;
  // line number in the JSON file where this server entry starts
  line: number;
  // raw parsed object for access to unknown fields
  raw: Record<string, unknown>;
}

export interface ParsedMcpConfig {
  filePath: string;
  relativePath: string;
  client: McpClient;
  scope: McpConfigScope;
  expectedRootKey: 'mcpServers' | 'servers';
  actualRootKey: string | null;
  servers: McpServerEntry[];
  parseErrors: string[];
  content: string;
  isGitTracked: boolean;
}
```

### Scanner changes (`src/core/scanner.ts`)

Add a new constant for MCP config file patterns and a new scan function:

```typescript
const MCP_CONFIG_PATTERNS = [
  '.mcp.json',
  '.cursor/mcp.json',
  '.vscode/mcp.json',
  '.amazonq/mcp.json',
  '.continue/mcpServers/*.json',
];

export interface DiscoveredFile {
  absolutePath: string;
  relativePath: string;
  isSymlink: boolean;
  symlinkTarget?: string;
  type: 'context' | 'mcp-config';  // NEW FIELD
}
```

The scanner should NOT recurse into subdirectories for MCP configs (they are always at fixed paths relative to the project root). Only scan the project root for the patterns above.

For user/global configs, add a separate `scanGlobalMcpConfigs()` function gated behind the `--mcp-global` CLI flag. It resolves platform-specific paths (macOS vs Windows vs Linux) for Claude Desktop, Cursor, Windsurf, etc.

### Parser (`src/core/mcp-parser.ts`)

New file. Parses JSON MCP config files into the `ParsedMcpConfig` structure.

Key responsibilities:
1. Parse JSON (catch and report syntax errors with line numbers)
2. Detect which client the file belongs to based on its path
3. Determine the expected root key (`servers` for VS Code, `mcpServers` for everything else)
4. Extract the actual root key used
5. Normalize server entries into `McpServerEntry` objects
6. Infer transport type: `command` present → `stdio`, `url` present → `http`, explicit `type` field → use it
7. Track line numbers for each server entry (for issue reporting)
8. Check `git ls-files` to determine if the file is git-tracked (needed for security checks)

For line number tracking in JSON, use a simple approach: split content by lines, find the line containing `"serverName":` for each server entry. Exact AST-level line tracking is overkill for a linter.

### Audit changes (`src/core/audit.ts`)

The audit function should:
1. Scan for context files (existing behavior)
2. Scan for MCP config files (new, when `--mcp` is active)
3. Parse each file type with its respective parser
4. Run appropriate checks based on file type
5. Run cross-file MCP checks (consistency)
6. Merge results into a single `LintResult`

MCP checks should only run when at least one `mcp-*` check is in the active checks list. If the user runs `ctxlint --checks paths,commands`, MCP checks should not run. If they run `ctxlint --mcp` or `ctxlint --checks mcp-schema,mcp-security`, they should.

### CLI changes (`src/cli.ts`)

New flags:
- `--mcp` — enable MCP config linting (runs all `mcp-*` checks alongside existing checks)
- `--mcp-global` — also scan user/global MCP config files (implies `--mcp`)
- `--mcp-only` — run only MCP checks, skip context file checks

The `--checks` flag should accept `mcp-*` check names directly. Running `ctxlint --checks mcp-schema` implies `--mcp`.

### Config changes (`src/core/config.ts`)

Extend `CtxlintConfig`:
```typescript
export interface CtxlintConfig {
  // ... existing fields
  mcp?: boolean;           // enable MCP linting by default
  mcpGlobal?: boolean;     // include global configs
}
```

---

## Check modules

Each check follows ctxlint's existing pattern: an async function that takes a `ParsedMcpConfig` and `projectRoot`, returns `LintIssue[]`.

All check modules go in `src/core/checks/mcp/`.

### 1. `mcp-schema` — structural validation

**File:** `src/core/checks/mcp/schema.ts`

**Signature:**
```typescript
export async function checkMcpSchema(
  config: ParsedMcpConfig,
  projectRoot: string,
): Promise<LintIssue[]>
```

**Rules:**

| Rule ID | Severity | Condition | Message |
|---|---|---|---|
| `invalid-json` | error | JSON parse failed | `MCP config is not valid JSON: {parseError}` |
| `wrong-root-key` | error | Root key doesn't match client expectation | `.vscode/mcp.json must use "servers" as root key, not "mcpServers"` |
| `missing-root-key` | error | No `mcpServers` or `servers` key found | `MCP config has no "mcpServers" key` |
| `missing-command` | error | stdio server, no `command` | `Server "{name}" has no "command" field` |
| `missing-url` | error | http/sse server, no `url` | `Server "{name}" has no "url" field` |
| `unknown-transport` | warning | `type` is not stdio/http/sse | `Server "{name}" has unknown transport type "{type}"` |
| `ambiguous-transport` | warning | Has both `command` and `url` | `Server "{name}" has both "command" and "url" — transport is ambiguous` |
| `empty-servers` | info | Root key exists but empty object | `MCP config has no server entries` |
| `no-name-field` | error | Server object has empty key | `Server name cannot be empty` |

**Auto-fix:**
- `wrong-root-key`: Rename the root key to match the expected key for the client.

### 2. `mcp-security` — hardcoded secrets

**File:** `src/core/checks/mcp/security.ts`

This is the highest-value check. People routinely commit API keys in MCP configs.

**Rules:**

| Rule ID | Severity | Condition | Message |
|---|---|---|---|
| `hardcoded-bearer` | error | `headers` contains `Authorization: Bearer <literal>` (not `${...}`) in a git-tracked file | `Server "{name}" has a hardcoded Bearer token in a git-tracked file` |
| `hardcoded-api-key` | error | `headers` or `env` values match known API key patterns in a git-tracked file | `Server "{name}" has a hardcoded API key in a git-tracked file` |
| `secret-in-url` | error | URL contains query params that look like keys (`?key=`, `?token=`, `?api_key=`) in a git-tracked file | `Server "{name}" has a secret in the URL query string` |
| `http-no-tls` | warning | URL uses `http://` for non-localhost targets | `Server "{name}" uses HTTP without TLS` |

**API key detection patterns** (high-entropy + known prefixes):
```
sk-[a-zA-Z0-9]{20,}          # OpenAI / generic
ghp_[a-zA-Z0-9]{36}          # GitHub PAT
ghu_[a-zA-Z0-9]{36}          # GitHub user token
github_pat_[a-zA-Z0-9_]{80,} # GitHub fine-grained PAT
xoxb-[0-9]{10,}              # Slack bot
xoxp-[0-9]{10,}              # Slack user
AKIA[0-9A-Z]{16}             # AWS access key
AGE-SECRET-KEY-1[a-zA-Z0-9]+ # age encryption key
glpat-[a-zA-Z0-9_-]{20}      # GitLab PAT
sq0atp-[a-zA-Z0-9_-]{22}     # Square
```

Also flag any string > 20 chars that is all alphanumeric/base64 AND is not an env var reference (`${...}`).

**Auto-fix:**
- Replace `"Bearer sk-abc123..."` with `"Bearer ${SERVER_NAME_API_KEY}"` (derive env var name from server name, uppercase + underscores).
- Replace literal env values with `${SERVER_NAME_ENV_VAR}`.

**Important:** Only flag in git-tracked files. If a file is in `.gitignore` or not in a git repo, secrets are the user's problem, not a linting concern.

### 3. `mcp-commands` — stdio command validation

**File:** `src/core/checks/mcp/commands.ts`

**Rules:**

| Rule ID | Severity | Condition | Message |
|---|---|---|---|
| `windows-npx-no-wrapper` | error | Platform is Windows, `command` is `npx` (not wrapped in `cmd /c`) | `Server "{name}": npx requires "cmd /c" wrapper on Windows` |
| `command-not-found` | warning | `command` is a local path (starts with `./` or `../`) that doesn't exist | `Server "{name}": command "{command}" not found` |
| `args-path-missing` | warning | An arg looks like a local file path and doesn't exist | `Server "{name}": arg "{arg}" looks like a file path but doesn't exist` |

**Notes:**
- For `windows-npx-no-wrapper`: detect Windows by `process.platform === 'win32'` or by presence of Windows-style paths in the config. Only flag project-level configs (global configs on Windows should already have the wrapper, and the user might be on macOS developing for Windows or vice versa). Consider a `--platform` flag override.
- For `args-path-missing`: only check args that match a path pattern (`./`, `../`, or contain `/` with a file extension). Don't check npm package names or flags.
- Don't validate that `npx`, `node`, `python` etc. are on PATH — that's runtime, not config.

**Auto-fix:**
- `windows-npx-no-wrapper`: Rewrite `{"command": "npx", "args": ["-y", "pkg"]}` to `{"command": "cmd", "args": ["/c", "npx", "-y", "pkg"]}`.

### 4. `mcp-deprecated` — deprecated patterns

**File:** `src/core/checks/mcp/deprecated.ts`

**Rules:**

| Rule ID | Severity | Condition | Message |
|---|---|---|---|
| `sse-transport` | warning | `"type": "sse"` | `Server "{name}" uses deprecated SSE transport — use "http" (Streamable HTTP) instead` |

**Auto-fix:**
- Replace `"type": "sse"` with `"type": "http"` in the JSON.

### 5. `mcp-env` — environment variable validation

**File:** `src/core/checks/mcp/env.ts`

**Rules:**

| Rule ID | Severity | Condition | Message |
|---|---|---|---|
| `wrong-syntax` | error | Env var reference uses wrong syntax for the client | `Server "{name}": Cursor uses \${env:VAR}, not \${VAR}` |
| `unset-variable` | info | `${VAR}` referenced but `VAR` not in `process.env` | `Server "{name}": environment variable "{VAR}" is not set` |
| `empty-env-block` | info | `env: {}` present but empty | `Server "{name}": empty "env" block can be removed` |

**Syntax validation matrix:**

| Config file | Expected syntax | Flag if found |
|---|---|---|
| `.mcp.json` | `${VAR}` | `${env:VAR}` |
| `.cursor/mcp.json` | `${env:VAR}` | `${VAR}` (without `env:`) |
| `.continue/mcpServers/*.json` | `${{ secrets.VAR }}` | `${VAR}` or `${env:VAR}` |
| Others | `${VAR}` | — |

**Notes:**
- `unset-variable` should be `info` severity, not `warning`. Many env vars are set in CI or `.env` files that aren't available during linting. This is a best-effort check.
- Scan `command`, `args`, `url`, `headers`, and `env` values for env var references.

**Auto-fix:**
- `wrong-syntax`: Rewrite env var references to the correct syntax for the target client.

### 6. `mcp-urls` — URL validation

**File:** `src/core/checks/mcp/urls.ts`

**Rules:**

| Rule ID | Severity | Condition | Message |
|---|---|---|---|
| `malformed-url` | error | URL is not parseable by `new URL()` (after env var expansion attempt) | `Server "{name}": invalid URL "{url}"` |
| `localhost-in-project-config` | warning | `localhost` or `127.0.0.1` URL in a project-level (git-tracked) config | `Server "{name}": localhost URL in project config won't work for teammates` |
| `missing-path` | info | URL has no path component or just `/` | `Server "{name}": URL has no path — most MCP servers expect /mcp` |

**Notes:**
- If the URL contains env var references (`${...}`), skip `malformed-url` — it can't be validated statically.
- `localhost-in-project-config` should only fire for project-scoped files (`.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`), not for global configs where localhost is fine.

### 7. `mcp-consistency` — cross-file consistency

**File:** `src/core/checks/mcp/consistency.ts`

This is a cross-file check, not a per-file check. It runs after all individual configs are parsed.

**Signature:**
```typescript
export async function checkMcpConsistency(
  configs: ParsedMcpConfig[],
): Promise<LintIssue[]>
```

**Rules:**

| Rule ID | Severity | Condition | Message |
|---|---|---|---|
| `same-server-different-config` | warning | Server with same name exists in 2+ files with different URLs/commands/args | `Server "{name}" is configured differently in {file1} and {file2}` |
| `duplicate-server-name` | warning | Same server name appears twice in one file (JSON last-write-wins) | `Duplicate server name "{name}" in {file} — only the last definition is used` |
| `missing-from-client` | info | Server in `.mcp.json` not present in `.cursor/mcp.json` or `.vscode/mcp.json` (when those files exist) | `Server "{name}" is in .mcp.json but missing from {file}` |

**Notes:**
- `missing-from-client` is low-severity. Teams may intentionally have different servers in different client configs. But it's useful as a reminder.
- For `same-server-different-config`, compare URL/command/args. Ignore header differences (auth tokens will differ per user).

### 8. `mcp-redundancy` — unnecessary configs

**File:** `src/core/checks/mcp/redundancy.ts`

**Rules:**

| Rule ID | Severity | Condition | Message |
|---|---|---|---|
| `disabled-server` | info | Server has `"disabled": true` | `Server "{name}" is disabled — consider removing it if no longer needed` |
| `identical-across-scopes` | info | Same server with identical config at project and global scope | `Server "{name}" is identically configured in both {projectFile} and {globalFile}` |

---

## Reporter changes

The existing reporter works as-is for MCP issues since they use the same `LintIssue` shape. One enhancement: group MCP config issues separately from context file issues in text output.

```
Context Files
  CLAUDE.md
    ✓ paths
    ✗ commands  line 12: "npm run deploy" — script "deploy" not found

MCP Configs
  .mcp.json
    ✗ mcp-security  line 8: Server "api" has a hardcoded Bearer token
    ✗ mcp-deprecated line 4: Server "old-svc" uses deprecated SSE transport
  .cursor/mcp.json
    ✓ mcp-schema
    ✗ mcp-env  line 6: Cursor uses ${env:VAR}, not ${VAR}
```

### SARIF output

MCP check rules should map to SARIF rule IDs as `ctxlint/mcp-schema/wrong-root-key`, `ctxlint/mcp-security/hardcoded-bearer`, etc. This enables GitHub Code Scanning to display them as distinct rule violations.

---

## Fixer changes

The existing fixer operates on markdown files using line-based text replacement. MCP configs are JSON, so fixes need JSON-aware editing.

**Approach:** Don't use a JSON AST library. Keep it simple:
1. Read the file as a string
2. Find the exact substring to replace (using the line number and surrounding context)
3. Do a string replacement
4. Validate the result is still valid JSON
5. Write back

This matches the existing fixer's approach (line-based, surgical, no AST overhead) and avoids reformatting the user's JSON style.

**Fixable rules:**
- `mcp-schema/wrong-root-key` — rename root key
- `mcp-security/hardcoded-bearer` — replace with `${ENV_VAR}`
- `mcp-security/hardcoded-api-key` — replace with `${ENV_VAR}`
- `mcp-commands/windows-npx-no-wrapper` — wrap with `cmd /c`
- `mcp-deprecated/sse-transport` — replace `"sse"` with `"http"`
- `mcp-env/wrong-syntax` — rewrite env var syntax

---

## MCP server tool

Add a new MCP tool to `src/mcp/server.ts`:

```typescript
{
  name: 'ctxlint_mcp_audit',
  description: 'Lint MCP server configuration files in a project',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'Project root path' },
      checks: {
        type: 'array',
        items: { type: 'string' },
        description: 'Specific MCP checks to run (default: all)',
      },
      includeGlobal: {
        type: 'boolean',
        description: 'Also scan global/user-level MCP configs',
      },
    },
  },
}
```

---

## CLI examples

```bash
# Lint everything (context files + MCP configs)
ctxlint --mcp

# Lint only MCP configs
ctxlint --mcp-only

# Lint MCP configs including global/user-level
ctxlint --mcp-global

# Run specific MCP checks
ctxlint --checks mcp-schema,mcp-security

# Auto-fix MCP config issues
ctxlint --mcp --fix

# CI mode: fail on any MCP error
ctxlint --mcp --strict

# JSON output for tooling
ctxlint --mcp --format json
```

---

## Test fixtures

```
fixtures/
  mcp-configs/
    valid/
      .mcp.json                     # Clean Claude Code project config
      .cursor/mcp.json              # Clean Cursor config
      .vscode/mcp.json              # Clean VS Code config (uses "servers")
      .amazonq/mcp.json             # Clean Amazon Q config
    invalid-json/
      .mcp.json                     # Malformed JSON (trailing comma, etc.)
    wrong-root-key/
      .vscode/mcp.json              # Uses "mcpServers" instead of "servers"
      .mcp.json                     # Uses "servers" instead of "mcpServers"
    missing-fields/
      .mcp.json                     # stdio server without command, http without url
    hardcoded-secrets/
      .mcp.json                     # Bearer tokens, API keys in headers/env
      .gitignore                    # empty (file IS tracked)
    untracked-secrets/
      .mcp.json                     # Same secrets but NOT git-tracked
      .gitignore                    # contains .mcp.json
    deprecated-sse/
      .mcp.json                     # type: "sse" usage
    windows-npx/
      .mcp.json                     # npx without cmd /c wrapper
    wrong-env-syntax/
      .cursor/mcp.json              # Uses ${VAR} instead of ${env:VAR}
      .mcp.json                     # Uses ${env:VAR} instead of ${VAR}
    cross-client-drift/
      .mcp.json                     # Server "api" with url-a
      .cursor/mcp.json              # Server "api" with url-b
      .vscode/mcp.json              # Server "api" with url-c (and root key "servers")
    localhost-in-project/
      .mcp.json                     # localhost URL in a project config
    ambiguous-transport/
      .mcp.json                     # Server with both command and url
    empty-servers/
      .mcp.json                     # { "mcpServers": {} }
    duplicate-names/
      .mcp.json                     # Same server name twice
    disabled-server/
      .mcp.json                     # Server with disabled: true (Cline-style)
```

Each fixture directory should include a `expected.json` file with the expected lint output for snapshot testing, following the existing fixture pattern.

---

## Implementation order

Build in this order — each step is independently shippable and testable:

### Phase 1: Infrastructure + schema (v0.4.0-alpha)
1. Add `ParsedMcpConfig` types to `types.ts`
2. Create `src/core/mcp-parser.ts`
3. Add MCP patterns to scanner (with `type` field on `DiscoveredFile`)
4. Create `src/core/checks/mcp/schema.ts`
5. Wire into `audit.ts` with `--mcp` flag
6. Add `--mcp` / `--mcp-only` CLI flags
7. Fixtures: `valid/`, `invalid-json/`, `wrong-root-key/`, `missing-fields/`, `empty-servers/`

### Phase 2: Security (v0.4.0-beta)
8. Create `src/core/checks/mcp/security.ts`
9. Git-tracked detection (`git ls-files`)
10. Fixtures: `hardcoded-secrets/`, `untracked-secrets/`

### Phase 3: Commands + deprecated (v0.4.0-beta)
11. Create `src/core/checks/mcp/commands.ts`
12. Create `src/core/checks/mcp/deprecated.ts`
13. Fixtures: `windows-npx/`, `deprecated-sse/`

### Phase 4: Env + URLs (v0.4.0-rc)
14. Create `src/core/checks/mcp/env.ts`
15. Create `src/core/checks/mcp/urls.ts`
16. Fixtures: `wrong-env-syntax/`, `localhost-in-project/`

### Phase 5: Cross-file + polish (v0.4.0)
17. Create `src/core/checks/mcp/consistency.ts`
18. Create `src/core/checks/mcp/redundancy.ts`
19. Fixer support for all fixable rules
20. Reporter grouping (context files vs MCP configs)
21. MCP server tool (`ctxlint_mcp_audit`)
22. `--mcp-global` flag with platform-specific path resolution
23. Fixtures: `cross-client-drift/`, `duplicate-names/`, `disabled-server/`, `ambiguous-transport/`

---

## Edge cases to handle

1. **`.mcp.json` inside a subdirectory** — only scan project root, not subdirs. Subdirectory `.mcp.json` files are for subprojects and should be linted when ctxlint is run from that subproject.

2. **Config files with comments** — some editors add `//` comments to JSON. Standard `JSON.parse` will fail. Consider using `JSON.parse` and reporting `invalid-json` — this is a real issue the user should fix. Don't silently strip comments.

3. **Large `~/.claude.json`** — this file contains project-scoped configs nested under path keys, plus a top-level `mcpServers`. When scanning global configs, only extract the top-level `mcpServers`, not per-project overrides.

4. **Symlinked configs** — respect the existing `isSymlink` handling in the scanner.

5. **No git repo** — if the project is not in a git repo, skip `isGitTracked` checks and don't flag secrets (can't determine if they'd be committed). Log an info message.

6. **Env vars that reference other env vars** — `${${PREFIX}_KEY}` is not a real pattern in MCP configs. Don't try to handle nested expansion.

7. **OAuth configs** — Claude Code supports `oauth` blocks in server entries. Don't flag these as unknown fields. Don't try to validate OAuth config structure (it's Claude-specific and evolving).

---

## Marketing angle

This positions ctxlint as the only tool that lints *all* AI context interfaces — instruction files AND tool configs. Key messaging:

- "ctxlint now catches broken MCP configs, hardcoded API keys, and deprecated transports across every major AI client"
- "One command to validate your entire AI agent setup — rules, instructions, and server configs"
- "The only linter that knows .vscode/mcp.json uses `servers` while everyone else uses `mcpServers`"
- Security angle: "How many repos have API keys in their .mcp.json? ctxlint finds out."
