import type { ParsedMcpConfig, LintIssue } from '../../types.js';

// Known API key patterns (high-entropy + known prefixes)
const API_KEY_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/, // OpenAI / generic
  /ghp_[a-zA-Z0-9]{36}/, // GitHub PAT
  /ghu_[a-zA-Z0-9]{36}/, // GitHub user token
  /github_pat_[a-zA-Z0-9_]{80,}/, // GitHub fine-grained PAT
  /xoxb-[0-9]{10,}/, // Slack bot
  /xoxp-[0-9]{10,}/, // Slack user
  /AKIA[0-9A-Z]{16}/, // AWS access key
  /AGE-SECRET-KEY-1[a-zA-Z0-9]+/, // age encryption key
  /glpat-[a-zA-Z0-9_\-]{20}/, // GitLab PAT
  /sq0atp-[a-zA-Z0-9_\-]{22}/, // Square
];

// Match any env var reference syntax: ${VAR}, ${env:VAR}, ${{ secrets.VAR }}
const ENV_VAR_REF = /\$\{[^}]+\}/;

// High-entropy string: >20 chars, all alphanumeric/base64
const HIGH_ENTROPY_PATTERN = /^[A-Za-z0-9+/=_-]{21,}$/;

// URL secret query params
const URL_SECRET_PARAMS = /[?&](key|token|api_key|apikey|secret|password|access_token)=/i;

function isEnvVarRef(value: string): boolean {
  return ENV_VAR_REF.test(value);
}

function isKnownApiKey(value: string): boolean {
  return API_KEY_PATTERNS.some((p) => p.test(value));
}

function isHighEntropySecret(value: string): boolean {
  if (isEnvVarRef(value)) return false;
  return HIGH_ENTROPY_PATTERN.test(value);
}

function deriveEnvVarName(serverName: string, suffix: string): string {
  return (
    serverName
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .toUpperCase()
      .replace(/^_|_$/g, '') +
    '_' +
    suffix
  );
}

export async function checkMcpSecurity(
  config: ParsedMcpConfig,
  _projectRoot: string,
): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];

  // Only flag in git-tracked files
  if (!config.isGitTracked) return issues;

  // Skip if there were parse errors
  if (config.parseErrors.length > 0) return issues;

  for (const server of config.servers) {
    // Check headers for hardcoded bearer tokens
    if (server.headers) {
      for (const [headerName, headerValue] of Object.entries(server.headers)) {
        if (headerName.toLowerCase() === 'authorization') {
          const bearerMatch = headerValue.match(/^Bearer\s+(.+)$/i);
          if (bearerMatch) {
            const token = bearerMatch[1];
            if (!isEnvVarRef(token)) {
              const envVar = deriveEnvVarName(server.name, 'API_KEY');
              issues.push({
                severity: 'error',
                check: 'mcp-security',
                ruleId: 'hardcoded-bearer',
                line: server.line,
                message: `Server "${server.name}" has a hardcoded Bearer token in a git-tracked file`,
                fix: {
                  file: config.filePath,
                  line: server.line,
                  oldText: `Bearer ${token}`,
                  newText: `Bearer \${${envVar}}`,
                },
              });
            }
          }
        }

        // Check for known API key patterns in any header value
        if (!isEnvVarRef(headerValue) && isKnownApiKey(headerValue)) {
          issues.push({
            severity: 'error',
            check: 'mcp-security',
            ruleId: 'hardcoded-api-key',
            line: server.line,
            message: `Server "${server.name}" has a hardcoded API key in a git-tracked file`,
          });
        }
      }
    }

    // Check env values for hardcoded secrets
    if (server.env) {
      for (const envValue of Object.values(server.env)) {
        if (!isEnvVarRef(envValue) && (isKnownApiKey(envValue) || isHighEntropySecret(envValue))) {
          const envVar = deriveEnvVarName(server.name, 'API_KEY');
          issues.push({
            severity: 'error',
            check: 'mcp-security',
            ruleId: 'hardcoded-api-key',
            line: server.line,
            message: `Server "${server.name}" has a hardcoded API key in a git-tracked file`,
            fix: {
              file: config.filePath,
              line: server.line,
              oldText: envValue,
              newText: `\${${envVar}}`,
            },
          });
        }
      }
    }

    // Check URL for secrets in query params
    if (server.url && !isEnvVarRef(server.url) && URL_SECRET_PARAMS.test(server.url)) {
      issues.push({
        severity: 'error',
        check: 'mcp-security',
        ruleId: 'secret-in-url',
        line: server.line,
        message: `Server "${server.name}" has a secret in the URL query string`,
      });
    }

    // Check URL for non-TLS (http:// for non-localhost)
    if (server.url) {
      try {
        // Only check if URL doesn't contain env var refs
        if (!isEnvVarRef(server.url)) {
          const parsed = new URL(server.url);
          if (
            parsed.protocol === 'http:' &&
            parsed.hostname !== 'localhost' &&
            parsed.hostname !== '127.0.0.1' &&
            parsed.hostname !== '::1'
          ) {
            issues.push({
              severity: 'warning',
              check: 'mcp-security',
              ruleId: 'http-no-tls',
              line: server.line,
              message: `Server "${server.name}" uses HTTP without TLS`,
            });
          }
        }
      } catch {
        // URL parse error handled by mcp-urls check
      }
    }
  }

  return issues;
}
