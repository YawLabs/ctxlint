import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ParsedMcpConfig, LintIssue, McpServerEntry } from '../../types.js';

// Pattern to detect local file paths in args
const LOCAL_PATH_PATTERN = /^\.\.?\//;
const FILE_PATH_PATTERN = /^[^-].*\/.*\.\w+$/;
// A Windows absolute path with a file extension (`C:\tools\server.js`,
// `D:/srv/index.js`). FILE_PATH_PATTERN needs a forward slash, so a
// backslash-only path was never checked.
const WINDOWS_ABS_FILE_PATTERN = /^[A-Za-z]:[\\/].*\.\w+$/;
const WINDOWS_ABS_PATTERN = /^[A-Za-z]:[\\/]|^\\\\[^\\]/;
// Anything with a URI scheme (`https://`, `postgresql://`, `mongodb+srv://`,
// ...) matches FILE_PATH_PATTERN's segment/segment.ext shape but is a network
// reference, not a local file. RFC 3986 scheme syntax; a drive letter can't
// match because it is followed by `:\` or `:/`, never `://`.
const URI_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
// An npm package spec (`@scope/pkg`, `@scope/pkg@1.2.3`) -- never a file.
const PACKAGE_SPEC_PATTERN = /^@/;
// A container image ref with a tag (`ghcr.io/org/image:1.2.3`): registry and
// path segments, then `:tag` after the last slash.
const IMAGE_REF_PATTERN = /^[\w.-]+(?::\d+)?(?:\/[\w.-]+)+:[\w][\w.-]{0,127}$/;

// Package runners that are .cmd shims on Windows: spawned without a shell
// they fail (Node refuses to spawn .cmd/.bat directly), so they need the
// `cmd /c` wrapper.
const SHIM_RUNNER_PATTERN = /^(npx|bunx|pnpm|pnpx)(\.cmd)?$/i;

export async function checkMcpCommands(
  config: ParsedMcpConfig,
  projectRoot: string,
): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];

  if (config.parseErrors.length > 0) return issues;

  const npxSeverity = windowsNpxSeverity(config);

  for (const server of config.servers) {
    if (server.transport !== 'stdio' || !server.command) continue;

    // windows-npx-no-wrapper. Host-independent for committed files: a project
    // config is shared with Mac/Linux teammates, and the `cmd /c` rewrite
    // would break them -- so it fires on a project file only when the file is
    // Windows-specific by its own content (see windowsNpxSeverity), and then
    // as a warning. A user/global config belongs to this host, so there the
    // host OS decides, as an error.
    //
    // A runner already wrapped via `command: 'cmd'` + `args: ['/c', 'npx',
    // ...]` has `command === 'cmd'` and is skipped by the pattern test.
    // No autofix: whether the wrapper is right depends on who runs the file.
    if (npxSeverity && SHIM_RUNNER_PATTERN.test(server.command)) {
      issues.push({
        severity: npxSeverity,
        check: 'mcp-commands',
        ruleId: 'mcp-commands/windows-npx-no-wrapper',
        line: server.line,
        message: `Server "${server.name}": ${server.command} requires "cmd /c" wrapper on Windows`,
        suggestion: `Change "command" to "cmd" and prepend "/c", "${server.command}" to args — e.g. "args": ["/c", "${server.command}", ...]`,
      });
    }

    // command-not-found: local path commands. Project scope only -- the
    // command is always relative here (LOCAL_PATH_PATTERN), and a user/global
    // config's relative paths resolve against that client's own working
    // directory, not this project's root, so resolving them here produces
    // spurious misses (same rationale as args-path-missing below).
    if (config.scope === 'project' && LOCAL_PATH_PATTERN.test(server.command)) {
      const resolved = path.resolve(projectRoot, server.command);
      if (!fileExistsSafe(resolved)) {
        issues.push({
          severity: 'warning',
          check: 'mcp-commands',
          ruleId: 'mcp-commands/command-not-found',
          line: server.line,
          message: `Server "${server.name}": command "${server.command}" not found`,
        });
      }
    }

    // args-path-missing: check args that look like file paths. Relative paths
    // are project scope only -- a user/global config's relative paths resolve
    // against that client's own working directory, not this project's root,
    // so resolving them here produces spurious misses. Absolute paths are
    // cwd-independent, so they get the existence check at every scope.
    if (server.args) {
      for (const arg of server.args) {
        const candidate = expandClientVariables(arg, config, projectRoot);
        if (candidate === null) continue;
        if (!looksLikeFilePath(candidate)) continue;
        const windowsAbs = WINDOWS_ABS_PATTERN.test(candidate);
        // A drive-letter path can only be resolved on a Windows host.
        if (windowsAbs && process.platform !== 'win32') continue;
        if (config.scope !== 'project' && !windowsAbs && !path.isAbsolute(candidate)) continue;
        const resolved = path.resolve(projectRoot, candidate);
        if (!fileExistsSafe(resolved)) {
          issues.push({
            severity: 'warning',
            check: 'mcp-commands',
            ruleId: 'mcp-commands/args-path-missing',
            line: server.line,
            message: `Server "${server.name}": arg "${arg}" looks like a file path but doesn't exist`,
          });
        }
      }
    }
  }

  return issues;
}

function looksLikeFilePath(arg: string): boolean {
  if (URI_PATTERN.test(arg) || PACKAGE_SPEC_PATTERN.test(arg) || IMAGE_REF_PATTERN.test(arg)) {
    return false;
  }
  return (
    LOCAL_PATH_PATTERN.test(arg) ||
    FILE_PATH_PATTERN.test(arg) ||
    WINDOWS_ABS_FILE_PATTERN.test(arg)
  );
}

/**
 * Expand the predefined variables Cursor and VS Code resolve in MCP args
 * (`${workspaceFolder}`, `${userHome}`, `${pathSeparator}` / `${/}`) so the
 * path can be checked. Returns null when a reference is left that can't be
 * resolved here (env vars, `${input:...}`, `${workspaceFolder}` outside a
 * project config) -- resolving `${HOME}/x.js` literally against the project
 * root is a guaranteed false miss.
 */
function expandClientVariables(
  arg: string,
  config: ParsedMcpConfig,
  projectRoot: string,
): string | null {
  if (!arg.includes('${')) return arg;
  if (config.client !== 'cursor' && config.client !== 'vscode') return null;
  let unresolved = false;
  const expanded = arg.replace(/\$\{([^}]*)\}/g, (match, name: string) => {
    if (name === 'workspaceFolder' && config.scope === 'project') return projectRoot;
    if (name === 'userHome') return os.homedir();
    if (name === 'pathSeparator' || name === '/') return path.sep;
    unresolved = true;
    return match;
  });
  return unresolved ? null : expanded;
}

/**
 * Severity for windows-npx-no-wrapper in this config, or null when it
 * should not fire. A user/global config is this host's own: error on a
 * Windows host, nothing elsewhere. A project config fires (as a warning)
 * only when its content is already Windows-specific -- a drive-letter or UNC
 * path, a .exe/.cmd/.bat command, or a cmd/PowerShell wrapper -- because
 * then everyone who runs it is on Windows anyway.
 */
function windowsNpxSeverity(config: ParsedMcpConfig): 'error' | 'warning' | null {
  if (config.scope !== 'project') return process.platform === 'win32' ? 'error' : null;
  return config.servers.some(hasWindowsEvidence) ? 'warning' : null;
}

function hasWindowsEvidence(server: McpServerEntry): boolean {
  const command = server.command;
  if (command) {
    if (/^(cmd|powershell|pwsh)(\.exe)?$/i.test(command)) return true;
    if (/\.(exe|cmd|bat)$/i.test(command)) return true;
    if (WINDOWS_ABS_PATTERN.test(command)) return true;
  }
  return (server.args ?? []).some((a) => WINDOWS_ABS_PATTERN.test(a));
}

function fileExistsSafe(filePath: string): boolean {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}
