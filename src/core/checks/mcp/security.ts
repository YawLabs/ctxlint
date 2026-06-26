import type { ParsedMcpConfig, LintIssue } from '../../types.js';
import { isLoopbackHost } from './loopback.js';

// Known API key patterns (high-entropy + known prefixes)
const API_KEY_PATTERNS = [
  // The prefixed sk- forms need [_-] in the class: modern OpenAI (sk-proj-...)
  // and Anthropic (sk-ant-api03-...) keys carry interior hyphens that would
  // otherwise stop the match short of the length floor. The generic sk- form
  // must stay alphanumeric-only: with [-_] it would swallow any kebab-case
  // identifier starting with "sk-" (e.g. sk-canary-deployment-2026) and feed
  // a non-secret to the destructive env-var autofix. The leading \b keeps the
  // run from starting mid-word ("whisk-", "desk-").
  /\bsk-ant-[A-Za-z0-9_-]{20,}/, // Anthropic
  /\bsk-proj-[A-Za-z0-9_-]{20,}/, // OpenAI project-scoped
  /\bsk-[a-zA-Z0-9]{20,}/, // OpenAI classic / generic
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

// URL secret query params. The value group captures everything up to the next
// `&` or end-of-string so the scan can tell a literal secret from an env ref:
// a param is only safe when ITS OWN value is entirely an env ref, not when
// some unrelated ${VAR} sits elsewhere in the url.
const URL_SECRET_PARAMS = /[?&](key|token|api_key|apikey|secret|password|access_token)=([^&]*)/gi;

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

// Strip every ${...} span out of a value so the residue can be scanned for a
// LITERAL secret. A stray ${UNUSED} sitting next to a real key must not gate
// the whole value as "safe" -- only the secret-bearing portion being itself an
// env ref makes it safe. Used by the bearer / header / env / url scans below.
function stripEnvVarRefs(value: string): string {
  return value.replace(/\$\{[^}]*\}/g, '');
}

// True when the url carries a secret query param (key/token/api_key/...)
// whose value is a LITERAL -- i.e. not entirely an env ref. A param whose
// value is exactly `${VAR}` strips to empty and is treated as safe, but a
// param with a hardcoded value still fires even when some OTHER param in the
// url is an env ref.
function hasLiteralSecretUrlParam(url: string): boolean {
  URL_SECRET_PARAMS.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_SECRET_PARAMS.exec(url)) !== null) {
    const value = match[2];
    if (stripEnvVarRefs(value).length > 0) return true;
  }
  return false;
}

function isKnownApiKey(value: string): boolean {
  return API_KEY_PATTERNS.some((p) => p.test(value));
}

// Return the first known-API-key substring in value, or null. Used by the args
// scan to build a precise fix (replace just the literal key, not the whole
// arg, so a `--flag=KEY` arg keeps its flag).
function findKnownApiKey(value: string): string | null {
  for (const p of API_KEY_PATTERNS) {
    const m = value.match(p);
    if (m) return m[0];
  }
  return null;
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

  // When tracking could not be DETERMINED (git unavailable/failing, distinct
  // from a determined "untracked"), the gate above skipped blind -- say so at
  // info severity instead of silently passing a possibly-tracked file.
  if (!checkSecrets && config.gitTrackedUnknown) {
    issues.push({
      severity: 'info',
      check: 'mcp-security',
      ruleId: 'mcp-security/secret-scan-skipped',
      line: 1,
      message: `Could not determine git-tracked status of ${config.relativePath}; hardcoded-secret rules were skipped`,
      suggestion:
        'Verify git is available and the file is not tracked, or re-run inside the repository',
    });
  }

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
            // Safe only when the token is ENTIRELY an env ref: stripping the
            // ${...} spans leaves nothing but whitespace. A literal token next
            // to a stray ${VAR} still has residue here, so it still flags.
            if (stripEnvVarRefs(token).trim().length > 0) {
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

        // Check for known API key patterns in any header value. Scan the
        // residue with env refs stripped: a literal key next to an unrelated
        // ${VAR} must still flag (whole-value env-ref gating would skip it).
        if (!flaggedBearer && isKnownApiKey(stripEnvVarRefs(headerValue))) {
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
        // Scan the residue with ${...} spans stripped: a literal key sitting
        // next to an unrelated ${VAR} must still flag (whole-value env-ref
        // gating would skip it). isHighEntropySecret already self-gates on a
        // pure env ref, so a bare ${VAR} residue ('') stays safe.
        const scanned = stripEnvVarRefs(envValue);
        // Known API key patterns (sk-, ghp_, AKIA, etc.) always flag.
        // High-entropy heuristic only fires when the variable name suggests a
        // secret -- avoids false positives on BUILD_ID, *_VERSION, *_COMMIT, etc.
        const isSecret =
          isKnownApiKey(scanned) || (nameSuggestsSecret(envName) && isHighEntropySecret(scanned));
        if (isSecret) {
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

    // Check CLI args for hardcoded secrets. A literal token can ride in an
    // arg as `--flag=value` (one array element) or `--flag value` (the value
    // is its own element) -- substring-scanning each arg for a known key
    // catches both forms. Env refs are stripped first for consistency with the
    // header/env scans; the fix replaces only the matched literal so a
    // `--flag=KEY` arg keeps its flag.
    if (checkSecrets && server.args) {
      for (const arg of server.args) {
        if (!isKnownApiKey(stripEnvVarRefs(arg))) continue;
        const key = findKnownApiKey(arg);
        if (!key) continue;
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
            oldText: key,
            newText: `\${${envVar}}`,
          },
        });
      }
    }

    // Check URL for secrets in query params. Scan each secret param's own
    // value so a hardcoded api_key beside a trailing env ref (e.g.
    // ?api_key=lit&ws=${WS}) still fires -- whole-url env-ref gating skipped it
    // entirely. A param whose value is itself an env ref (?token=${TOK}) is
    // treated as safe.
    if (checkSecrets && server.url && hasLiteralSecretUrlParam(server.url)) {
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
