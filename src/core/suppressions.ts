/**
 * Inline suppression directives.
 *
 * Some findings are correct-by-construction false positives that no heuristic
 * can resolve, because the document is deliberately naming something that does
 * not exist yet:
 *
 *     CI-on-tag-push via `.github/workflows/release.yml` is the intended end
 *     state but is not wired up here today.
 *
 * That path reference is accurate and useful, and `paths/not-found` is
 * right that the file is absent. Without an escape hatch the only way to
 * silence it is to reword the prose so the extractor stops seeing the path --
 * which degrades the document to satisfy the linter. A directive lets the
 * reference stay legible and marks the finding as known.
 *
 * Syntax (HTML comments, so they render as nothing in Markdown):
 *
 *     <!-- ctxlint-ignore-next-line -->        suppress every check on the next line
 *     <!-- ctxlint-ignore-next-line paths -->  suppress only `paths` on the next line
 *     <!-- ctxlint-ignore-line -->             suppress every check on THIS line
 *     <!-- ctxlint-ignore-line paths tokens -->  suppress two checks on THIS line
 *     <!-- ctxlint-ignore-next-line paths/not-found -->  one rule only
 *
 * A target is either a check name (`paths`), which matches an issue whose
 * `check` or rule-ID prefix is that name, or a full rule ID
 * (`paths/not-found`), which matches only that rule. A slash-form target
 * that names no inline-suppressible rule (SUPPRESSIBLE_RULE_IDS) draws a
 * stderr warning.
 *
 * Directives inside fenced code blocks or inline code spans are ignored, so a
 * context file can DOCUMENT the syntax without suppressing anything. A comment
 * that starts like a directive (`<!-- ctxlint-...`) but does not parse is
 * reported on stderr rather than silently doing nothing.
 *
 * Scope is deliberately one line. A file-wide or block-wide disable is easy to
 * add and easy to leave behind: the whole value of these findings is that they
 * fail loudly when a path really does break, and a stale file-level disable
 * silently turns that off forever.
 */

import { classifyLines, inlineCodeSpans, maskCodeSpans } from '../utils/markdown.js';

/**
 * Every rule ID an inline directive can suppress: the rules the single-file
 * context checks emit (audit.ts runSingleFileChecks is the only place
 * directives are applied). Cross-file rules -- tokens/aggregate,
 * tier-tokens/aggregate, redundancy/duplicate-content, contradictions/*,
 * ci-*, hook-coverage/* -- are reported outside that path, so naming one in a
 * directive suppresses nothing and draws the same warning as a typo.
 *
 * Kept as a literal rather than read from context-lint-rules.json: importing
 * the catalog would bundle the whole file into dist/index.js (entry.test.ts
 * keeps catalog readers out of the shipped bundle). suppressions.test.ts
 * checks this list against the catalog in both directions.
 */
export const SUPPRESSIBLE_RULE_IDS: ReadonlySet<string> = new Set([
  'paths/not-found',
  'paths/glob-no-match',
  'paths/directory-not-found',
  'commands/script-not-found',
  'commands/make-target-not-found',
  'commands/no-makefile',
  'commands/npx-not-in-deps',
  'commands/tool-not-found',
  'commands/package-json-missing',
  'commands/exit-status-masked',
  'commands/unknown-subcommand',
  'commands/gradle-project-not-found',
  'commands/maven-module-not-found',
  'staleness/stale',
  'staleness/aging',
  'tokens/excessive',
  'tokens/large',
  'tokens/info',
  'tier-tokens/section-breakdown',
  'tier-tokens/hard-enforcement-missing',
  'redundancy/tech-mention',
  'redundancy/discoverable-dir',
  'frontmatter/missing',
  'frontmatter/missing-field',
  'frontmatter/invalid-value',
  'frontmatter/unclosed',
  'frontmatter/no-activation',
  'content-secrets/private-key-header',
  'content-secrets/aws-access-key',
  'content-secrets/github-pat',
  'content-secrets/anthropic-key',
  'content-secrets/openai-key',
  'content-secrets/npm-token',
  'content-secrets/slack-token',
  'content-secrets/google-api-key',
  'content-secrets/stripe-secret',
]);

/**
 * Which checks / rule IDs a single line suppresses. `null` means "all checks".
 */
export type LineSuppression = Set<string> | null;

const DIRECTIVE_RE = /<!--\s*ctxlint-ignore-(next-line|line)((?:\s+[\w/-]+)*)\s*-->/g;
/** The same grammar, anchored: does a directive-shaped comment parse? */
const DIRECTIVE_EXACT_RE = /^<!--\s*ctxlint-ignore-(?:next-line|line)(?:\s+[\w/-]+)*\s*-->$/;
/** Anything that LOOKS like a ctxlint directive, well-formed or not. */
const DIRECTIVE_SHAPED_RE = /<!--\s*ctxlint-[\s\S]*?-->/g;

/**
 * Scan a context file for suppression directives.
 *
 * Returns a map of 1-based line number -> the checks suppressed on that line.
 * A line carrying both a targeted and an untargeted directive resolves to
 * "all checks", since the broader intent wins.
 */
export function collectSuppressions(
  content: string,
  source?: string,
): Map<number, LineSuppression> {
  const suppressions = new Map<number, LineSuppression>();
  const lines = content.split('\n');
  // Lazily classified: most files carry no directive at all.
  let classes: ReturnType<typeof classifyLines> | null = null;

  const add = (lineNumber: number, checks: string[]): void => {
    const existing = suppressions.get(lineNumber);
    // Once a line is suppressed for everything it stays that way.
    if (existing === null) return;
    if (checks.length === 0) {
      suppressions.set(lineNumber, null);
      return;
    }
    const merged = existing ?? new Set<string>();
    for (const check of checks) merged.add(check);
    suppressions.set(lineNumber, merged);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('ctxlint-')) continue;
    classes ??= classifyLines(lines);
    // A fenced line is sample text (e.g. a fenced example showing the syntax).
    if (classes[i].fence) continue;
    // Same for an inline code span: `<!-- ctxlint-ignore-line -->` in prose.
    const probe = maskCodeSpans(line, inlineCodeSpans(line));

    DIRECTIVE_SHAPED_RE.lastIndex = 0;
    let shaped: RegExpExecArray | null;
    while ((shaped = DIRECTIVE_SHAPED_RE.exec(probe)) !== null) {
      if (DIRECTIVE_EXACT_RE.test(shaped[0])) continue;
      const where = source ? `${source}:${i + 1}` : `line ${i + 1}`;
      console.error(
        `Warning: unrecognized ctxlint directive at ${where}: "${shaped[0]}" -- expected <!-- ctxlint-ignore-line [check|rule-id ...] --> or <!-- ctxlint-ignore-next-line [check|rule-id ...] -->`,
      );
    }

    DIRECTIVE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = DIRECTIVE_RE.exec(probe)) !== null) {
      const kind = match[1];
      const checks = (match[2] ?? '').trim().split(/\s+/).filter(Boolean);
      for (const target of checks) {
        if (!target.includes('/') || SUPPRESSIBLE_RULE_IDS.has(target)) continue;
        const where = source ? `${source}:${i + 1}` : `line ${i + 1}`;
        console.error(
          `Warning: ctxlint directive at ${where} names rule ID "${target}", which is unknown or a cross-file rule that cannot be suppressed inline -- it suppresses nothing (rule IDs look like paths/not-found; a bare check name like "paths" covers every rule of that check)`,
        );
      }
      // `next-line` targets i+2 (1-based next line); `line` targets i+1 itself.
      add(kind === 'next-line' ? i + 2 : i + 1, checks);
    }
  }

  return suppressions;
}

/**
 * True when `issue` is silenced by a directive in `suppressions`. A target
 * matches the issue's `check`, its full `ruleId`, or the ruleId's check
 * prefix (the part before the first `/`).
 */
export function isSuppressed(
  suppressions: Map<number, LineSuppression>,
  issue: { line: number; check: string; ruleId?: string },
): boolean {
  if (suppressions.size === 0) return false;
  if (!suppressions.has(issue.line)) return false;
  // `get` is typed `LineSuppression | undefined`; the `has` guard above rules
  // out the `undefined` arm, but `null` is a MEANINGFUL value here (bare
  // directive = suppress everything), so the two cannot be collapsed.
  const checks = suppressions.get(issue.line) as LineSuppression;
  if (checks === null) return true;
  if (checks.has(issue.check)) return true;
  if (!issue.ruleId) return false;
  return checks.has(issue.ruleId) || checks.has(issue.ruleId.split('/')[0]);
}
