# MCP Server Configuration Linting Specification

**Version:** 1.0.0-draft
**Date:** 2026-04-07
**MCP Spec Compatibility:** 2025-11-25 (Streamable HTTP)
**Maintained by:** [Yaw Labs](https://yaw.sh) / [ctxlint](https://github.com/YawLabs/ctxlint)
**License:** CC BY 4.0

---

## What is this?

MCP server configuration files (`.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, etc.) define which tools an AI agent can access. They are a context interface — alongside instruction files like `CLAUDE.md` and `.cursorrules`, they shape what an agent knows and can do.

This specification defines a standard set of lint rules for validating MCP server configurations across all major AI coding clients. It is tool-agnostic: any linter, IDE extension, CI check, or AI agent can implement these rules.

The specification includes:
- A complete reference of MCP config file locations, formats, and client-specific behaviors
- 23 lint rules organized into 8 categories with defined severities
- A machine-readable rule catalog ([`mcp-config-lint-rules.json`](./mcp-config-lint-rules.json))
- Auto-fix definitions for rules that support automated correction

**Reference implementation:** [ctxlint](https://github.com/YawLabs/ctxlint) (v0.4.0+)

---

## Table of contents

- [1. MCP Config Landscape Reference](#1-mcp-config-landscape-reference)
  - [1.1 Config format](#11-config-format)
  - [1.2 Server entry fields](#12-server-entry-fields)
  - [1.3 File locations by client](#13-file-locations-by-client)
  - [1.4 Environment variable syntax](#14-environment-variable-syntax)
  - [1.5 Override precedence](#15-override-precedence)
  - [1.6 Platform-specific behaviors](#16-platform-specific-behaviors)
- [2. Lint Rules](#2-lint-rules)
  - [2.1 mcp-schema — structural validation](#21-mcp-schema--structural-validation)
  - [2.2 mcp-security — hardcoded secrets](#22-mcp-security--hardcoded-secrets)
  - [2.3 mcp-commands — stdio command validation](#23-mcp-commands--stdio-command-validation)
  - [2.4 mcp-deprecated — deprecated patterns](#24-mcp-deprecated--deprecated-patterns)
  - [2.5 mcp-env — environment variable validation](#25-mcp-env--environment-variable-validation)
  - [2.6 mcp-urls — URL validation](#26-mcp-urls--url-validation)
  - [2.7 mcp-consistency — cross-file consistency](#27-mcp-consistency--cross-file-consistency)
  - [2.8 mcp-redundancy — unnecessary configs](#28-mcp-redundancy--unnecessary-configs)
- [3. Rule Catalog (machine-readable)](#3-rule-catalog-machine-readable)
- [4. Implementing This Specification](#4-implementing-this-specification)
- [5. Contributing](#5-contributing)

---

## 1. MCP Config Landscape Reference

This section documents the full MCP server configuration landscape as of April 2026. Implementors should treat this as the authoritative cross-client reference for file locations, formats, and behaviors.

### 1.1 Config format

Every MCP config file is a JSON object with a root key containing named server entries. Each server entry describes how the client connects to one MCP server.

There are two active transport types:

**stdio** — the client launches a local subprocess and communicates over stdin/stdout using JSON-RPC:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "@example/mcp-server"],
      "env": { "DEBUG": "true" }
    }
  }
}
```

**Streamable HTTP** — the client connects to a remote URL over HTTP:

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

**SSE (Server-Sent Events)** — deprecated as of the March 2025 MCP spec update. Uses `"type": "sse"`. Still supported by most clients but should be migrated to Streamable HTTP.

### 1.2 Server entry fields

| Field | Type | Transport | Required | Description |
|---|---|---|---|---|
| `type` | `"stdio"` \| `"http"` \| `"sse"` | All | No | Transport protocol. Defaults to `stdio` if `command` is present. |
| `command` | string | stdio | Yes | Executable to launch as a subprocess. |
| `args` | string[] | stdio | No | Arguments passed to the command. |
| `env` | Record<string, string> | stdio | No | Environment variables for the subprocess. |
| `url` | string | http, sse | Yes | Remote endpoint URL. |
| `headers` | Record<string, string> | http, sse | No | HTTP headers sent with every request. |
| `disabled` | boolean | All | No | Whether the server is disabled. (Cline-specific) |
| `autoApprove` | string[] | All | No | Tool names to auto-approve without user confirmation. (Cline-specific) |
| `timeout` | number (ms) | All | No | Max response wait time. Default: 60000. (Amazon Q-specific) |
| `oauth` | object | http | No | OAuth 2.0 configuration. (Claude Code-specific) |
| `headersHelper` | string | http | No | Shell command that outputs JSON headers to stdout. (Claude Code-specific) |

### 1.3 File locations by client

#### Project-level configs

These live relative to the project root and are typically committed to version control.

| File path | Client | Root key | Notes |
|---|---|---|---|
| `.mcp.json` | Claude Code | `mcpServers` | The universal project-level convention. |
| `.cursor/mcp.json` | Cursor | `mcpServers` | |
| `.vscode/mcp.json` | VS Code / GitHub Copilot | **`servers`** | Only client that uses `servers` instead of `mcpServers`. |
| `.amazonq/mcp.json` | Amazon Q Developer | `mcpServers` | Server names must be unique across project + global. |
| `.continue/mcpServers/*.json` | Continue.dev | varies | Accepts config files from any client format. |

#### User/global-level configs

These are user-specific and not committed to version control.

| File path | Client | Root key | Platform |
|---|---|---|---|
| `~/.claude.json` | Claude Code | `mcpServers` | All |
| `~/.claude/settings.json` | Claude Code | `mcpServers` | All |
| `~/.cursor/mcp.json` | Cursor | `mcpServers` | All |
| `~/Library/Application Support/Claude/claude_desktop_config.json` | Claude Desktop | `mcpServers` | macOS |
| `%APPDATA%\Claude\claude_desktop_config.json` | Claude Desktop | `mcpServers` | Windows |
| `~/.codeium/windsurf/mcp_config.json` | Windsurf | `mcpServers` | All |
| `~/.aws/amazonq/mcp.json` | Amazon Q | `mcpServers` | All |
| VS Code globalStorage `saoudrizwan.claude-dev/settings/cline_mcp_settings.json` | Cline | `mcpServers` | All |

### 1.4 Environment variable syntax

Different clients use different syntax for referencing environment variables in config values.

| Client | Syntax | Default value support | Example |
|---|---|---|---|
| Claude Code | `${VAR}` | `${VAR:-default}` | `${API_KEY}` |
| Cursor | `${env:VAR}` | No | `${env:API_KEY}` |
| Continue.dev | `${{ secrets.VAR }}` | No | `${{ secrets.API_KEY }}` |
| Windsurf | `${env:VAR}` | No | `${env:API_KEY}` |
| Claude Desktop | Not supported | N/A | Literal values only |
| Amazon Q | Not supported | N/A | Literal values only |

Env var expansion applies to `command`, `args`, `env`, `url`, and `headers` fields (where supported).

### 1.5 Override precedence

When the same server name exists at multiple scopes, the most specific scope wins.

**Claude Code** (three-tier):
1. **Local** (highest) — per-user, per-project overrides in `~/.claude.json` under a project path key
2. **Project** — `.mcp.json` at the repo root
3. **User** (lowest) — `~/.claude.json` top-level `mcpServers`

**Cursor:** project `.cursor/mcp.json` overrides global `~/.cursor/mcp.json`.

**Amazon Q:** workspace `.amazonq/mcp.json` overrides global `~/.aws/amazonq/mcp.json`. Server names must be unique across both.

**VS Code:** workspace `.vscode/mcp.json` overrides user-level configuration.

**Windsurf, Cline:** Single global config. No override behavior.

### 1.6 Platform-specific behaviors

**Windows + npx (stdio):** On native Windows (not WSL), `npx` commands must be wrapped with `cmd /c`:
```json
{
  "command": "cmd",
  "args": ["/c", "npx", "-y", "@example/mcp-server"]
}
```
Without this wrapper, the subprocess fails to spawn. This is the most common Windows MCP config issue.

**Claude.ai custom connectors:** Only support remote MCP servers over Streamable HTTP. No stdio support — browsers cannot launch local subprocesses. stdio-only servers must be hosted remotely to be used with Claude.ai.

---

## 2. Lint Rules

23 rules organized into 8 categories. Each rule has a unique ID, severity level, trigger condition, and message template.

Severity levels:
- **error** — the config is broken or has a security issue. Should fail CI.
- **warning** — the config has a likely problem. May or may not fail CI depending on strictness.
- **info** — the config has a potential improvement. Never fails CI.

### 2.1 mcp-schema — structural validation

Validates that the config file is well-formed JSON with the correct structure for its target client.

| Rule ID | Severity | Trigger | Message |
|---|---|---|---|
| `mcp-schema/invalid-json` | error | File is not valid JSON | `MCP config is not valid JSON: {parseError}` |
| `mcp-schema/wrong-root-key` | error | Root key doesn't match expected key for the client | `{file} must use "{expected}" as root key, not "{actual}"` |
| `mcp-schema/missing-root-key` | error | No recognized root key (`mcpServers` or `servers`) | `MCP config has no "{expected}" key` |
| `mcp-schema/missing-command` | error | stdio server has no `command` field | `Server "{name}": missing "command" field` |
| `mcp-schema/missing-url` | error | http/sse server has no `url` field | `Server "{name}": missing "url" field` |
| `mcp-schema/unknown-transport` | warning | `type` field is not `stdio`, `http`, or `sse` | `Server "{name}": unknown transport type "{type}"` |
| `mcp-schema/ambiguous-transport` | warning | Server has both `command` and `url` fields | `Server "{name}": has both "command" and "url" — transport is ambiguous` |
| `mcp-schema/empty-servers` | info | Root key exists but contains no server entries | `MCP config has no server entries` |

**Auto-fixable:** `wrong-root-key` — rename the root key to match the expected key.

### 2.2 mcp-security — hardcoded secrets

Detects secrets committed to version control in MCP config files. Only flags issues in git-tracked files.

| Rule ID | Severity | Trigger | Message |
|---|---|---|---|
| `mcp-security/hardcoded-bearer` | error | `Authorization` header contains a literal Bearer token (not an env var reference) in a git-tracked file | `Server "{name}": hardcoded Bearer token in a git-tracked file` |
| `mcp-security/hardcoded-api-key` | error | Header or env value matches known API key patterns in a git-tracked file | `Server "{name}": possible API key in a git-tracked file` |
| `mcp-security/secret-in-url` | error | URL contains query params that look like secrets (`?key=`, `?token=`, `?api_key=`) in a git-tracked file | `Server "{name}": possible secret in URL query string` |
| `mcp-security/http-no-tls` | warning | URL uses `http://` for non-localhost target | `Server "{name}": URL uses HTTP without TLS` |

**Known API key patterns:**
```
sk-[a-zA-Z0-9]{20,}            # OpenAI / generic
ghp_[a-zA-Z0-9]{36}            # GitHub personal access token
ghu_[a-zA-Z0-9]{36}            # GitHub user token
github_pat_[a-zA-Z0-9_]{80,}   # GitHub fine-grained PAT
xoxb-[0-9]{10,}                # Slack bot token
xoxp-[0-9]{10,}                # Slack user token
AKIA[0-9A-Z]{16}               # AWS access key ID
glpat-[a-zA-Z0-9_\-]{20}       # GitLab personal access token
sq0atp-[a-zA-Z0-9_\-]{22}      # Square access token
shpat_[a-fA-F0-9]{32}          # Shopify admin API token
```

Also flag any string value > 20 characters that is entirely alphanumeric or base64 characters AND is not an env var reference (`${...}`, `${{ ... }}`).

**Auto-fixable:** `hardcoded-bearer`, `hardcoded-api-key` — replace literal value with an env var reference derived from the server name (e.g., `MY_SERVER_API_KEY`).

### 2.3 mcp-commands — stdio command validation

Validates that stdio server commands and file-path arguments are viable.

| Rule ID | Severity | Trigger | Message |
|---|---|---|---|
| `mcp-commands/windows-npx-no-wrapper` | error | Platform is Windows and `command` is `npx` without `cmd /c` wrapper | `Server "{name}": npx requires "cmd /c" wrapper on Windows` |
| `mcp-commands/command-not-found` | warning | `command` is a relative path (`./`, `../`) that doesn't exist | `Server "{name}": command "{command}" not found` |
| `mcp-commands/args-path-missing` | warning | An arg matches a file path pattern and the file doesn't exist | `Server "{name}": arg "{arg}" references a missing file` |

**Notes:**
- `windows-npx-no-wrapper` should only flag project-level configs, not global configs (the user may be developing cross-platform).
- `args-path-missing` should only check args that look like file paths (contain `/` with a file extension, or start with `./` / `../`). Skip npm package names and flags.
- Do not validate that system commands (`npx`, `node`, `python`) exist on PATH — that is a runtime concern, not a config concern.

**Auto-fixable:** `windows-npx-no-wrapper` — rewrite `{"command": "npx", "args": [...]}` to `{"command": "cmd", "args": ["/c", "npx", ...]}`.

### 2.4 mcp-deprecated — deprecated patterns

Flags usage of deprecated MCP transport protocols and patterns.

| Rule ID | Severity | Trigger | Message |
|---|---|---|---|
| `mcp-deprecated/sse-transport` | warning | Server uses `"type": "sse"` | `Server "{name}": SSE transport is deprecated — use "http" (Streamable HTTP)` |

**Auto-fixable:** `sse-transport` — replace `"sse"` with `"http"`.

### 2.5 mcp-env — environment variable validation

Validates environment variable references for correctness and client compatibility.

| Rule ID | Severity | Trigger | Message |
|---|---|---|---|
| `mcp-env/wrong-syntax` | error | Env var reference uses wrong syntax for the target client | `Server "{name}": {client} uses {expected}, not {actual}` |
| `mcp-env/unset-variable` | info | Referenced env var is not set in the current environment | `Server "{name}": environment variable "{var}" is not set` |
| `mcp-env/empty-env-block` | info | `env` object is present but empty | `Server "{name}": empty "env" block can be removed` |

**Syntax validation matrix:**

| Config file | Expected syntax | Flag if found |
|---|---|---|
| `.mcp.json` | `${VAR}` | `${env:VAR}` |
| `.cursor/mcp.json` | `${env:VAR}` | `${VAR}` (bare, without `env:`) |
| `.continue/mcpServers/*.json` | `${{ secrets.VAR }}` | `${VAR}` or `${env:VAR}` |
| All others | `${VAR}` | — |

**Notes:**
- `unset-variable` is intentionally `info` severity. Many env vars are set only in CI, `.env` files, or shell profiles that aren't available during linting.
- Scan all string values in `command`, `args`, `url`, `headers`, and `env` for env var references.

**Auto-fixable:** `wrong-syntax` — rewrite to the correct syntax for the target client.

### 2.6 mcp-urls — URL validation

Validates remote server URLs for correctness and team usability.

| Rule ID | Severity | Trigger | Message |
|---|---|---|---|
| `mcp-urls/malformed` | error | URL is not parseable (after skipping env var placeholders) | `Server "{name}": invalid URL` |
| `mcp-urls/localhost-in-project-config` | warning | `localhost` or `127.0.0.1` URL in a git-tracked project config | `Server "{name}": localhost URL in project config won't work for teammates` |
| `mcp-urls/missing-path` | info | URL has no path or just `/` | `Server "{name}": URL has no path — most MCP servers expect /mcp` |

**Notes:**
- If the URL contains env var references (`${...}`), skip `malformed` — it cannot be validated statically.
- `localhost-in-project-config` should only flag project-scoped files, not global configs where localhost is expected.

### 2.7 mcp-consistency — cross-file consistency

Compares MCP configs across multiple files in the same project. This is a cross-file check that runs after all individual configs are parsed.

| Rule ID | Severity | Trigger | Message |
|---|---|---|---|
| `mcp-consistency/same-server-different-config` | warning | Server with the same name exists in 2+ config files with different URLs or commands | `Server "{name}" is configured differently in {file1} and {file2}` |
| `mcp-consistency/duplicate-server-name` | warning | Same server name appears more than once in a single file | `Duplicate server name "{name}" in {file} — only the last definition is used` |
| `mcp-consistency/missing-from-client` | info | Server exists in `.mcp.json` but is absent from another client's project config that also exists | `Server "{name}" is in .mcp.json but missing from {file}` |

**Notes:**
- For `same-server-different-config`, compare `url`/`command`/`args`. Ignore `headers` differences (auth tokens intentionally differ per user).
- `missing-from-client` is informational only. Teams may intentionally have different server sets per client.

### 2.8 mcp-redundancy — unnecessary configs

Flags configs that may be unnecessary or stale.

| Rule ID | Severity | Trigger | Message |
|---|---|---|---|
| `mcp-redundancy/disabled-server` | info | Server has `"disabled": true` | `Server "{name}" is disabled — consider removing if no longer needed` |
| `mcp-redundancy/identical-across-scopes` | info | Same server with identical config at both project and global scope | `Server "{name}" is identically configured in {projectFile} and {globalFile}` |

---

## 3. Rule Catalog (machine-readable)

A machine-readable JSON catalog of all rules is available at [`mcp-config-lint-rules.json`](./mcp-config-lint-rules.json).

The catalog enables:
- AI agents to understand what rules exist and when they apply
- Tool authors to import rule definitions programmatically
- CI systems to configure which rules to enable/disable
- Documentation generators to stay in sync with the rule set

See the JSON file for the full schema.

---

## 4. Implementing This Specification

This specification is designed to be implementable by any tool. Here is how the pieces map to a typical linter architecture:

### Discovery

Scan for the project-level config files listed in [Section 1.3](#13-file-locations-by-client). Optionally scan global/user-level configs when the user opts in (these contain personal data and should not be scanned by default).

### Parsing

Parse JSON and normalize into a common structure regardless of which client's format the file uses. Key normalization steps:
1. Detect the client from the file path
2. Determine the expected root key (`servers` for VS Code, `mcpServers` for all others)
3. Infer transport type from fields: `command` present = stdio, `url` present = http/sse, explicit `type` field takes precedence
4. Extract server entries into a uniform shape

### Checking

Run per-file checks (schema, security, commands, deprecated, env, urls, redundancy) independently per config file. Run cross-file checks (consistency) after all files are parsed.

### Reporting

Rules use the `category/rule-id` naming convention (e.g., `mcp-security/hardcoded-bearer`). This maps cleanly to SARIF rule IDs for GitHub Code Scanning integration.

### Fixing

Rules marked as auto-fixable should apply surgical string replacements to the JSON file without reformatting the user's style (indentation, trailing commas, key ordering). Validate that the result is still valid JSON after applying fixes.

---

## 5. Contributing

This specification is maintained at [github.com/YawLabs/ctxlint](https://github.com/YawLabs/ctxlint).

To propose changes:
- **New rules:** Open an issue describing the rule, its severity, trigger condition, and which clients it applies to.
- **Client additions:** As new MCP clients emerge, submit a PR adding their config file location, root key, and any client-specific behaviors to Section 1.
- **Corrections:** If any client behavior documented here is inaccurate, open an issue with evidence (link to client docs, source code, or reproduction steps).

### Versioning

This specification follows semver:
- **Patch** (1.0.x): Typo fixes, clarifications, no rule changes
- **Minor** (1.x.0): New rules added, new clients documented
- **Major** (x.0.0): Rules removed or semantics changed in breaking ways

### Related specifications and tools

- [Model Context Protocol Specification](https://spec.modelcontextprotocol.io/) — the underlying protocol this config format serves
- [ctxlint](https://github.com/YawLabs/ctxlint) — reference implementation of this specification
- [mcp-compliance](https://github.com/YawLabs/mcp-compliance) — tests MCP server *behavior* against the protocol spec (complementary to config linting)
- [mcp.hosting](https://mcp.hosting) — managed MCP server hosting (eliminates many config issues by providing remote endpoints)
