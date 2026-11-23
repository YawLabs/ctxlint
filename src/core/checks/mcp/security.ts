import type { ParsedMcpConfig, LintIssue, McpServerEntry, FixAction } from '../../types.js';
import { locateServerValue } from '../../mcp-parser.js';
import { formatEnvRef } from './env.js';
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
  // JWT (Supabase anon/service keys, many API gateways): base64url header and
  // payload both start with `{"` -> `eyJ`. The dots keep it out of the
  // high-entropy class, so without this pattern it was never flagged.
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
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

// `scheme://userinfo@` -- userinfo stops at the first / ? # of the authority.
const URL_USERINFO = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)@/i;

// Name tokens (split on `_`, `-`, other separators and camelCase humps) that
// say the value is meant to be a secret. We only run the high-entropy
// heuristic when a name matches -- otherwise build IDs, commit SHAs, version
// strings, and feature-flag tokens get caught as false positives. Matching
// whole tokens, not substrings, keeps GIT_AUTHOR_NAME (AUTHOR) and
// KEYCHAIN_SERVICE (KEYCHAIN) out.
const SECRET_NAME_TOKENS: ReadonlySet<string> = new Set([
  'KEY',
  'TOKEN',
  'SECRET',
  'PASSWORD',
  'PASSWD',
  'PASS',
  'PASSPHRASE',
  'AUTH',
  'AUTHORIZATION',
  'CREDENTIAL',
  'CREDENTIALS',
  'APIKEY',
  'PRIVATE',
  'SIGNING',
  'SESSION',
  'COOKIE',
]);

// A separator-less compound (GITHUBTOKEN, OPENAIAPIKEY, SECRETKEY, DBPASS)
// still counts when it ENDS in one of these. KEY and PASS also end ordinary
// words, so those few are listed in NON_SECRET_COMPOUNDS below instead of
// dropping the suffix (which would miss ACCESSKEY, PRIVATEKEY, AUTHKEY...).
const SECRET_NAME_SUFFIXES = [
  'TOKEN',
  'SECRET',
  'PASSWORD',
  'PASSWD',
  'PASS',
  'KEY',
  'CREDENTIALS',
];

// Whole tokens that end in a secret suffix but are ordinary words.
const NON_SECRET_COMPOUNDS: ReadonlySet<string> = new Set([
  'MONKEY',
  'TURKEY',
  'DONKEY',
  'HOCKEY',
  'JOCKEY',
  'WHISKEY',
  'HOTKEY',
  'BYPASS',
  'COMPASS',
  'SURPASS',
  'OVERPASS',
  'UNDERPASS',
  'TRESPASS',
  'ENCOMPASS',
]);

// A last token that names something ABOUT a secret rather than the secret
// itself: SSH_KEY_PATH, SESSION_STORE_DIR, KEYCHAIN_SERVICE, TOKEN_URL.
const NON_SECRET_NAME_SUFFIXES: ReadonlySet<string> = new Set([
  'PATH',
  'DIR',
  'DIRECTORY',
  'FILE',
  'FILENAME',
  'NAME',
  'URL',
  'URI',
  'HOST',
  'PORT',
  'SERVICE',
]);

// Strip every ${...} span out of a value so the residue can be scanned for a
// LITERAL secret. A stray ${UNUSED} sitting next to a real key must not gate
// the whole value as "safe" -- only the secret-bearing portion being itself an
// env ref makes it safe. Used by the bearer / header / env / url scans below.
function stripEnvVarRefs(value: string): string {
  return value.replace(/\$\{[^}]*\}/g, '');
}

// The one contiguous literal run of `value` once its ${...} spans are cut
// out (trimmed), so a fix can replace just that run and leave every
// neighbouring reference in place: `KEY${SUFFIX}` -> `KEY`, `${A} KEY` ->
// `KEY`. Null when the literal is split across a reference (`AB${MID}CD`):
// no single replacement both removes the secret and keeps the reference,
// so the finding is reported without a fix.
function singleLiteralSpan(value: string): string | null {
  const pieces = value
    .split(/\$\{[^}]*\}/)
    .map((p) => p.trim())
    .filter(Boolean);
  return pieces.length === 1 ? pieces[0] : null;
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

// True when the url's userinfo carries a literal password
// (`https://user:pw@host`), or a bare username that is itself a known token
// (`https://ghp_...@github.com`).
function hasLiteralUrlCredentials(url: string): boolean {
  const m = url.match(URL_USERINFO);
  if (!m) return false;
  const userinfo = m[1];
  const colon = userinfo.indexOf(':');
  if (colon === -1) return isKnownApiKey(stripEnvVarRefs(userinfo));
  return stripEnvVarRefs(userinfo.slice(colon + 1)).length > 0;
}

function isKnownApiKey(value: string): boolean {
  return API_KEY_PATTERNS.some((p) => p.test(value));
}

// Return the first known-API-key substring in value, or null. Used to build a
// precise fix (replace just the literal key, not the whole value, so a
// `--flag=KEY` arg keeps its flag and a neighbouring ${VAR} survives).
function findKnownApiKey(value: string): string | null {
  for (const p of API_KEY_PATTERNS) {
    const m = value.match(p);
    if (m) return m[0];
  }
  return null;
}

function nameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toUpperCase());
}

function nameSuggestsSecret(name: string): boolean {
  const tokens = nameTokens(name);
  if (tokens.length === 0) return false;
  if (NON_SECRET_NAME_SUFFIXES.has(tokens[tokens.length - 1])) return false;
  return tokens.some(
    (t) =>
      SECRET_NAME_TOKENS.has(t) ||
      (!NON_SECRET_COMPOUNDS.has(t) && SECRET_NAME_SUFFIXES.some((s) => t.endsWith(s))),
  );
}

// A value that names where a secret lives, not the secret: a home-,
// dot-relative or absolute path (POSIX or Windows) with at least two
// segments (`/Users/x/...`, `C:\keys\...`). A leading `/` alone is not
// enough -- about 1 in 64 base64 secrets starts with one -- and a value
// carrying `+` or `=` is base64, never a path, even when a second `/` turns up.
// (Most real paths never reach here: `.`, `~`, `:` and `\` fall outside
// HIGH_ENTROPY_PATTERN, so `id_rsa.pub`-style paths are already excluded.)
function looksLikeFilesystemPath(value: string): boolean {
  if (/[+=]/.test(value)) return false;
  return /^(~|\.{1,2})?[\\/][^\\/]+[\\/]/.test(value) || /^[A-Za-z]:[\\/]/.test(value);
}

// Callers pass the env-ref-stripped residue, so a pure ${VAR} arrives as ''.
function isHighEntropySecret(value: string): boolean {
  return HIGH_ENTROPY_PATTERN.test(value) && !looksLikeFilesystemPath(value);
}

/**
 * An environment-variable name built from `parts`: non-alphanumerics become
 * `_`, upper-cased, and a leading digit gets a `_` prefix (`1password` ->
 * `_1PASSWORD`), since no shell accepts a name starting with a digit.
 */
function toEnvVarName(...parts: string[]): string {
  const name = parts
    .join('_')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  if (!name) return 'SECRET';
  return /^[0-9]/.test(name) ? `_${name}` : name;
}

/**
 * The variable a hardcoded header value moves to: `<SERVER>_TOKEN` for an
 * `Authorization: Bearer` token, `<SERVER>_CREDENTIALS` for any other
 * Authorization scheme (Basic, Token, ...), else `<SERVER>_<HEADER>` with a
 * leading `X-` dropped (`X-API-Key` -> `<SERVER>_API_KEY`).
 */
function headerVarName(serverName: string, headerName: string, bearer: boolean): string {
  if (isAuthorizationHeader(headerName)) {
    return toEnvVarName(serverName, bearer ? 'TOKEN' : 'CREDENTIALS');
  }
  return toEnvVarName(serverName, headerName.replace(/^x-/i, ''));
}

/**
 * The variable a secret in an arg moves to: named after its flag
 * (`--api-key=KEY` or `--token KEY` -> `<SERVER>_API_KEY` / `<SERVER>_TOKEN`),
 * else `<SERVER>_API_KEY`.
 */
function argVarName(serverName: string, args: string[], index: number, key: string): string {
  const arg = args[index];
  const eq = arg.indexOf('=');
  let flag: string | undefined;
  if (eq > 0 && arg.startsWith('-') && arg.indexOf(key) > eq) flag = arg.slice(0, eq);
  else if (arg === key && index > 0 && args[index - 1].startsWith('-')) flag = args[index - 1];
  const stem = flag?.replace(/^-+/, '');
  return toEnvVarName(serverName, stem || 'API_KEY');
}

function isAuthorizationHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'authorization' || lower === 'proxy-authorization';
}

/**
 * Build a fix that replaces `secret` (a substring of the decoded value at
 * `valuePath`) with an env reference in the client's own syntax. Anchors on
 * the value's own line and column, not the server's `"name": {` line, so it
 * lands on pretty-printed JSON. Omitted (undefined) when the client does not
 * interpolate env references (a literal `${VAR}` would break a working
 * config), when the value cannot be located, or when JSON escapes make the
 * source text differ from the decoded secret.
 */
function buildSecretFix(
  config: ParsedMcpConfig,
  server: McpServerEntry,
  valuePath: (string | number)[],
  secret: string,
  varName: string,
): FixAction | undefined {
  const ref = formatEnvRef(config.client, varName);
  if (ref === null || secret.length === 0) return undefined;
  const loc = locateServerValue(config, server, valuePath);
  if (!loc || loc.text.length < 2 || !loc.text.startsWith('"')) return undefined;
  const inner = loc.text.slice(1, -1);
  const idx = inner.indexOf(secret);
  if (idx === -1) return undefined;
  return {
    file: config.filePath,
    line: loc.line,
    column: loc.column + 1 + idx,
    oldText: secret,
    newText: ref,
  };
}

/**
 * Hands out env-var names for one server's secrets. Two DIFFERENT secrets
 * that derive the same name (two headers both mapping to `<SERVER>_TOKEN`)
 * get `_2`, `_3`, ... so the fix never folds them into one variable; the same
 * secret seen twice reuses its name.
 */
function makeNamer(): (base: string, secret: string) => string {
  const owners = new Map<string, string>();
  return (base, secret) => {
    for (let n = 1; ; n++) {
      const name = n === 1 ? base : `${base}_${n}`;
      const owner = owners.get(name);
      if (owner === undefined) {
        owners.set(name, secret);
        return name;
      }
      if (owner === secret) return name;
    }
  };
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
    const nameFor = makeNamer();
    const apiKeyIssue = (fix: FixAction | undefined): LintIssue => ({
      severity: 'error',
      check: 'mcp-security',
      ruleId: 'mcp-security/hardcoded-api-key',
      line: fix?.line ?? server.line,
      message: `Server "${server.name}" has a hardcoded API key in a git-tracked file`,
      ...(fix ? { fix } : {}),
    });

    // Check headers for hardcoded credentials
    if (checkSecrets && server.headers) {
      for (const [headerName, headerValue] of Object.entries(server.headers)) {
        const residue = stripEnvVarRefs(headerValue);
        if (isAuthorizationHeader(headerName)) {
          // `<scheme> <credentials>` (Bearer, Basic, Token, ...) or a bare
          // credential. Safe only when the credentials are ENTIRELY env refs:
          // stripping the ${...} spans leaves nothing but whitespace. A
          // literal next to a stray ${VAR} still has residue, so it flags.
          const schemeMatch = headerValue.match(/^([A-Za-z][A-Za-z0-9._-]*)(\s+)(.+)$/);
          const credentials = schemeMatch ? schemeMatch[3] : headerValue;
          if (stripEnvVarRefs(credentials).trim().length === 0) continue;
          const bearer = schemeMatch !== null && schemeMatch[1].toLowerCase() === 'bearer';
          // The fix replaces only the literal credentials, so the scheme,
          // the whitespace after it and any ${...} beside the literal stay
          // exactly as written.
          const literal = singleLiteralSpan(credentials);
          const fix =
            literal === null
              ? undefined
              : buildSecretFix(
                  config,
                  server,
                  ['headers', headerName],
                  literal,
                  nameFor(headerVarName(server.name, headerName, bearer), literal),
                );
          if (bearer) {
            issues.push({
              severity: 'error',
              check: 'mcp-security',
              ruleId: 'mcp-security/hardcoded-bearer',
              line: fix?.line ?? server.line,
              message: `Server "${server.name}" has a hardcoded Bearer token in a git-tracked file`,
              ...(fix ? { fix } : {}),
            });
          } else {
            issues.push(apiKeyIssue(fix));
          }
          continue;
        }

        // Any other header: a known key pattern anywhere in the residue (a
        // literal key next to an unrelated ${VAR} must still flag), or a
        // high-entropy literal under a secret-suggesting name (X-API-Key,
        // X-Auth-Token) -- many APIs issue keys with no recognizable prefix.
        // The fix targets only the literal (the known key, or the value's
        // single literal run), never a ${...} sitting beside it.
        const known = findKnownApiKey(residue);
        if (!known && !(nameSuggestsSecret(headerName) && isHighEntropySecret(residue))) continue;
        const secret = known ?? singleLiteralSpan(headerValue);
        issues.push(
          apiKeyIssue(
            secret === null
              ? undefined
              : buildSecretFix(
                  config,
                  server,
                  ['headers', headerName],
                  secret,
                  nameFor(headerVarName(server.name, headerName, false), secret),
                ),
          ),
        );
      }
    }

    // Check env values for hardcoded secrets
    if (checkSecrets && server.env) {
      for (const [envName, envValue] of Object.entries(server.env)) {
        // Scan the residue with ${...} spans stripped: a literal key sitting
        // next to an unrelated ${VAR} must still flag (whole-value env-ref
        // gating would skip it), and a bare ${VAR} residue ('') stays safe.
        const scanned = stripEnvVarRefs(envValue);
        // Known API key patterns (sk-, ghp_, AKIA, JWT, etc.) always flag;
        // the fix then replaces just the key. The high-entropy heuristic only
        // fires when the variable name suggests a secret -- avoids false
        // positives on BUILD_ID, *_VERSION, *_COMMIT, etc. -- and replaces
        // the value's single literal run (a ${...} beside it survives; a
        // literal split around one gets no fix).
        const known = findKnownApiKey(scanned);
        if (!known && !(nameSuggestsSecret(envName) && isHighEntropySecret(scanned))) continue;
        const secret = known ?? singleLiteralSpan(envValue);
        // The server reads this value from `envName`, so the reference keeps
        // that name (GITHUB_TOKEN stays GITHUB_TOKEN).
        issues.push(
          apiKeyIssue(
            secret === null
              ? undefined
              : buildSecretFix(
                  config,
                  server,
                  ['env', envName],
                  secret,
                  nameFor(toEnvVarName(envName), secret),
                ),
          ),
        );
      }
    }

    // Check CLI args for hardcoded secrets. A literal token can ride in an
    // arg as `--flag=value` (one array element) or `--flag value` (the value
    // is its own element) -- substring-scanning each arg for a known key
    // catches both forms. Env refs are stripped first for consistency with the
    // header/env scans; the fix replaces only the matched literal so a
    // `--flag=KEY` arg keeps its flag.
    if (checkSecrets && server.args) {
      const args = server.args;
      for (let i = 0; i < args.length; i++) {
        const key = findKnownApiKey(stripEnvVarRefs(args[i]));
        if (!key) continue;
        issues.push(
          apiKeyIssue(
            buildSecretFix(
              config,
              server,
              ['args', i],
              key,
              nameFor(argVarName(server.name, args, i, key), key),
            ),
          ),
        );
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

    // Credentials in the URL's userinfo (https://user:pw@host/) leak the
    // same way a query-string secret does.
    if (checkSecrets && server.url && hasLiteralUrlCredentials(server.url)) {
      issues.push({
        severity: 'error',
        check: 'mcp-security',
        ruleId: 'mcp-security/secret-in-url',
        line: server.line,
        message: `Server "${server.name}" has credentials in the URL userinfo`,
      });
    }

    // Check URL for non-TLS (http:// for non-localhost)
    if (server.url) {
      try {
        // Only check if URL doesn't contain env var refs
        if (!ENV_VAR_REF.test(server.url)) {
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
