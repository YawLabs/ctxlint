import type { ParsedMcpConfig, LintIssue } from '../../types.js';

export async function checkMcpSchema(
  config: ParsedMcpConfig,
  _projectRoot: string,
): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];

  // invalid-json: parse errors
  if (config.parseErrors.length > 0) {
    for (const err of config.parseErrors) {
      issues.push({
        severity: 'error',
        check: 'mcp-schema',
        ruleId: 'invalid-json',
        line: 1,
        message: `MCP config is not valid JSON: ${err}`,
      });
    }
    return issues; // can't check further
  }

  // missing-root-key
  if (!config.actualRootKey) {
    issues.push({
      severity: 'error',
      check: 'mcp-schema',
      ruleId: 'missing-root-key',
      line: 1,
      message: `MCP config has no "${config.expectedRootKey}" key`,
    });
    return issues;
  }

  // wrong-root-key
  if (config.actualRootKey !== config.expectedRootKey) {
    const line = findKeyLine(config.content, config.actualRootKey);
    issues.push({
      severity: 'error',
      check: 'mcp-schema',
      ruleId: 'wrong-root-key',
      line,
      message: `${config.relativePath} must use "${config.expectedRootKey}" as root key, not "${config.actualRootKey}"`,
      fix: {
        file: config.filePath,
        line,
        oldText: `"${config.actualRootKey}"`,
        newText: `"${config.expectedRootKey}"`,
      },
    });
  }

  // empty-servers
  if (config.servers.length === 0 && config.actualRootKey) {
    issues.push({
      severity: 'info',
      check: 'mcp-schema',
      ruleId: 'empty-servers',
      line: 1,
      message: 'MCP config has no server entries',
    });
    return issues;
  }

  // Per-server checks
  for (const server of config.servers) {
    // no-name-field (empty key)
    if (!server.name) {
      issues.push({
        severity: 'error',
        check: 'mcp-schema',
        ruleId: 'no-name-field',
        line: server.line,
        message: 'Server name cannot be empty',
      });
      continue;
    }

    // unknown-transport
    if (server.transport === 'unknown') {
      const typeVal = server.raw.type;
      if (typeof typeVal === 'string') {
        issues.push({
          severity: 'warning',
          check: 'mcp-schema',
          ruleId: 'unknown-transport',
          line: server.line,
          message: `Server "${server.name}" has unknown transport type "${typeVal}"`,
        });
      }
    }

    // ambiguous-transport: has both command and url
    if (server.command && server.url) {
      issues.push({
        severity: 'warning',
        check: 'mcp-schema',
        ruleId: 'ambiguous-transport',
        line: server.line,
        message: `Server "${server.name}" has both "command" and "url" — transport is ambiguous`,
      });
    }

    // missing-command: stdio server without command
    if (server.transport === 'stdio' && !server.command) {
      issues.push({
        severity: 'error',
        check: 'mcp-schema',
        ruleId: 'missing-command',
        line: server.line,
        message: `Server "${server.name}" has no "command" field`,
      });
    }

    // missing-url: http/sse server without url
    if ((server.transport === 'http' || server.transport === 'sse') && !server.url) {
      issues.push({
        severity: 'error',
        check: 'mcp-schema',
        ruleId: 'missing-url',
        line: server.line,
        message: `Server "${server.name}" has no "url" field`,
      });
    }
  }

  return issues;
}

function findKeyLine(content: string, key: string): number {
  const lines = content.split('\n');
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`"${escaped}"\\s*:`);
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) {
      return i + 1;
    }
  }
  return 1;
}
