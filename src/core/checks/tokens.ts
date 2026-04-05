import type { ParsedContextFile, LintIssue } from '../types.js';

const INFO_THRESHOLD = 1000;
const WARNING_THRESHOLD = 3000;
const ERROR_THRESHOLD = 8000;

export async function checkTokens(
  file: ParsedContextFile,
  _projectRoot: string,
): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];
  const tokens = file.totalTokens;

  if (tokens >= ERROR_THRESHOLD) {
    issues.push({
      severity: 'error',
      check: 'tokens',
      line: 1,
      message: `${tokens.toLocaleString()} tokens — consumes significant context window space`,
      suggestion: 'Consider splitting into focused sections or removing redundant content.',
    });
  } else if (tokens >= WARNING_THRESHOLD) {
    issues.push({
      severity: 'warning',
      check: 'tokens',
      line: 1,
      message: `${tokens.toLocaleString()} tokens — large context file`,
      suggestion: 'Consider trimming — research shows diminishing returns past ~300 lines.',
    });
  } else if (tokens >= INFO_THRESHOLD) {
    issues.push({
      severity: 'info',
      check: 'tokens',
      line: 1,
      message: `Uses ~${tokens.toLocaleString()} tokens per session`,
    });
  }

  return issues;
}

export function checkAggregateTokens(files: { path: string; tokens: number }[]): LintIssue | null {
  const total = files.reduce((sum, f) => sum + f.tokens, 0);
  if (total > 5000 && files.length > 1) {
    return {
      severity: 'warning',
      check: 'tokens',
      line: 0,
      message: `${files.length} context files consume ${total.toLocaleString()} tokens combined`,
      suggestion: 'Consider consolidating or trimming to reduce per-session context cost.',
    };
  }
  return null;
}
