// Granular per-finding suppression for ctxlint.
//
// `ignoreRules` is a sibling of the long-standing `ignore: CheckName[]` field
// in `.ctxlintrc.json`. `ignore` drops a whole check class; `ignoreRules`
// drops individual findings by check + message regex + (for stale-memory)
// path regex.
//
// Trust posture: ignore-rule regexes are repo-author-trusted, same posture
// as `.eslintrc.json`. We compile them with `new RegExp(...)` and run them
// against issue messages with no step cap. A malicious `.ctxlintrc.json` in
// a repo you've already cloned is out of scope -- this is for project
// maintainers tuning their own audit signal, not user-submitted input.
import type { LintIssue, CheckName } from './types.js';

export interface IgnoreRule {
  /** Required: which check this rule applies to. Use exact CheckName. */
  check: CheckName;
  /** Optional: regex tested against the finding's `message`. */
  match?: string;
  /** Optional: regex tested against each extracted path in the finding.
   *  Only applies to `session-stale-memory`. If EVERY path in a finding
   *  matches the pattern, the finding is dropped. */
  pathPattern?: string;
  /** Optional but recommended -- surfaces in "review me" tail. */
  reason?: string;
}

interface CompiledRule {
  check: CheckName;
  match?: RegExp;
  pathPattern?: RegExp;
  reason?: string;
  // Track whether the rule fired at least once. Unused rules surface as
  // "ignore drift" debt -- the same pattern the /yaw-session-audit skill uses.
  fired: boolean;
  // Keep the original string patterns so drift-report output reproduces what
  // the user wrote in .ctxlintrc.json verbatim. Reading `RegExp.source`
  // re-escapes `/` (V8 returns `^\/x` for a pattern compiled from `^/x`),
  // which would surface as user-visible noise in unusedRules.
  matchSource?: string;
  pathPatternSource?: string;
}

export interface IgnoreApplyResult {
  kept: LintIssue[];
  dropped: number;
  unusedRules: IgnoreRule[];
  rulesMissingReason: IgnoreRule[];
}

export function compileRules(rules: IgnoreRule[]): CompiledRule[] {
  return rules.map((r) => ({
    check: r.check,
    match: r.match ? new RegExp(r.match) : undefined,
    pathPattern: r.pathPattern ? new RegExp(r.pathPattern) : undefined,
    reason: r.reason,
    fired: false,
    matchSource: r.match,
    pathPatternSource: r.pathPattern,
  }));
}

/**
 * Extract the path-list segment from a session-stale-memory message.
 * Current message format (stale-memory.ts:53):
 *   `Memory "<name>" references N path(s) that no longer exist: <a>, <b>`
 * We split on ': ' once and then on ', '. If the format ever changes, this
 * is the single place to update.
 *
 * TODO(structured-paths-followup): migrate to a structured
 * `issue.affectedPaths?: string[]` on `LintIssue` once a second check needs
 * the same affordance. Until then, this parser is coupled to the exact
 * message string emitted by checkStaleMemory.
 */
export function extractPathsFromMessage(msg: string): string[] {
  const idx = msg.lastIndexOf(': ');
  if (idx === -1) return [];
  return msg
    .slice(idx + 2)
    .split(', ')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function applyIgnoreRules(issues: LintIssue[], rules: IgnoreRule[]): IgnoreApplyResult {
  const compiled = compileRules(rules);
  const kept: LintIssue[] = [];
  let dropped = 0;

  for (const issue of issues) {
    let suppress = false;
    for (const rule of compiled) {
      if (rule.check !== issue.check) continue;

      // pathPattern: only for session-stale-memory; ALL paths must match.
      if (rule.pathPattern) {
        if (issue.check !== 'session-stale-memory') continue;
        const paths = extractPathsFromMessage(issue.message);
        if (paths.length === 0) continue;
        const allMatch = paths.every((p) => rule.pathPattern!.test(p));
        if (!allMatch) continue;
      }

      // match: regex against the message.
      if (rule.match && !rule.match.test(issue.message)) continue;

      // First matching rule wins.
      suppress = true;
      rule.fired = true;
      break;
    }
    if (suppress) {
      dropped++;
    } else {
      kept.push(issue);
    }
  }

  return {
    kept,
    dropped,
    unusedRules: compiled.filter((r) => !r.fired).map(stripCompiled),
    rulesMissingReason: rules.filter((r) => !r.reason),
  };
}

function stripCompiled(r: CompiledRule): IgnoreRule {
  return {
    check: r.check,
    match: r.matchSource,
    pathPattern: r.pathPatternSource,
    reason: r.reason,
  };
}
