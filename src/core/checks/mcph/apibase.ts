import type { LintIssue, ParsedMchpConfig } from '../../types.js';

// RFC 1918 + loopback ranges where plaintext HTTP is typically dev-only
// and warranted. Keep this intentionally conservative — warning on HTTP
// for any public host, silent for local.
const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^::1$/,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /\.local$/i,
  /\.internal$/i,
  /\.test$/i,
  /\.example$/i,
];

function isPrivateHost(hostname: string): boolean {
  return PRIVATE_HOST_PATTERNS.some((p) => p.test(hostname));
}

export async function checkMcphApibase(
  config: ParsedMchpConfig,
  _projectRoot: string,
): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];
  if (config.parseErrors.length > 0) return issues;

  const pos = config.positions.apiBase;
  const value = typeof config.raw?.apiBase === 'string' ? config.raw.apiBase : null;
  if (!pos || value === null) return issues;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    issues.push({
      severity: 'error',
      check: 'mcph-apibase',
      ruleId: 'mcph-config/invalid-apibase',
      line: pos.line,
      message: `"apiBase" is not a valid URL: ${value}`,
      suggestion: `Use an absolute http(s) URL, e.g. "https://mcp.hosting".`,
    });
    return issues;
  }

  // --- Rule: mcph-config/insecure-apibase ---
  if (parsed.protocol === 'http:' && !isPrivateHost(parsed.hostname)) {
    issues.push({
      severity: 'warning',
      check: 'mcph-apibase',
      ruleId: 'mcph-config/insecure-apibase',
      line: pos.line,
      message: `"apiBase" uses plaintext HTTP to a public host (${parsed.hostname})`,
      suggestion:
        `Use https:// instead. Plaintext HTTP exposes your MCPH_TOKEN on the wire.\n` +
        `Private hosts (localhost, 10.*, 192.168.*, 172.16-31.*, *.local, *.internal) are allowed without TLS for dev workflows.`,
    });
  }

  return issues;
}
