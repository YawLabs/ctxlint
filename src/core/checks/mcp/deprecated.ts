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
      const match = findTypeLine(config.content, server.line);
      const line = match?.line ?? server.line;
      const issue: LintIssue = {
        severity: 'warning',
        check: 'mcp-deprecated',
        ruleId: 'mcp-deprecated/sse-transport',
        line,
        message: `Server "${server.name}" uses deprecated SSE transport — use "http" (Streamable HTTP) instead`,
      };
      // Only emit a fix when we located the actual `"type": "sse"` pair.
      // The fix's oldText is the FULL matched pair (with the file's original
      // whitespace), not a bare `"sse"` -- the fixer does a replaceAll of
      // oldText against the located line, so a bare `"sse"` would also rewrite
      // a description value or another `"sse"` token sharing that line.
      if (match) {
        issue.fix = {
          file: config.filePath,
          line: match.line,
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
 * Locate the `"type": "sse"` pair inside one server's object. Anchors at the
 * parser-attributed server line rather than re-scanning for the name from
 * line 0 -- a name-based scan anchored on the wrong occurrence (a top-level
 * key or another server's nested key sharing the name) starts brace-tracking
 * in the wrong object and returns null or a different server's type line.
 *
 * Returns the 1-indexed line AND the verbatim matched text (the file's
 * original whitespace between `"type"`, the colon, and `"sse"`). The caller
 * uses that exact text as the fix's oldText so the replaceAll the fixer does
 * is anchored to the real type pair, not a bare `"sse"` token that could also
 * appear as a description value on the same line.
 */
function findTypeLine(content: string, serverLine: number): { line: number; text: string } | null {
  const lines = content.split('\n');
  const serverStart = serverLine - 1; // serverLine is 1-indexed
  if (serverStart < 0 || serverStart >= lines.length) return null;

  // Track brace depth to stay within this server's object
  let depth = 0;
  let enteredObject = false;
  const typePair = /"type"\s*:\s*"sse"/;
  for (let i = serverStart; i < lines.length; i++) {
    // Match the JSON key-value pair shape (not two free-floating substrings --
    // a `"type"` value-label plus a stray `"sse"` on the same line used to
    // false-positive) BEFORE walking this line's braces. The pair can share its
    // line with the object's closing `}` (`"type": "sse" }`); a brace walk that
    // returns null at depth 0 would otherwise exit before the match is checked.
    // The pair is always at depth >= 1 (a direct child of the server object),
    // so a match on a scanned line is genuinely inside the object.
    if (enteredObject || i === serverStart) {
      const m = typePair.exec(lines[i]);
      if (m) {
        return { line: i + 1, text: m[0] };
      }
    }
    for (const ch of lines[i]) {
      if (ch === '{') {
        depth++;
        enteredObject = true;
      } else if (ch === '}') {
        depth--;
        if (enteredObject && depth === 0) return null; // left the server object
      }
    }
  }
  return null;
}
