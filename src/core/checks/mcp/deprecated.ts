import type { ParsedMcpConfig, LintIssue } from '../../types.js';

export async function checkMcpDeprecated(
  config: ParsedMcpConfig,
  _projectRoot: string,
): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];

  if (config.parseErrors.length > 0) return issues;

  for (const server of config.servers) {
    // sse-transport: flag deprecated SSE transport
    if (server.transport === 'sse') {
      const line = findTypeLine(config.content, server.line) || server.line;
      issues.push({
        severity: 'warning',
        check: 'mcp-deprecated',
        ruleId: 'mcp-deprecated/sse-transport',
        line,
        message: `Server "${server.name}" uses deprecated SSE transport — use "http" (Streamable HTTP) instead`,
        fix: {
          file: config.filePath,
          line,
          oldText: '"sse"',
          newText: '"http"',
        },
      });
    }
  }

  return issues;
}

/**
 * Locate the `"type": "sse"` line inside one server's object. Anchors at the
 * parser-attributed server line rather than re-scanning for the name from
 * line 0 -- a name-based scan anchored on the wrong occurrence (a top-level
 * key or another server's nested key sharing the name) starts brace-tracking
 * in the wrong object and returns null or a different server's type line.
 */
function findTypeLine(content: string, serverLine: number): number | null {
  const lines = content.split('\n');
  const serverStart = serverLine - 1; // serverLine is 1-indexed
  if (serverStart < 0 || serverStart >= lines.length) return null;

  // Track brace depth to stay within this server's object
  let depth = 0;
  let enteredObject = false;
  for (let i = serverStart; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') {
        depth++;
        enteredObject = true;
      } else if (ch === '}') {
        depth--;
        if (enteredObject && depth === 0) return null; // left the server object
      }
    }
    // Match the JSON key-value pair shape, not two free-floating substrings --
    // a server whose body happens to contain `"type"` as a value-side label
    // and `"sse"` somewhere else on the same line used to false-positive.
    if (enteredObject && /"type"\s*:\s*"sse"/.test(lines[i])) {
      return i + 1;
    }
  }
  return null;
}
