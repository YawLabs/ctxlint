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
 * That path reference is accurate and useful, and `paths/file-not-found` is
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
 *
 * Scope is deliberately one line. A file-wide or block-wide disable is easy to
 * add and easy to leave behind: the whole value of these findings is that they
 * fail loudly when a path really does break, and a stale file-level disable
 * silently turns that off forever.
 */

/** Which checks a single line suppresses. `null` means "all checks". */
export type LineSuppression = Set<string> | null;

const DIRECTIVE_RE = /<!--\s*ctxlint-ignore-(next-line|line)((?:\s+[\w-]+)*)\s*-->/g;

/**
 * Scan a context file for suppression directives.
 *
 * Returns a map of 1-based line number -> the checks suppressed on that line.
 * A line carrying both a targeted and an untargeted directive resolves to
 * "all checks", since the broader intent wins.
 */
export function collectSuppressions(content: string): Map<number, LineSuppression> {
  const suppressions = new Map<number, LineSuppression>();
  const lines = content.split('\n');

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
    if (!line.includes('ctxlint-ignore-')) continue;

    DIRECTIVE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = DIRECTIVE_RE.exec(line)) !== null) {
      const kind = match[1];
      const checks = (match[2] ?? '').trim().split(/\s+/).filter(Boolean);
      // `next-line` targets i+2 (1-based next line); `line` targets i+1 itself.
      add(kind === 'next-line' ? i + 2 : i + 1, checks);
    }
  }

  return suppressions;
}

/** True when `issue` is silenced by a directive in `suppressions`. */
export function isSuppressed(
  suppressions: Map<number, LineSuppression>,
  issue: { line: number; check: string },
): boolean {
  if (suppressions.size === 0) return false;
  if (!suppressions.has(issue.line)) return false;
  // `get` is typed `LineSuppression | undefined`; the `has` guard above rules
  // out the `undefined` arm, but `null` is a MEANINGFUL value here (bare
  // directive = suppress everything), so the two cannot be collapsed.
  const checks = suppressions.get(issue.line) as LineSuppression;
  if (checks === null) return true;
  return checks.has(issue.check);
}
