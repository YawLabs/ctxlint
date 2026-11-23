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
- 29 lint rules organized into 8 categories with defined severities
- A machine-readable rule catalog ([`mcp-config-lint-rules.json`](./mcp-config-lint-rules.json))
- Auto-fix definitions for rules that support automated correction

**Reference implementation:** [ctxlint](https://github.com/YawLabs/ctxlint) (v0.4.0+)

---

## Related specifications

This spec is part of a family of open specifications maintained by Yaw Labs for MCP tooling:

| Spec                                                                                               | Scope                                      | Input                                                     |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------- |
| **mcp-config-lint** (this spec)                                                                    | Static analysis of MCP client config files | `.cursor/mcp.json`, `.vscode/mcp.json`, `.mcp.json`, etc. |
| [**mcp-compliance**](https://github.com/YawLabs/mcp-compliance/blob/master/MCP_COMPLIANCE_SPEC.md) | Runtime testing of live MCP servers        | A live server URL + transport                             |

The two are **complementary, not overlapping**. `mcp-config-lint` catches problems before deploy by reading JSON on disk; `mcp-compliance` catches problems after deploy by speaking the protocol to a running server. A production setup typically runs both.

Both specs target MCP spec version `2025-11-25` and ship machine-readable rule catalogs with stable rule IDs.

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

| Field           | Type                             | Transport | Required | Description                                                               |
| --------------- | -------------------------------- | --------- | -------- | ------------------------------------------------------------------------- |
| `type`          | `"stdio"` \| `"http"` \| `"sse"` | All       | No       | Transport protocol. Defaults to `stdio` if `command` is present.          |
| `command`       | string                           | stdio     | Yes      | Executable to launch as a subprocess.                                     |
| `args`          | string[]                         | stdio     | No       | Arguments passed to the command.                                          |
| `env`           | Record<string, string>           | stdio     | No       | Environment variables for the subprocess.                                 |
| `url`           | string                           | http, sse | Yes      | Remote endpoint URL.                                                      |
| `headers`       | Record<string, string>           | http, sse | No       | HTTP headers sent with every request.                                     |
| `disabled`      | boolean                          | All       | No       | Whether the server is disabled. (Cline-specific)                          |
| `autoApprove`   | string[]                         | All       | No       | Tool names to auto-approve without user confirmation. (Cline-specific)    |
| `timeout`       | number (ms)                      | All       | No       | Max response wait time. Default: 60000. (Amazon Q-specific)               |
| `oauth`         | object                           | http      | No       | OAuth 2.0 configuration. (Claude Code-specific)                           |
| `headersHelper` | string                           | http      | No       | Shell command that outputs JSON headers to stdout. (Claude Code-specific) |

### 1.3 File locations by client

#### Project-level configs

These live relative to the project root and are typically committed to version control.

| File path                     | Client                   | Root key      | Notes                                                    |
| ----------------------------- | ------------------------ | ------------- | -------------------------------------------------------- |
| `.mcp.json`                   | Claude Code              | `mcpServers`  | The universal project-level convention.                  |
| `.cursor/mcp.json`            | Cursor                   | `mcpServers`  |                                                          |
| `.vscode/mcp.json`            | VS Code / GitHub Copilot | **`servers`** | Only client that uses `servers` instead of `mcpServers`. |
| `.amazonq/mcp.json`           | Amazon Q Developer       | `mcpServers`  | Server names must be unique across project + global.     |
| `.continue/mcpServers/*.json` | Continue.dev             | varies        | Accepts config files from any client format.             |

#### User/global-level configs

These are user-specific and not committed to version control.

| File path                                                                                   | Client         | Root key     | Platform |
| ------------------------------------------------------------------------------------------- | -------------- | ------------ | -------- |
| `~/.claude.json` (top-level `mcpServers`, plus per-project `projects["<path>"].mcpServers`) | Claude Code    | `mcpServers` | All      |
| `~/.claude/settings.json`                                                                   | Claude Code    | `mcpServers` | All      |
| `~/.cursor/mcp.json`                                                                        | Cursor         | `mcpServers` | All      |
| `~/Library/Application Support/Claude/claude_desktop_config.json`                           | Claude Desktop | `mcpServers` | macOS    |
| `%APPDATA%\Claude\claude_desktop_config.json`                                               | Claude Desktop | `mcpServers` | Windows  |
| `~/.codeium/windsurf/mcp_config.json`                                                       | Windsurf       | `mcpServers` | All      |
| `~/.aws/amazonq/mcp.json`                                                                   | Amazon Q       | `mcpServers` | All      |
| VS Code globalStorage `saoudrizwan.claude-dev/settings/cline_mcp_settings.json`             | Cline          | `mcpServers` | All      |
| `~/.cline/data/settings/cline_mcp_settings.json` (or `$CLINE_MCP_SETTINGS_PATH`)            | Cline CLI      | `mcpServers` | All      |
| `~/.continue/config.yaml`                                                                   | Continue.dev   | `mcpServers` | All      |

**Notes on global configs (reference implementation, `--mcp-global`):**

- With `CLAUDE_CONFIG_DIR` set, Claude Code keeps `settings.json` in that directory, and `.claude.json` is read from it too, falling back to `~/.claude.json`.
- `~/.claude.json` and `settings.json` are general Claude Code files, so they are linted only when they hold MCP servers: a top-level `mcpServers` (either file), or a non-empty `projects.*.mcpServers` (`~/.claude.json`, where a plain `claude mcp add` writes local-scope servers).
- Cline is detected by a `saoudrizwan.claude-dev/` path or a file named `cline_mcp_settings.json`.
- Continue's global `config.yaml` is YAML and is not linted; its project `.continue/mcpServers/*.json` files are.

### 1.4 Environment variable syntax

Different clients use different syntax for referencing environment variables in config values.

| Client         | Syntax               | Default value support | Example                  |
| -------------- | -------------------- | --------------------- | ------------------------ |
| Claude Code    | `${VAR}`             | `${VAR:-default}`     | `${API_KEY}`             |
| Cursor         | `${env:VAR}`         | No                    | `${env:API_KEY}`         |
| VS Code        | `${env:VAR}`         | No                    | `${env:API_KEY}`         |
| Continue.dev   | `${{ secrets.VAR }}` | No                    | `${{ secrets.API_KEY }}` |
| Windsurf       | `${env:VAR}`         | No                    | `${env:API_KEY}`         |
| Claude Desktop | Not supported        | N/A                   | Literal values only      |
| Amazon Q       | Not supported        | N/A                   | Literal values only      |
| Cline          | Not supported        | N/A                   | Literal values only      |

Some clients also expand their own built-in variables, which are not environment references: Cursor's `${userHome}`, `${workspaceFolder}`, `${workspaceFolderBasename}`, `${pathSeparator}` (and `${/}`), and VS Code's predefined variables.

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

**Windows + package runners (stdio):** On native Windows (not WSL), `npx`, `bunx`, `pnpm` and `pnpx` are `.cmd` shims that cannot be spawned without a shell, so they must be wrapped with `cmd /c`:

```json
{
  "command": "cmd",
  "args": ["/c", "npx", "-y", "@example/mcp-server"]
}
```

Without this wrapper, the subprocess fails to spawn. This is the most common Windows MCP config issue. The same wrapper breaks the server for macOS and Linux users, so whether a committed config should carry it depends on who runs it.

**Claude.ai custom connectors:** Only support remote MCP servers over Streamable HTTP. No stdio support — browsers cannot launch local subprocesses. stdio-only servers must be hosted remotely to be used with Claude.ai.

---

## 2. Lint Rules

29 rules organized into 8 categories. Each rule has a unique ID, severity level, trigger condition, and message template.

Severity levels:

- **error** — the config is broken or has a security issue. Should fail CI.
- **warning** — the config has a likely problem. May or may not fail CI depending on strictness.
- **info** — the config has a potential improvement. Never fails CI.

### 2.1 mcp-schema — structural validation

Validates that the config file is well-formed JSON with the correct structure for its target client.

| Rule ID                          | Severity | Trigger                                                                                                                                                                 | Message                                                                                                                                                                                                                                                                                             |
| -------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp-schema/invalid-json`        | error    | File does not parse (JSONC for `.vscode/mcp.json`, strict JSON elsewhere)                                                                                               | `MCP config is not valid JSON: {errorCode} at line {line} column {column}`                                                                                                                                                                                                                          |
| `mcp-schema/wrong-root-key`      | error    | Root key doesn't match expected key for the client                                                                                                                      | `{file} must use "{expected}" as root key, not "{actual}"`                                                                                                                                                                                                                                          |
| `mcp-schema/missing-root-key`    | error    | No recognized top-level root key (`mcpServers` or `servers`); not reported for `~/.claude.json`                                                                         | `MCP config has no "{expected}" key`                                                                                                                                                                                                                                                                |
| `mcp-schema/missing-command`     | error    | stdio server has no `command` field, or a `command` that is not a string                                                                                                | `Server "{name}" has no "command" field` (non-string: `Server "{name}": "command" must be a string, not {type}`)                                                                                                                                                                                    |
| `mcp-schema/missing-url`         | error    | http/sse server has no `url` field                                                                                                                                      | `Server "{name}" has no "url" field`                                                                                                                                                                                                                                                                |
| `mcp-schema/no-name-field`       | error    | A server entry's key (its name) is the empty string                                                                                                                     | `Server name cannot be empty`                                                                                                                                                                                                                                                                       |
| `mcp-schema/unknown-transport`   | warning  | Transport cannot be classified: a `type` outside `stdio`/`http`/`sse`, a non-string `type`, or an entry with neither `command` nor `url`; or the entry is not an object | `Server "{name}" has unknown transport type "{type}"` (with no classifiable fields at all: `Server "{name}" has no recognizable transport — expected "command", "url", or a valid "type"`; for a non-object entry: `Server "{name}" must be an object, not {type} — the client ignores this entry`) |
| `mcp-schema/ambiguous-transport` | warning  | Server has both `command` and `url` fields                                                                                                                              | `Server "{name}" has both "command" and "url" — transport is ambiguous`                                                                                                                                                                                                                             |
| `mcp-schema/empty-servers`       | info     | A top-level root key exists but contains no server entries                                                                                                              | `MCP config has no server entries`                                                                                                                                                                                                                                                                  |

**Notes:**

- Parse each file with the strictness of the client that reads it: VS Code reads `.vscode/mcp.json` as JSONC (comments and trailing commas allowed); every other client parses strict JSON, so a comment in `.mcp.json` is an error. Report the parse error code and position only — echoing source text can quote the start of an unquoted secret.
- `~/.claude.json` is Claude Code's general state file: its servers may live only in `projects["<path>"].mcpServers`, so `missing-root-key` is not reported for it, and `empty-servers` only when it has a top-level root key.

**Auto-fixable:** `wrong-root-key` — rename the root key to match the expected key. No fix when the expected key is also present (the rename would create a duplicate key, and JSON keeps only the last).

### 2.2 mcp-security — hardcoded secrets

Detects secrets committed to version control in MCP config files. The three secret rules (`hardcoded-bearer`, `hardcoded-api-key`, `secret-in-url`) only flag issues in git-tracked files — an untracked config leaks nothing to teammates. `mcp-security/http-no-tls` is a transport concern, independent of version control, and fires regardless of git tracking. When the tracked status cannot be determined at all (git unavailable or failing, as opposed to a determined "untracked"), the linter says so via `mcp-security/secret-scan-skipped` instead of silently passing a possibly-tracked file.

| Rule ID                            | Severity | Trigger                                                                                                                                                                                                                                                    | Message                                                                                                                     |
| ---------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `mcp-security/hardcoded-bearer`    | error    | `Authorization` or `Proxy-Authorization` header is `Bearer <credentials>` with literal credentials (not entirely env var references) in a git-tracked file                                                                                                 | `Server "{name}" has a hardcoded Bearer token in a git-tracked file`                                                        |
| `mcp-security/hardcoded-api-key`   | error    | In a git-tracked file: an `Authorization`/`Proxy-Authorization` value with a non-Bearer scheme (e.g. Basic) or no scheme; a header, env value or arg matching a known API key pattern; or a header or env value caught by the high-entropy heuristic below | `Server "{name}" has a hardcoded API key in a git-tracked file`                                                             |
| `mcp-security/secret-in-url`       | error    | URL query param that looks like a secret (`key`, `token`, `api_key`, `apikey`, `secret`, `password`, `access_token`) has a literal value, or the URL userinfo holds a literal password or a bare username that is a known token, in a git-tracked file     | `Server "{name}" has a secret in the URL query string`; for userinfo: `Server "{name}" has credentials in the URL userinfo` |
| `mcp-security/secret-scan-skipped` | info     | Git-tracked status could not be determined (git unavailable/failing — not merely untracked), so the three git-gated secret rules were skipped                                                                                                              | `Could not determine git-tracked status of {file}; hardcoded-secret rules were skipped`                                     |
| `mcp-security/http-no-tls`         | warning  | URL uses `http://` for a target that is not machine-local (machine-local = `localhost`, `localhost.`, `*.localhost`, `127.0.0.0/8`, `[::1]`, IPv4-mapped `[::ffff:127.x.x.x]`, and the bind-all `0.0.0.0` and `[::]`)                                      | `Server "{name}" uses HTTP without TLS`                                                                                     |

**Known API key patterns:**

```
sk-ant-[A-Za-z0-9_-]{20,}      # Anthropic
sk-proj-[A-Za-z0-9_-]{20,}     # OpenAI project-scoped
sk-[a-zA-Z0-9]{20,}            # OpenAI classic / generic (alphanumeric-only:
                               # [-_] would swallow kebab-case identifiers)
ghp_[a-zA-Z0-9]{36}            # GitHub personal access token
ghu_[a-zA-Z0-9]{36}            # GitHub user token
github_pat_[a-zA-Z0-9_]{80,}   # GitHub fine-grained PAT
xoxb-[0-9]{10,}                # Slack bot token
xoxp-[0-9]{10,}                # Slack user token
AKIA[0-9A-Z]{16}               # AWS access key ID
AGE-SECRET-KEY-1[a-zA-Z0-9]+   # age encryption secret key
glpat-[a-zA-Z0-9_\-]{20}       # GitLab personal access token
sq0atp-[a-zA-Z0-9_\-]{22}      # Square access token
\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}
                               # JWT (Supabase keys, API gateways)
```

**High-entropy heuristic:** additionally flag an env value or a header value (other than `Authorization`) that, once its `${...}` spans are stripped, is more than 20 characters of `[A-Za-z0-9+/=_-]`, is not a filesystem path (a home-, dot-relative, absolute or drive path with at least two segments and no `+` or `=`), AND whose name suggests a secret. The name gate is deliberate: without it, build IDs, commit SHAs, version strings, and feature-flag tokens false-positive. It matches whole name tokens (split on `_`, `-` and camelCase), not substrings, so `GIT_AUTHOR_NAME` and `KEYCHAIN_SERVICE` stay out:

- a token is one of `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `PASS`, `PASSPHRASE`, `AUTH`, `AUTHORIZATION`, `CREDENTIAL`, `CREDENTIALS`, `APIKEY`, `PRIVATE`, `SIGNING`, `SESSION`, `COOKIE`; or
- a separator-less token ends in `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `PASS`, `KEY` or `CREDENTIALS` (`GITHUBTOKEN`, `SECRETKEY`, `DBPASS`), unless it is an ordinary word (`MONKEY`, `TURKEY`, `DONKEY`, `HOCKEY`, `JOCKEY`, `WHISKEY`, `HOTKEY`, `BYPASS`, `COMPASS`, `SURPASS`, `OVERPASS`, `UNDERPASS`, `TRESPASS`, `ENCOMPASS`);
- and the name's last token is not `PATH`, `DIR`, `DIRECTORY`, `FILE`, `FILENAME`, `NAME`, `URL`, `URI`, `HOST`, `PORT` or `SERVICE` (`SSH_KEY_PATH` names where a secret lives, not the secret).

A literal next to an unrelated `${VAR}` still counts: the env-ref spans are stripped before scanning, and only a value that is entirely env references is safe.

**Auto-fixable:** `hardcoded-bearer`, `hardcoded-api-key` — replace only the literal secret with an env var reference, written in the client's own syntax (`${VAR}` for Claude Code, `${env:VAR}` for Cursor, Windsurf and VS Code, `${{ secrets.VAR }}` for Continue). The scheme, its spacing and any adjacent `${VAR}` are kept. The variable is named:

- an env secret: its own env key (`GITHUB_TOKEN` stays `GITHUB_TOKEN`);
- `Authorization: Bearer`: `<SERVER>_TOKEN`; any other `Authorization` scheme: `<SERVER>_CREDENTIALS`;
- any other header: `<SERVER>_<HEADER>` with a leading `X-` dropped (`X-API-Key` -> `<SERVER>_API_KEY`);
- an arg: after its flag (`--api-key=KEY`, `--token KEY`), else `<SERVER>_API_KEY`.

Non-alphanumerics become `_` and the name is upper-cased; two different secrets in one server that derive the same name get `_2`, `_3`; a leading digit gets a `_` prefix. The fix sits on the value's own line and column, and the finding's line is the value's line when a fix exists. There is no fix for Claude Desktop, Amazon Q or Cline (they do not interpolate env references, so a reference would break a working config), nor when the literal is split around a `${VAR}`.

### 2.3 mcp-commands — stdio command validation

Validates that stdio server commands and file-path arguments are viable.

| Rule ID                               | Severity                                                                                | Trigger                                                                                                                                 | Message                                                                 |
| ------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `mcp-commands/windows-npx-no-wrapper` | error (user/global config on a Windows host); warning (Windows-specific project config) | `command` is `npx`, `bunx`, `pnpm` or `pnpx` (optionally `.cmd`) without a `cmd /c` wrapper                                             | `Server "{name}": {command} requires "cmd /c" wrapper on Windows`       |
| `mcp-commands/command-not-found`      | warning                                                                                 | `command` is a relative path (`./`, `../`) that doesn't exist (project-scope configs only)                                              | `Server "{name}": command "{command}" not found`                        |
| `mcp-commands/args-path-missing`      | warning                                                                                 | An arg matches a file path pattern and the file doesn't exist (relative paths: project-scope configs only; absolute paths: every scope) | `Server "{name}": arg "{arg}" looks like a file path but doesn't exist` |

**Notes:**

- `windows-npx-no-wrapper` is decided per config. A user/global config belongs to the host that lints it: it is reported, as an error, on a Windows host only. A project config is shared with macOS/Linux teammates, for whom the wrapper would break the server, so it is reported (as a warning, on any host) only when its content is already Windows-specific — a drive-letter or UNC path in a command or arg, a `.exe`/`.cmd`/`.bat` command, or a `cmd`/`powershell`/`pwsh` command.
- `args-path-missing` should only check args that look like file paths (start with `./` / `../`, contain `/` with a file extension, or — on Windows hosts — are a Windows absolute path with an extension). Skip `@package` specs, any `scheme://` URI, `name:tag` image refs, and flags. Expand Cursor and VS Code's `${workspaceFolder}`, `${userHome}`, `${pathSeparator}` and `${/}` first; skip an arg with any other `${...}`.
- Do not validate that system commands (`npx`, `node`, `python`) exist on PATH — that is a runtime concern, not a config concern.

**Not auto-fixable:** `windows-npx-no-wrapper` — whether the wrapper is right depends on who runs the file. The suggestion shows the rewrite (`"command": "cmd"`, `"args": ["/c", "npx", ...]`).

### 2.4 mcp-deprecated — deprecated patterns

Flags usage of deprecated MCP transport protocols and patterns.

| Rule ID                        | Severity | Trigger                     | Message                                                                                |
| ------------------------------ | -------- | --------------------------- | -------------------------------------------------------------------------------------- |
| `mcp-deprecated/sse-transport` | warning  | Server uses `"type": "sse"` | `Server "{name}" uses deprecated SSE transport — use "http" (Streamable HTTP) instead` |

**Auto-fixable:** `sse-transport` — replace `"sse"` with `"http"`, anchored at the value's column (when the key and value sit on separate lines, only `"sse"` is replaced).

### 2.5 mcp-env — environment variable validation

Validates environment variable references for correctness and client compatibility.

| Rule ID                   | Severity | Trigger                                                   | Message                                                           |
| ------------------------- | -------- | --------------------------------------------------------- | ----------------------------------------------------------------- |
| `mcp-env/wrong-syntax`    | error    | Env var reference uses wrong syntax for the target client | `Server "{name}": {client} uses {expected}, not {actual} ({ref})` |
| `mcp-env/unset-variable`  | info     | Referenced env var is not set in the current environment  | `Server "{name}": environment variable "{var}" is not set`        |
| `mcp-env/empty-env-block` | info     | `env` object is present but empty                         | `Server "{name}": empty "env" block can be removed`               |

**Syntax validation matrix:**

| Config file                                              | Expected syntax      | Flag if found                                            |
| -------------------------------------------------------- | -------------------- | -------------------------------------------------------- |
| `.mcp.json`, `~/.claude.json`, `~/.claude/settings.json` | `${VAR}`             | `${env:VAR}`                                             |
| `.cursor/mcp.json`, `~/.cursor/mcp.json`                 | `${env:VAR}`         | `${VAR}` (bare, without `env:`), except Cursor built-ins |
| `~/.codeium/windsurf/mcp_config.json`                    | `${env:VAR}`         | `${VAR}` (bare, without `env:`)                          |
| `.continue/mcpServers/*.json`                            | `${{ secrets.VAR }}` | `${VAR}` or `${env:VAR}`                                 |
| All others (VS Code, Claude Desktop, Amazon Q, Cline)    | —                    | —                                                        |

**Notes:**

- `unset-variable` is intentionally `info` severity. Many env vars are set only in CI, `.env` files, or shell profiles that aren't available during linting.
- `unset-variable` is skipped entirely for Continue configs — their `${{ secrets.VAR }}` references resolve from Continue's own secrets store (Hub / local `.env`), not the local shell environment, so every correct Continue config would false-positive.
- `unset-variable` is not reported for `${VAR:-default}` (the default satisfies it) or for a client built-in variable.
- Scan all string values in `command`, `args`, `url`, `headers`, and `env` for env var references.

- `wrong-syntax` reports one finding per wrong reference, not one per value, with that reference appended to the message (`Server "api": Cursor uses ${env:VAR}, not ${VAR} (${WORKSPACE})`). When no fix can be built for the value, it reports one finding without the suffix.

**Auto-fixable:** `wrong-syntax` — rewrite the one wrong reference to the correct syntax for the target client at its exact line and column; literals and other references in the same value are left untouched.

### 2.6 mcp-urls — URL validation

Validates remote server URLs for correctness and team usability.

| Rule ID                                | Severity | Trigger                                                                                                                                                                       | Message                                                                              |
| -------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `mcp-urls/malformed-url`               | error    | URL is not parseable, or parses with a scheme other than `http`, `https`, `ws` or `wss` (e.g. `localhost:3000/mcp`, `file://...`); URLs with env var placeholders are skipped | `Server "{name}": invalid URL "{url}"` (query, fragment and userinfo shown as `...`) |
| `mcp-urls/localhost-in-project-config` | warning  | URL host is machine-local (the same set `http-no-tls` exempts) in a project-level config                                                                                      | `Server "{name}": loopback URL in project config won't work for teammates`           |
| `mcp-urls/missing-path`                | info     | URL has no path or just `/`                                                                                                                                                   | `Server "{name}": URL has no path — most MCP servers expect /mcp`                    |

**Notes:**

- If the URL contains env var references (`${...}`), skip `malformed-url` — it cannot be validated statically.
- `localhost-in-project-config` should only flag project-scoped files (committed to version control by convention), not global configs where loopback URLs are expected. Machine-local means `localhost`, `localhost.`, `*.localhost`, `127.0.0.0/8`, `[::1]`, IPv4-mapped `[::ffff:127.x.x.x]`, and the bind-all `0.0.0.0` and `[::]`. Treat the whole `127.0.0.0/8` block as loopback — `127.0.0.2` is just as unreachable for a teammate as `127.0.0.1`. The bind-all addresses are not loopback strictly, but as a client target they never leave the host.

### 2.7 mcp-consistency — cross-file consistency

Compares MCP configs across multiple files in the same project. This is a cross-file check that runs after all individual configs are parsed.

| Rule ID                                        | Severity | Trigger                                                                                                                                                                            | Message                                                                                                                                                                    |
| ---------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp-consistency/same-server-different-config` | warning  | Server with the same name exists in 2+ same-scope config files (project-project or user-user) with different URLs or commands — cross-scope pairs are client precedence, not drift | `Server "{name}" is configured differently in {file1} and {file2}`                                                                                                         |
| `mcp-consistency/duplicate-server-name`        | warning  | Same server name appears more than once in one servers object                                                                                                                      | `Duplicate server name "{name}" in {file} — only the last definition is used` (for a `~/.claude.json` project block, `{file}` reads `~/.claude.json (projects["<path>"])`) |
| `mcp-consistency/missing-from-client`          | info     | Server exists in `.mcp.json` but is absent from another client's project config that also exists                                                                                   | `Server "{name}" is in .mcp.json but missing from {file}`                                                                                                                  |

**Notes:**

- For `same-server-different-config`, compare `url`/`command`/`args`, after normalising env-ref syntaxes (`${env:K}`, `${{ secrets.K }}` and `${K:-d}` all equal `${K}`). Ignore `headers` differences (auth tokens intentionally differ per user). `~/.claude.json` per-project servers are excluded.
- `duplicate-server-name` is checked once per servers object; each `~/.claude.json` `projects["<path>"].mcpServers` block is its own object.
- `missing-from-client` is informational only. Teams may intentionally have different server sets per client. Configs that failed to parse are skipped.

### 2.8 mcp-redundancy — unnecessary configs

Flags configs that may be unnecessary or stale.

| Rule ID                                  | Severity | Trigger                                                            | Message                                                                            |
| ---------------------------------------- | -------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `mcp-redundancy/disabled-server`         | info     | Server has `"disabled": true`                                      | `Server "{name}" is disabled — consider removing it if no longer needed`           |
| `mcp-redundancy/identical-across-scopes` | info     | Same server with identical config at both project and global scope | `Server "{name}" is identically configured in both {projectFile} and {globalFile}` |

**Notes:**

- The `disabled` field is Cline-specific (see [Section 1.2](#12-server-entry-fields)), but `disabled-server` fires on any client's config that carries it — a stale `"disabled": true` is dead weight regardless of which client wrote it.
- `identical-across-scopes` compares `command`/`args`/`url` and `env` (order-insensitively). Of the `~/.claude.json` per-project blocks only the current project's is considered.

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

Rules marked as auto-fixable should apply surgical string replacements to the JSON file without reformatting the user's style (indentation, trailing commas, key ordering). Validate that the result still parses after applying fixes, judged against how well the original parsed (a BOM-prefixed or JSONC file must not be blamed on the fix). Never print a secret in the fix log: redact the old and new text.

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
- [mcp-compliance](https://github.com/YawLabs/mcp-compliance) — tests MCP server _behavior_ against the protocol spec (complementary to config linting)
