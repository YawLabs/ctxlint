import type { ParsedMcpConfig, LintIssue } from '../../types.js';

const ENV_VAR_REF = /\$\{[^}]+\}/;

export async function checkMcpUrls(
  config: ParsedMcpConfig,
  _projectRoot: string,
): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];

  if (config.parseErrors.length > 0) return issues;

  for (const server of config.servers) {
    if (!server.url) continue;

    // Skip URL validation if it contains env var references
    if (ENV_VAR_REF.test(server.url)) continue;

    // malformed-url
    let parsed: URL;
    try {
      parsed = new URL(server.url);
    } catch {
      issues.push({
        severity: 'error',
        check: 'mcp-urls',
        ruleId: 'malformed-url',
        line: server.line,
        message: `Server "${server.name}": invalid URL "${server.url}"`,
      });
      continue;
    }

    // localhost-in-project-config
    if (
      config.scope === 'project' &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
    ) {
      issues.push({
        severity: 'warning',
        check: 'mcp-urls',
        ruleId: 'localhost-in-project-config',
        line: server.line,
        message: `Server "${server.name}": localhost URL in project config won't work for teammates`,
      });
    }

    // missing-path
    if (!parsed.pathname || parsed.pathname === '/') {
      issues.push({
        severity: 'info',
        check: 'mcp-urls',
        ruleId: 'missing-path',
        line: server.line,
        message: `Server "${server.name}": URL has no path — most MCP servers expect /mcp`,
      });
    }
  }

  return issues;
}
