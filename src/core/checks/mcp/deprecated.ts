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
  let inServer = false;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(`"${serverName}"`)) {
      inServer = true;
    }
    if (inServer && lines[i].includes('"type"') && lines[i].includes('"sse"')) {
      return i + 1;
    }
    // If we hit another server name at the same nesting level, stop
    if (inServer && i > 0 && lines[i].match(/^\s{4}"\w/) && !lines[i].includes(`"${serverName}"`)) {
      // Rough heuristic: if we see another top-level key inside mcpServers, stop
      const indent = lines[i].search(/\S/);
      const serverIndent = lines.findIndex((l) => l.includes(`"${serverName}"`));
      if (serverIndent >= 0) {
        const origIndent = lines[serverIndent].search(/\S/);
        if (indent <= origIndent) break;
      }
    }
  }
  return null;
}
