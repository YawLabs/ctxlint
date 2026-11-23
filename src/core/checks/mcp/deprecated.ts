import { locateServerValue } from '../../mcp-parser.js';
import type { ParsedMcpConfig, LintIssue, McpServerEntry } from '../../types.js';

export async function checkMcpDeprecated(
  config: ParsedMcpConfig,
  _projectRoot: string,
): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];

  if (config.parseErrors.length > 0) return issues;

  for (const server of config.servers) {
    // sse-transport: flag deprecated SSE transport
    if (server.transport === 'sse') {
      const match = findTypeFix(config, server);
      const issue: LintIssue = {
        severity: 'warning',
        check: 'mcp-deprecated',
        ruleId: 'mcp-deprecated/sse-transport',
        line: match?.line ?? server.line,
        message: `Server "${server.name}" uses deprecated SSE transport — use "http" (Streamable HTTP) instead`,
      };
      // Only emit a fix when we located the actual `"type": "sse"` value.
      if (match) {
        issue.fix = {
          file: config.filePath,
          line: match.line,
          column: match.column,
          oldText: match.text,
          newText: match.text.replace(/"sse"$/, '"http"'),
        };
      }
      issues.push(issue);
    }
  }

  return issues;
}

/**
 * Locate this server's `"type": "sse"` in the source via the parser's
 * syntax tree -- string-aware, so braces inside a string value can't end the
 * search early, and anchored on the server's own object, so a top-level key or
 * another server's nested key sharing the name can't be picked instead.
 *
 * Returns the 1-indexed line and column plus the verbatim text to replace:
 * the whole `"type": "sse"` pair (with the file's original whitespace) when
 * key and value share a line, else just the `"sse"` value. The column anchors
 * the fixer to exactly this occurrence, so a `"sse"` description value on the
 * same line is never rewritten.
 */
function findTypeFix(
  config: ParsedMcpConfig,
  server: McpServerEntry,
): { line: number; column: number; text: string } | null {
  const loc = locateServerValue(config, server, ['type']);
  if (!loc || loc.text !== '"sse"') return null;
  const lineText = config.content.split('\n')[loc.line - 1] ?? '';
  const before = /"type"\s*:\s*$/.exec(lineText.slice(0, loc.column - 1));
  if (before) {
    return {
      line: loc.line,
      column: before.index + 1,
      text: lineText.slice(before.index, loc.column - 1 + loc.text.length),
    };
  }
  return loc;
}
