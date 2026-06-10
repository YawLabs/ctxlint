import type { ParsedMcpConfig, LintIssue } from '../../types.js';
import { isLoopbackHost } from './loopback.js';

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
        ruleId: 'mcp-urls/malformed-url',
        line: server.line,
        message: `Server "${server.name}": invalid URL "${server.url}"`,
      });
      continue;
    }

    // localhost-in-project-config: the full loopback set (localhost, [::1],
    // 127.0.0.0/8) -- the same set http-no-tls exempts, so a loopback URL in
    // a committed config can't slip through both rules.
    if (config.scope === 'project' && isLoopbackHost(parsed.hostname)) {
      issues.push({
        severity: 'warning',
        check: 'mcp-urls',
        ruleId: 'mcp-urls/localhost-in-project-config',
        line: server.line,
        message: `Server "${server.name}": loopback URL in project config won't work for teammates`,
      });
    }

    // missing-path
    if (!parsed.pathname || parsed.pathname === '/') {
      issues.push({
        severity: 'info',
        check: 'mcp-urls',
        ruleId: 'mcp-urls/missing-path',
        line: server.line,
        message: `Server "${server.name}": URL has no path — most MCP servers expect /mcp`,
      });
    }
  }

  return issues;
}
