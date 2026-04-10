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
      const line = findTypeLine(config.content, server.name) || server.line;
      issues.push({
        severity: 'warning',
        check: 'mcp-deprecated',
        ruleId: 'sse-transport',
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

function findTypeLine(content: string, serverName: string): number | null {
  const lines = content.split('\n');
  const escaped = serverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const namePattern = new RegExp(`"${escaped}"\\s*:`);

  // Find the line where this server's object starts
  let serverStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (namePattern.test(lines[i])) {
      serverStart = i;
      break;
    }
  }
  if (serverStart === -1) return null;

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
    if (enteredObject && lines[i].includes('"type"') && lines[i].includes('"sse"')) {
      return i + 1;
    }
  }
  return null;
}
