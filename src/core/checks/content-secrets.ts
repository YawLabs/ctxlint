import type { ParsedContextFile, LintIssue } from '../types.js';
import { classifyLines } from '../../utils/markdown.js';

/**
 * Content-secret detection for context files (CLAUDE.md / AGENTS.md /
 * .cursorrules / etc.). ctxlint already catches secrets in MCP server configs
 * (`mcp/security.ts`); this check covers the other common leak surface: a user
 * pasting `AKIA...`, `sk-ant-...`, etc. directly into a heading or code block
 * of a file that usually ends up committed to git.
 *
 * Patterns chosen to be well-defined and low-false-positive. Random
 * high-entropy detection is deliberately omitted -- it bites build IDs,
 * commit SHAs, and version strings. We prefer precision over recall here:
 * a missed exotic format is fine, a noisy false positive that trains users
 * to ignore the check is not.
 *
 * Never include the actual matched secret value in any emitted issue field.
 * The user already knows what they typed; the value landing in ctxlint's
 * stderr/SARIF would itself be a leak vector. Show a 6-char redacted prefix
 * + ellipsis at most.
 */

interface SecretPattern {
  /** Stable label slugged into ruleId. */
  ruleSlug: string;
  /** Human-readable name for the message field. */
  label: string;
  /** The regex. Must use `\b` boundaries on alphanumeric tails. */
  regex: RegExp;
  /**
   * Extra test a match must pass, for formats whose prefix and body class also
   * fit ordinary identifiers (`sk-learn-compatible-estimator-api`). Applied by
   * both detection and redaction.
   */
  accept?: (match: string) => boolean;
  /**
   * Set when the prefix plus a short body also occurs in ordinary text
   * (`sk-dashboard`, `$npm_lifecycle_event`, `ASIAPACIFIC...`). Redaction,
   * which lowers the body floor, then rewrites a sub-floor match only when
   * this says it looks random (see shouldRedact).
   */
  shortLooksRandom?: (match: string) => boolean;
}

/** A random key tail has an uppercase letter or a digit; a kebab name has neither. */
function hasUpperOrDigit(match: string): boolean {
  return /[A-Z0-9]/.test(match.replace(/^sk-/, ''));
}

/** Changes between uppercase, lowercase and digit runs (`AbC1` has 3). */
function classTransitions(s: string): number {
  const cls = (c: string) =>
    /[A-Z]/.test(c) ? 'u' : /[a-z]/.test(c) ? 'l' : /\d/.test(c) ? 'd' : 'o';
  let n = 0;
  for (let i = 1; i < s.length; i++) if (cls(s[i]) !== cls(s[i - 1])) n++;
  return n;
}

/**
 * A cut-short sk- key: some `-`/`_`-separated segment of the body is 8+ chars
 * that switch character class at least 3 times (`AbCdEf12`). Hyphenated words
 * with a version tag (`sk-learn-v2-compat`, `sk-2024-roadmap-v3`) have no such
 * segment.
 */
function skShortLooksRandom(match: string): boolean {
  return match
    .replace(/^sk-/, '')
    .split(/[-_]/)
    .some((seg) => seg.length >= 8 && classTransitions(seg) >= 3);
}

/**
 * A cut-short ASIA key: its uppercase/digit body interleaves digits with
 * letters (`IOSFODNN7Z`), not just a leading or trailing number
 * (`ASIA2025SUMMIT`, `ASIAPACIFIC2`).
 */
function asiaShortLooksRandom(match: string): boolean {
  return classTransitions(match.slice(4)) >= 2;
}

/** A cut-short npm token carries a digit; `$npm_lifecycle_event` does not. */
function npmShortLooksRandom(match: string): boolean {
  return /\d/.test(match.slice(4));
}

// Formats last reviewed 2026-11-22 against the vendors' published token
// shapes (AWS, GitHub, Anthropic, OpenAI, npm, Slack, Google, Stripe). Refresh
// when a vendor announces a new prefix or length, and add a positive test plus
// a redactSecrets SAMPLES entry for every pattern added here.
const PATTERNS: SecretPattern[] = [
  // AWS access key (long-lived) -- AKIA prefix + 16 uppercase alphanum chars.
  {
    ruleSlug: 'aws-access-key',
    label: 'AWS access key',
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  // AWS STS temporary access key -- ASIA prefix.
  {
    ruleSlug: 'aws-access-key',
    label: 'AWS access key',
    regex: /\bASIA[0-9A-Z]{16}\b/g,
    shortLooksRandom: asiaShortLooksRandom,
  },
  // GitHub classic PAT.
  {
    ruleSlug: 'github-pat',
    label: 'GitHub personal access token',
    regex: /\bghp_[A-Za-z0-9]{36,}\b/g,
  },
  // GitHub fine-grained PAT.
  {
    ruleSlug: 'github-pat',
    label: 'GitHub personal access token',
    regex: /\bgithub_pat_[A-Za-z0-9_]{82,}\b/g,
  },
  // GitHub server-to-server / OAuth / user / refresh tokens.
  {
    ruleSlug: 'github-pat',
    label: 'GitHub token',
    regex: /\bghs_[A-Za-z0-9]{36,}\b/g,
  },
  {
    ruleSlug: 'github-pat',
    label: 'GitHub token',
    regex: /\bgho_[A-Za-z0-9]{36,}\b/g,
  },
  {
    ruleSlug: 'github-pat',
    label: 'GitHub token',
    regex: /\bghu_[A-Za-z0-9]{36,}\b/g,
  },
  {
    ruleSlug: 'github-pat',
    label: 'GitHub token',
    regex: /\bghr_[A-Za-z0-9]{36,}\b/g,
  },
  // Anthropic API keys.
  {
    ruleSlug: 'anthropic-key',
    label: 'Anthropic API key',
    regex: /\bsk-ant-[A-Za-z0-9\-_]{20,}\b/g,
    accept: hasUpperOrDigit,
    shortLooksRandom: skShortLooksRandom,
  },
  // OpenAI API keys (project-scoped or classic). Match sk- or sk-proj- with at
  // least 20 random chars to avoid catching `sk-...` ellipses in docs. The
  // tail must carry an uppercase letter or a digit: an all-lowercase
  // hyphenated run (`sk-learn-compatible-estimator-api`) is a name, not a key.
  {
    ruleSlug: 'openai-key',
    label: 'OpenAI API key',
    regex: /\bsk-(?:proj-)?[A-Za-z0-9_\-]{20,}\b/g,
    accept: hasUpperOrDigit,
    shortLooksRandom: skShortLooksRandom,
  },
  // npm automation tokens.
  {
    ruleSlug: 'npm-token',
    label: 'npm token',
    regex: /\bnpm_[A-Za-z0-9]{36,}\b/g,
    shortLooksRandom: npmShortLooksRandom,
  },
  // Slack tokens (bot, user, app, admin, refresh).
  {
    ruleSlug: 'slack-token',
    label: 'Slack token',
    regex: /\bxox[bpoasr]-[A-Za-z0-9\-]{10,}\b/g,
  },
  // Google API keys.
  {
    ruleSlug: 'google-api-key',
    label: 'Google API key',
    regex: /\bAIza[0-9A-Za-z\-_]{35}\b/g,
  },
  // Stripe live secret keys.
  {
    ruleSlug: 'stripe-secret',
    label: 'Stripe live secret key',
    regex: /\bsk_live_[0-9a-zA-Z]{24,}\b/g,
  },
];

// Private key header is line-based, not bounded -- handle separately so the
// whole line gets the issue without trying to redact-prefix the BEGIN string.
// Any run of uppercase qualifiers -- RSA / EC / DSA / OPENSSH / ENCRYPTED
// (PKCS#8) -- plus PGP's `PRIVATE KEY BLOCK` form.
const PRIVATE_KEY_HEADER = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/;

// Order matters for sk- precedence: Anthropic (`sk-ant-`) precedes OpenAI
// (`sk-`) in PATTERNS, and the per-line dedup in checkContentSecrets lets the
// first pattern to claim a start offset win, so one key is flagged once.

const PLACEHOLDER_TOKENS = [
  'example',
  'placeholder',
  'your-key',
  '<replace',
  'redacted',
  'xxxx',
  '****',
];

// `#` opens a comment only inside a code fence (shell, YAML, Python...). In
// markdown prose it opens a heading, so `## Fake tokens: ghp_<real>` must not
// pass as a commented-out example.
const COMMENT_PREFIX = /^\s*(?:\/\/|--|<!--)/;
const FENCED_COMMENT_PREFIX = /^\s*(?:#|\/\/|--|<!--)/;

/**
 * Line-scoped placeholder guard: returns true if ANY placeholder token appears
 * anywhere on the line, suppressing the whole line.
 *
 * RECALL GAP (deliberate): this is line-scoped, not token-scoped. A real secret
 * that happens to share its line with a benign "example"/"redacted"/etc. word
 * elsewhere on the line (e.g. `Example value: AKIA<real-key>`) is suppressed.
 * A token-scoped tightening — only treating the match as a placeholder when the
 * placeholder token is adjacent to the matched secret (as `isPlaceholderWrapped`
 * already does for `${...}`/`<...>` wrappers) — was considered, but the existing
 * false-positive corpus deliberately relies on line-scoped suppression: lines
 * like `Placeholder token: ghp_...` and `Your-key here: ASIA...` mention the
 * placeholder word NON-adjacent to the secret and must stay suppressed.
 * Tightening to adjacency would re-flag all of
 * those, trading the (rare) recall miss for a wave of false positives that
 * trains users to ignore the check — the opposite of this module's
 * precision-over-recall stance (see file header).
 *
 * The "never leaks a real secret value" guarantee is unaffected: this only
 * controls WHETHER a line is scanned, never what an emitted issue contains.
 */
function lineLooksLikePlaceholder(line: string): boolean {
  const lower = line.toLowerCase();
  for (const tok of PLACEHOLDER_TOKENS) {
    if (lower.includes(tok)) return true;
  }
  return false;
}

function isCommentedExample(line: string, inFence: boolean): boolean {
  if (!(inFence ? FENCED_COMMENT_PREFIX : COMMENT_PREFIX).test(line)) return false;
  const lower = line.toLowerCase();
  return lower.includes('fake') || lower.includes('example');
}

/**
 * Was the matched literal wrapped in a placeholder context like `${SECRET}`,
 * `<your-key>`, etc.? Checks the chars immediately adjacent to the match.
 */
function isPlaceholderWrapped(line: string, start: number, end: number): boolean {
  const before2 = line.slice(Math.max(0, start - 2), start);
  const after2 = line.slice(end, end + 2);
  // Immediate-neighbor opens/closes -- `<AKIA...>`, `${AKIA...}`.
  if (before2.endsWith('<') && after2.startsWith('>')) return true;
  if (before2.endsWith('${') && after2.startsWith('}')) return true;
  if (before2.endsWith('{') && after2.startsWith('}')) return true;
  // Looser: any `${...}` or `<...>` containing the match. Scan backwards for
  // `${` or `<` and forwards for the matching close, with the match enclosed.
  const dollarOpen = line.lastIndexOf('${', start);
  if (dollarOpen !== -1) {
    const close = line.indexOf('}', dollarOpen);
    if (close !== -1 && close >= end) return true;
  }
  const angleOpen = line.lastIndexOf('<', start);
  if (angleOpen !== -1) {
    const close = line.indexOf('>', angleOpen);
    if (close !== -1 && close >= end) {
      // The '<' and '>' must look like a placeholder wrapper, not a stray
      // comparison-operator pair ("retries < max ... timeout > 30") that
      // happens to straddle the match. A wrapper is the innermost bracket
      // pair (no '<' inside the span -- e.g. an unrelated <docs> tag after
      // the match), hugs its content (comparison operators carry boundary
      // whitespace, placeholders like <your-key> never do), and is short.
      const span = line.slice(angleOpen + 1, close);
      if (
        span.length > 0 &&
        !span.includes('<') &&
        span === span.trim() &&
        close - angleOpen <= 80
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Fence languages where copy-paste of a secret would actually run / configure
 * something -- those still flag. `text`/`txt`/`example`/`pseudocode`/`none`
 * are illustrative-only. Untagged fences (a bare ```) are NOT illustrative:
 * a bare fence is the most common way real `.env` contents, export lines, or
 * whole key files get pasted into a context file, so only an explicit
 * illustrative tag earns the skip.
 */
const ILLUSTRATIVE_FENCES = new Set(['text', 'txt', 'example', 'pseudocode', 'none']);

/**
 * Per-line fence language for the "illustrative fence skip" rule: the
 * enclosing fence's info string, lowercased, on each content line of a fence,
 * and `null` on delimiter lines and outside fences. Built on the shared
 * markdown.ts scanner (classifyLines), so a one-line ```npm test``` span does
 * not open a fence that swallows the rest of the file.
 */
function computeFenceLanguages(lines: string[]): (string | null)[] {
  return classifyLines(lines).map((c) =>
    c.fence && !c.fenceDelimiter ? c.fenceInfo.toLowerCase() : null,
  );
}

function redactedPrefix(value: string): string {
  const head = value.slice(0, 6);
  return `${head}...`;
}

/**
 * Body-length floor for redaction. Detection demands the full documented
 * length (36 chars for ghp_, 20 for sk-, ...) to stay precise; redaction
 * cannot, because callers echo truncated text and a token cut short of its
 * floor would otherwise leak almost whole. The formats whose short form also
 * occurs in ordinary text are guarded instead (see shouldRedact).
 */
const REDACT_MIN_BODY = 8;

/**
 * One alternation of every PATTERNS regex, rewritten for redaction: each
 * alternative is a capture group (so the replacer knows which pattern hit),
 * the trailing `\b` is dropped and the final quantifier's floor lowered to
 * REDACT_MIN_BODY. Without a trailing assertion each attempt either takes the
 * whole greedy run or fails within REDACT_MIN_BODY chars, so the global
 * replace is linear in the input. The guards run in the replacer on a match
 * already consumed, so they add no backtracking. Anthropic precedes OpenAI in
 * PATTERNS, so `sk-ant-` keys take the more specific alternative.
 */
const REDACTION_REGEX = new RegExp(
  PATTERNS.map(
    ({ regex }) =>
      `(${regex.source
        .replace(/\\b$/, '')
        .replace(
          /\{(\d+)(?:,\d*)?\}$/,
          (_m, n: string) => `{${Math.min(Number(n), REDACT_MIN_BODY)},}`,
        )})`,
  ).join('|'),
  'g',
);

/** Each pattern's detection regex anchored to a whole string. */
const FULL_MATCH = PATTERNS.map((p) => new RegExp(`^(?:${p.regex.source})$`));

/**
 * Should a redaction-regex match of PATTERNS[index] be rewritten? A match with
 * the full detection shape always is (checkContentSecrets reports it, so no
 * other output may carry it), whatever follows it. Unguarded formats always
 * are too: their prefixes (ghp_, AKIA, xoxb-, ...) do not occur in prose. A
 * sub-floor match of a guarded format is left alone when it is followed by a
 * path separator or a file extension (it names a file:
 * `scripts/sk-Deploy2026.sh`), and otherwise needs its pattern's
 * shortLooksRandom: a truncated real token is random, while
 * `$npm_lifecycle_event`, `sk-learn-v2-compat` and `ASIA2025SUMMIT` are not.
 */
function shouldRedact(index: number, match: string, next: string): boolean {
  const pattern = PATTERNS[index];
  if (pattern.accept && !pattern.accept(match)) return false;
  if (FULL_MATCH[index].test(match)) return true;
  if (!pattern.shortLooksRandom) return true;
  if (/^(?:\/|\.[A-Za-z0-9])/.test(next)) return false;
  return pattern.shortLooksRandom(match);
}

/**
 * Replace every known-format secret in `text` with its 6-char prefix plus an
 * ellipsis (the same form checkContentSecrets reports). Linear-time and
 * idempotent: a redacted prefix is shorter than any pattern's body floor and
 * the ellipsis is outside every body class, so a second pass matches nothing.
 *
 * The audit applies this to the text fields of every issue, and the output
 * serializers to fix values, so a check that quotes source text cannot put a
 * token into ctxlint's own output. Known gap: a guarded match that is left
 * alone keeps its whole run, so a real token glued into that same run
 * (`sk-name-ghp_<token>/x`) is not rewritten either.
 */
export function redactSecrets(text: string): string {
  return text.replace(REDACTION_REGEX, (m: string, ...rest: unknown[]) => {
    // rest is [group 1 .. group N, offset, input]: exactly one group is set.
    const index = rest.findIndex((g, i) => i < PATTERNS.length && g !== undefined);
    const offset = rest[PATTERNS.length] as number;
    const next = text.slice(offset + m.length, offset + m.length + 2);
    return shouldRedact(index, m, next) ? redactedPrefix(m) : m;
  });
}

/**
 * Redact a value that is a secret by definition (e.g. the old text of a fix
 * emitted by a secret rule), whether or not any known pattern matches it.
 * Short values reveal nothing, since six characters may be most of them.
 */
export function redactSecretValue(value: string): string {
  return value.length >= 12 ? redactedPrefix(value) : '...';
}

// `_projectRoot` is unused (the check reads only the file's content); it keeps
// the signature every per-file check shares.
export async function checkContentSecrets(
  file: ParsedContextFile,
  _projectRoot: string,
): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];
  const lines = file.content.split(/\r?\n/);
  const fenceLangs = computeFenceLanguages(lines);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    const fenceLang = fenceLangs[i];

    // Conservative double-guard: a commented line marked as fake/example.
    if (isCommentedExample(line, fenceLang !== null)) continue;

    // Inside a fence that's purely illustrative -- skip.
    if (fenceLang !== null && ILLUSTRATIVE_FENCES.has(fenceLang)) continue;

    // Cheap line-level placeholder guard.
    if (lineLooksLikePlaceholder(line)) continue;

    // Private key header is line-level only -- no offset/redaction needed.
    if (PRIVATE_KEY_HEADER.test(line)) {
      issues.push({
        severity: 'error',
        check: 'content-secrets',
        ruleId: 'content-secrets/private-key-header',
        line: lineNo,
        message: `Private key header detected in ${file.relativePath}`,
        suggestion:
          'Move the secret to a `.env` or secret manager and reference it by name. ' +
          'If this token is real, rotate it immediately.',
      });
      continue;
    }

    // Start offsets already flagged on this line: the first pattern to claim
    // an offset wins, so overlapping patterns (sk-ant- before sk-) don't
    // double-fire.
    const claimed = new Set<number>();

    for (const pattern of PATTERNS) {
      const re = new RegExp(pattern.regex.source, pattern.regex.flags);
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        const matched = m[0];
        const start = m.index;
        const end = start + matched.length;
        if (claimed.has(start)) continue;
        if (pattern.accept && !pattern.accept(matched)) continue;
        if (isPlaceholderWrapped(line, start, end)) continue;

        claimed.add(start);

        issues.push({
          severity: 'error',
          check: 'content-secrets',
          ruleId: `content-secrets/${pattern.ruleSlug}`,
          line: lineNo,
          message: `${pattern.label} detected in ${file.relativePath} (${redactedPrefix(matched)})`,
          suggestion:
            'Move the secret to a `.env` or secret manager and reference it by name. ' +
            'If this token is real, rotate it immediately.',
        });
      }
    }
  }

  return issues;
}
