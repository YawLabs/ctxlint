import type { ParsedContextFile, LintIssue } from '../types.js';

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
}

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
  },
  // OpenAI API keys (project-scoped or classic). Match sk- or sk-proj- with at
  // least 20 random chars to avoid catching `sk-...` ellipses in docs.
  {
    ruleSlug: 'openai-key',
    label: 'OpenAI API key',
    regex: /\bsk-(?:proj-)?[A-Za-z0-9_\-]{20,}\b/g,
  },
  // npm automation tokens.
  {
    ruleSlug: 'npm-token',
    label: 'npm token',
    regex: /\bnpm_[A-Za-z0-9]{36,}\b/g,
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
const PRIVATE_KEY_HEADER = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/;

// Order matters slightly for sk- precedence: Anthropic (`sk-ant-`) must run
// before OpenAI (`sk-`) so that the same substring isn't flagged twice. We
// achieve this with a per-line dedup keyed by (start offset + slug).

const PLACEHOLDER_TOKENS = [
  'example',
  'placeholder',
  'your-key',
  '<replace',
  'redacted',
  'xxxx',
  '****',
];

const COMMENT_PREFIX = /^\s*(?:#|\/\/|--|<!--)/;

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

function isCommentedExample(line: string): boolean {
  if (!COMMENT_PREFIX.test(line)) return false;
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
 * Scan content line-by-line, tracking fenced-code-block state so we can apply
 * the "illustrative fence skip" rule. Returns a per-line tag indicating the
 * active fence language, or `null` if outside any fence.
 *
 * We treat both ``` and ~~~ as fences. The tag is everything after the fence
 * marker on the opening line, trimmed and lowercased. A fence is closed by a
 * line whose first non-whitespace content is the same marker (length doesn't
 * have to match exactly to be forgiving).
 */
function computeFenceLanguages(lines: string[]): (string | null)[] {
  const out: (string | null)[] = new Array(lines.length).fill(null);
  let activeMarker: '`' | '~' | null = null;
  let activeLang: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (activeMarker === null) {
      // Look for an opening fence.
      const open = trimmed.match(/^(```+|~~~+)(.*)$/);
      if (open) {
        activeMarker = open[1][0] as '`' | '~';
        activeLang = open[2].trim().toLowerCase();
        // The fence line itself isn't "inside" the block.
        continue;
      }
    } else {
      // Inside a fence -- tag this line, look for the close.
      out[i] = activeLang;
      if (
        trimmed.startsWith(activeMarker.repeat(3)) &&
        trimmed.replace(new RegExp(`^${activeMarker === '`' ? '`' : '~'}+`), '').trim() === ''
      ) {
        activeMarker = null;
        activeLang = null;
      }
    }
  }
  return out;
}

function redactedPrefix(value: string): string {
  const head = value.slice(0, 6);
  return `${head}...`;
}

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

    // Conservative double-guard: a commented line marked as fake/example.
    if (isCommentedExample(line)) continue;

    // Inside a fence that's purely illustrative -- skip.
    const fenceLang = fenceLangs[i];
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

    // Track which (start offset, slug) we've already flagged on this line so
    // overlapping patterns (e.g. sk-ant- vs sk-) don't double-fire.
    const seen = new Set<string>();

    for (const pattern of PATTERNS) {
      const re = new RegExp(pattern.regex.source, pattern.regex.flags);
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        const matched = m[0];
        const start = m.index;
        const end = start + matched.length;
        const key = `${start}:${pattern.ruleSlug}`;
        if (seen.has(key)) continue;

        // Skip overlapping shorter matches at the same start that we already
        // flagged with a different slug (Anthropic before OpenAI).
        let overlap = false;
        for (const k of seen) {
          const [s] = k.split(':');
          if (parseInt(s, 10) === start) {
            overlap = true;
            break;
          }
        }
        if (overlap) continue;

        if (isPlaceholderWrapped(line, start, end)) continue;

        seen.add(key);

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
