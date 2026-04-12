import type { ParsedContextFile, LintIssue } from '../types.js';

export interface TokenThresholds {
  info: number;
  warning: number;
  error: number;
  aggregate: number;
  tierBreakdown: number;
  tierAggregate: number;
}

const DEFAULT_THRESHOLDS: TokenThresholds = {
  info: 1000,
  warning: 3000,
  error: 8000,
  aggregate: 5000,
  tierBreakdown: 1000,
  tierAggregate: 4000,
};

let currentThresholds: TokenThresholds = DEFAULT_THRESHOLDS;

export function setTokenThresholds(overrides: Partial<TokenThresholds>): void {
  const merged = { ...DEFAULT_THRESHOLDS, ...overrides };
  if (merged.info >= merged.warning || merged.warning >= merged.error) {
    console.error(
      `Warning: token thresholds should satisfy info < warning < error (got ${merged.info}, ${merged.warning}, ${merged.error}) — using defaults`,
    );
    return;
  }
  currentThresholds = merged;
}

export function resetTokenThresholds(): void {
  currentThresholds = DEFAULT_THRESHOLDS;
}

export function getTokenThresholds(): TokenThresholds {
  return currentThresholds;
}

export async function checkTokens(
  file: ParsedContextFile,
  _projectRoot: string,
): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];
  const tokens = file.totalTokens;

  if (tokens >= currentThresholds.error) {
    issues.push({
      severity: 'error',
      check: 'tokens',
      ruleId: 'tokens/excessive',
      line: 1,
      message: `${tokens.toLocaleString()} tokens — consumes significant context window space`,
      suggestion: 'Consider splitting into focused sections or removing redundant content.',
    });
  } else if (tokens >= currentThresholds.warning) {
    issues.push({
      severity: 'warning',
      check: 'tokens',
      ruleId: 'tokens/large',
      line: 1,
      message: `${tokens.toLocaleString()} tokens — large context file`,
      suggestion: 'Consider trimming — research shows diminishing returns past ~300 lines.',
    });
  } else if (tokens >= currentThresholds.info) {
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

export function checkAggregateTokens(files: { path: string; tokens: number }[]): LintIssue | null {
  const total = files.reduce((sum, f) => sum + f.tokens, 0);
  if (total > currentThresholds.aggregate && files.length > 1) {
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
