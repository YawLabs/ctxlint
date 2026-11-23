import type { ParsedMcpConfig, LintIssue } from '../../types.js';
import { isLoopbackHost } from './loopback.js';

const ENV_VAR_REF = /\$\{[^}]+\}/;

const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'ws:', 'wss:']);

/**
 * The URL as safe to echo in a finding: query string and fragment (where
 * `?token=` / `#access_token=` ride) and any `user:pass@` userinfo replaced
 * with `...`. Works on the raw string because the URL is by definition one
 * `new URL` rejected. Userinfo is taken per `/`-segment, which also catches a
 * malformed scheme (`http//u:p@host`, `https:/u:p@host`).
 */
function redactUrlForDisplay(url: string): string {
  const cut = url.search(/[?#]/);
  const head = cut === -1 ? url : `${url.slice(0, cut + 1)}...`;
  return head
    .split('/')
    .map((seg) => {
      const at = seg.lastIndexOf('@');
      return at > 0 ? `...${seg.slice(at)}` : seg;
    })
    .join('/');
}

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

    // malformed-url. `new URL` accepts any scheme, so a scheme-less
    // "localhost:3000/mcp" parses with protocol "localhost:" -- no client
    // can connect to that. Only the web schemes an MCP transport speaks
    // count as well-formed.
    let parsed: URL | null;
    try {
      parsed = new URL(server.url);
    } catch {
      parsed = null;
    }
    if (!parsed || !ALLOWED_PROTOCOLS.has(parsed.protocol)) {
      issues.push({
        severity: 'error',
        check: 'mcp-urls',
        ruleId: 'mcp-urls/malformed-url',
        line: server.line,
        message: `Server "${server.name}": invalid URL "${redactUrlForDisplay(server.url)}"`,
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
