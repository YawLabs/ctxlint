import type { ParsedContextFile, LintIssue } from '../types.js';

export interface TokenThresholds {
  info: number;
  warning: number;
  error: number;
  aggregate: number;
  tierBreakdown: number;
  tierAggregate: number;
}

export const DEFAULT_TOKEN_THRESHOLDS: TokenThresholds = {
  info: 1000,
  warning: 3000,
  error: 8000,
  aggregate: 5000,
  tierBreakdown: 1000,
  tierAggregate: 4000,
};

/**
 * Merge user-supplied overrides into DEFAULT_TOKEN_THRESHOLDS. Validates the
 * info < warning < error invariant and, on violation, logs a warning and
 * falls back to defaults. Pure aside from the single stderr line on bad
 * input; safe to call concurrently from independent audit runs.
 *
 * This is the only entry point for resolving thresholds. The previous
 * module-level state (`setTokenThresholds` / `getTokenThresholds`) was
 * removed because long-running hosts (the MCP server) could race on it if
 * audits ever ran concurrently. Threshold resolution now flows through the
 * call chain: caller -> runAudit -> per-check function.
 */
export function resolveTokenThresholds(overrides?: Partial<TokenThresholds>): TokenThresholds {
  if (!overrides) return DEFAULT_TOKEN_THRESHOLDS;
  const merged = { ...DEFAULT_TOKEN_THRESHOLDS, ...overrides };
  if (merged.info >= merged.warning || merged.warning >= merged.error) {
    console.error(
      `Warning: token thresholds should satisfy info < warning < error (got ${merged.info}, ${merged.warning}, ${merged.error}) — using defaults`,
    );
    return DEFAULT_TOKEN_THRESHOLDS;
  }
  return merged;
}

export async function checkTokens(
  file: ParsedContextFile,
  _projectRoot: string,
  thresholds: TokenThresholds = DEFAULT_TOKEN_THRESHOLDS,
): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];
  const tokens = file.totalTokens;

  if (tokens >= thresholds.error) {
    issues.push({
      severity: 'error',
      check: 'tokens',
      ruleId: 'tokens/excessive',
      line: 1,
      message: `${tokens.toLocaleString()} tokens — consumes significant context window space`,
      suggestion: 'Consider splitting into focused sections or removing redundant content.',
    });
  } else if (tokens >= thresholds.warning) {
    issues.push({
      severity: 'warning',
      check: 'tokens',
      ruleId: 'tokens/large',
      line: 1,
      message: `${tokens.toLocaleString()} tokens — large context file`,
      suggestion: 'Consider trimming — research shows diminishing returns past ~300 lines.',
    });
  } else if (tokens >= thresholds.info) {
    issues.push({
      severity: 'info',
      check: 'tokens',
      ruleId: 'tokens/info',
      line: 1,
      message: `Uses ~${tokens.toLocaleString()} tokens per session`,
    });
  }

  return issues;
}

export function checkAggregateTokens(
  files: { path: string; tokens: number }[],
  thresholds: TokenThresholds = DEFAULT_TOKEN_THRESHOLDS,
): LintIssue | null {
  const total = files.reduce((sum, f) => sum + f.tokens, 0);
  if (total > thresholds.aggregate && files.length > 1) {
    return {
      severity: 'warning',
      check: 'tokens',
      ruleId: 'tokens/aggregate',
      line: 0,
      message: `${files.length} context files consume ${total.toLocaleString()} tokens combined`,
      suggestion: 'Consider consolidating or trimming to reduce per-session context cost.',
    };
  }
  return null;
}
