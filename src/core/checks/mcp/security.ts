import type { ParsedMcpConfig, LintIssue } from '../../types.js';
import { isLoopbackHost } from './loopback.js';

// Known API key patterns (high-entropy + known prefixes)
const API_KEY_PATTERNS = [
  // sk- keys need [_-] in the class: modern OpenAI (sk-proj-...) and Anthropic
  // (sk-ant-api03-...) keys carry interior hyphens that would otherwise stop
  // the match short of the length floor. The leading \b keeps the run from
  // starting mid-word ("whisk-", "desk-").
  /\bsk-ant-[A-Za-z0-9_-]{20,}/, // Anthropic
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/, // OpenAI (classic or project-scoped) / generic
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

// Variable name keywords that indicate the value is intended to be a secret.
// We only run the high-entropy heuristic when the env var name matches one of
// these -- otherwise build IDs, commit SHAs, version strings, and feature-flag
// tokens get caught as false positives.
const SECRET_NAME_KEYWORDS = [
  'KEY',
  'TOKEN',
  'SECRET',
  'PASSWORD',
  'PASSWD',
  'PASS',
  'AUTH',
  'CREDENTIAL',
  'CREDENTIALS',
  'APIKEY',
  'PRIVATE',
  'SIGNING',
  'SESSION',
  'COOKIE',
];

function isEnvVarRef(value: string): boolean {
  return ENV_VAR_REF.test(value);
}

function isKnownApiKey(value: string): boolean {
  return API_KEY_PATTERNS.some((p) => p.test(value));
}

function nameSuggestsSecret(name: string): boolean {
  const upper = name.toUpperCase();
  return SECRET_NAME_KEYWORDS.some((kw) => upper.includes(kw));
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

  // Skip if there were parse errors
  if (config.parseErrors.length > 0) return issues;

  // The three secret rules (hardcoded-bearer / hardcoded-api-key /
  // secret-in-url) only fire in git-tracked files: an untracked config leaks
  // nothing to teammates. http-no-tls is a transport concern, independent of
  // tracking, and runs unconditionally below.
  const checkSecrets = config.isGitTracked;

  for (const server of config.servers) {
    // Check headers for hardcoded bearer tokens
    if (checkSecrets && server.headers) {
      for (const [headerName, headerValue] of Object.entries(server.headers)) {
        // One finding per header: a Bearer token that already got the
        // hardcoded-bearer error (with its fix) must not double-report
        // through the known-pattern rule.
        let flaggedBearer = false;
        if (headerName.toLowerCase() === 'authorization') {
          const bearerMatch = headerValue.match(/^Bearer\s+(.+)$/i);
          if (bearerMatch) {
            const token = bearerMatch[1];
            if (!isEnvVarRef(token)) {
              const envVar = deriveEnvVarName(server.name, 'API_KEY');
              issues.push({
                severity: 'error',
                check: 'mcp-security',
                ruleId: 'mcp-security/hardcoded-bearer',
                line: server.line,
                message: `Server "${server.name}" has a hardcoded Bearer token in a git-tracked file`,
                fix: {
                  file: config.filePath,
                  line: server.line,
                  oldText: `Bearer ${token}`,
                  newText: `Bearer \${${envVar}}`,
                },
              });
              flaggedBearer = true;
            }
          }
        }

        // Check for known API key patterns in any header value
        if (!flaggedBearer && !isEnvVarRef(headerValue) && isKnownApiKey(headerValue)) {
          issues.push({
            severity: 'error',
            check: 'mcp-security',
            ruleId: 'mcp-security/hardcoded-api-key',
            line: server.line,
            message: `Server "${server.name}" has a hardcoded API key in a git-tracked file`,
          });
        }
      }
    }

    // Check env values for hardcoded secrets
    if (checkSecrets && server.env) {
      for (const [envName, envValue] of Object.entries(server.env)) {
        // Known API key patterns (sk-, ghp_, AKIA, etc.) always flag.
        // High-entropy heuristic only fires when the variable name suggests a
        // secret -- avoids false positives on BUILD_ID, *_VERSION, *_COMMIT, etc.
        const isSecret =
          isKnownApiKey(envValue) || (nameSuggestsSecret(envName) && isHighEntropySecret(envValue));
        if (!isEnvVarRef(envValue) && isSecret) {
          const envVar = deriveEnvVarName(server.name, 'API_KEY');
          issues.push({
            severity: 'error',
            check: 'mcp-security',
            ruleId: 'mcp-security/hardcoded-api-key',
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
    if (
      checkSecrets &&
      server.url &&
      !isEnvVarRef(server.url) &&
      URL_SECRET_PARAMS.test(server.url)
    ) {
      issues.push({
        severity: 'error',
        check: 'mcp-security',
        ruleId: 'mcp-security/secret-in-url',
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
          if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
            issues.push({
              severity: 'warning',
              check: 'mcp-security',
              ruleId: 'mcp-security/http-no-tls',
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
