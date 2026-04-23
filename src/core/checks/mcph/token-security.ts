import type { LintIssue, ParsedMchpConfig } from '../../types.js';

// Authoritative PAT format from yaw/mcph/schemas/mcph.config.v1.json.
const TOKEN_PATTERN = /^mcp_pat_[A-Za-z0-9_-]+$/;

const EXPORT_EXAMPLES = [
  '  bash/zsh:    export MCPH_TOKEN="mcp_pat_***"',
  '  fish:        set -x MCPH_TOKEN "mcp_pat_***"',
  '  PowerShell:  $env:MCPH_TOKEN = "mcp_pat_***"',
  "  direnv:      echo 'export MCPH_TOKEN=mcp_pat_***' >> .envrc",
].join('\n');

export interface TokenSecurityOptions {
  // Upgrade prefer-env-token from warning → error. Enables the "env var only"
  // posture: a token in any .mcph.json (even ~/.mcph.json) is a lint error.
  strictEnvToken?: boolean;
}

export async function checkMcphTokenSecurity(
  config: ParsedMchpConfig,
  _projectRoot: string,
  options: TokenSecurityOptions = {},
): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];

  if (config.parseErrors.length > 0) return issues;

  const tokenPos = config.positions.token;
  const tokenValue = typeof config.raw?.token === 'string' ? config.raw.token : null;

  // --- Rule: mcph-config/invalid-token-format ---
  if (tokenPos && tokenValue !== null && !TOKEN_PATTERN.test(tokenValue)) {
    issues.push({
      severity: 'error',
      check: 'mcph-token-security',
      ruleId: 'mcph-config/invalid-token-format',
      line: tokenPos.line,
      message: `"token" does not match expected format ^mcp_pat_[A-Za-z0-9_-]+$`,
      suggestion:
        `Check that the token was copied in full. A valid mcp.hosting PAT looks like: mcp_pat_aBcDeFg123...\n` +
        `If the token was truncated or wrapped in quotes elsewhere, re-issue it from https://mcp.hosting/settings/tokens.`,
    });
  }

  // --- Rule: mcph-config/token-in-project-scope ---
  // Project-scope + git-tracked + token present = live PAT at risk of leak.
  if (tokenPos && tokenValue !== null && config.scope === 'project' && config.isGitTracked) {
    issues.push({
      severity: 'error',
      check: 'mcph-token-security',
      ruleId: 'mcph-config/token-in-project-scope',
      line: tokenPos.line,
      message: `"token" in a git-tracked project-scope .mcph.json — PAT will leak via git history`,
      suggestion:
        `Delete line ${tokenPos.line} (the "token" field) from ${config.relativePath}.\n` +
        `Then pick one:\n` +
        `  • user-global:   move it to ~/.mcph.json instead\n` +
        `  • machine-local: move it to .mcph.local.json (and add that file to .gitignore)\n` +
        `  • env var:       export MCPH_TOKEN in your shell — the mcph CLI reads it automatically\n` +
        `If this token was already committed, ROTATE it now: https://mcp.hosting/settings/tokens\n` +
        `(Deleting the line does not purge the value from git history.)`,
    });
  }

  // --- Rule: mcph-config/prefer-env-token ---
  // Token in any file-scope triggers this. Default warning; configurable error.
  // Skipped if token-in-project-scope already fired on the same field (avoid
  // double-counting the same bad line) — that rule's remediation already
  // covers the env-var path.
  const alreadyFlaggedAsProjectLeak =
    tokenPos && tokenValue !== null && config.scope === 'project' && config.isGitTracked;

  if (tokenPos && tokenValue !== null && !alreadyFlaggedAsProjectLeak) {
    const severity = options.strictEnvToken ? 'error' : 'warning';
    issues.push({
      severity,
      check: 'mcph-token-security',
      ruleId: 'mcph-config/prefer-env-token',
      line: tokenPos.line,
      message: `prefer MCPH_TOKEN env var over a file-stored token in ${config.relativePath}`,
      suggestion:
        `Delete line ${tokenPos.line} (the "token" field) and export instead:\n` +
        EXPORT_EXAMPLES +
        `\nTokens in files survive backups, screen shares, cloud sync (Time Machine, Dropbox, OneDrive), and editor indexing.`,
    });
  }

  return issues;
}
