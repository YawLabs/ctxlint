import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ParsedMcpConfig, LintIssue } from '../../types.js';

// Pattern to detect local file paths in args
const LOCAL_PATH_PATTERN = /^\.\.?\//;
const FILE_PATH_PATTERN = /^[^-].*\/.*\.\w+$/;

export async function checkMcpCommands(
  config: ParsedMcpConfig,
  projectRoot: string,
): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];

  if (config.parseErrors.length > 0) return issues;

  for (const server of config.servers) {
    if (server.transport !== 'stdio' || !server.command) continue;

    // windows-npx-no-wrapper: only for project-level configs
    if (process.platform === 'win32' && config.scope === 'project' && server.command === 'npx') {
      // Check if already wrapped in cmd /c
      // If command is "npx" directly (not "cmd"), it needs wrapping
      issues.push({
        severity: 'error',
        check: 'mcp-commands',
        ruleId: 'windows-npx-no-wrapper',
        line: server.line,
        message: `Server "${server.name}": npx requires "cmd /c" wrapper on Windows`,
        suggestion: 'Change command to "cmd" and prepend "/c", "npx" to args: ["/c", "npx", ...]',
        fix: buildNpxFix(config, server.name, server.args),
      });
    }

    // command-not-found: local path commands
    if (LOCAL_PATH_PATTERN.test(server.command)) {
      const resolved = path.resolve(projectRoot, server.command);
      if (!fileExistsSafe(resolved)) {
        issues.push({
          severity: 'warning',
          check: 'mcp-commands',
          ruleId: 'command-not-found',
          line: server.line,
          message: `Server "${server.name}": command "${server.command}" not found`,
        });
      }
    }

    // args-path-missing: check args that look like file paths
    if (server.args) {
      for (const arg of server.args) {
        if (LOCAL_PATH_PATTERN.test(arg) || FILE_PATH_PATTERN.test(arg)) {
          const resolved = path.resolve(projectRoot, arg);
          if (!fileExistsSafe(resolved)) {
            issues.push({
              severity: 'warning',
              check: 'mcp-commands',
              ruleId: 'args-path-missing',
              line: server.line,
              message: `Server "${server.name}": arg "${arg}" looks like a file path but doesn't exist`,
            });
          }
        }
      }
    }
  }

  return issues;
}

function fileExistsSafe(filePath: string): boolean {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function buildNpxFix(
  config: ParsedMcpConfig,
  serverName: string,
  _args?: string[],
): LintIssue['fix'] {
  // The spec says to transform:
  //   {"command": "npx", "args": ["-y", "pkg"]}
  // into:
  //   {"command": "cmd", "args": ["/c", "npx", "-y", "pkg"]}
  //
  // The fixer is line-based (one replacement per fix). We target the command line
  // since that's the most critical change. The args update requires a manual edit
  // and is noted in the issue's suggestion field.
  const lines = config.content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('"command"') && line.includes('"npx"')) {
      let inRightServer = false;
      for (let j = i - 1; j >= 0; j--) {
        if (lines[j].includes(`"${serverName}"`)) {
          inRightServer = true;
          break;
        }
        if (lines[j].includes('"command"')) break;
      }
      if (!inRightServer) continue;

      return {
        file: config.filePath,
        line: i + 1,
        oldText: '"npx"',
        newText: '"cmd"',
      };
    }
  }
  return undefined;
}
