import * as path from 'node:path';
import type { LintIssue, ParsedMchpConfig } from '../../types.js';

export async function checkMcphGitignore(
  config: ParsedMchpConfig,
  _projectRoot: string,
): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];

  // --- Rule: mcph-config/local-file-not-gitignored ---
  // Only applies to the .mcph.local.json scope — it exists precisely so
  // teammates don't share machine-local overrides, so it MUST be gitignored.
  // No auto-fix: appending to .gitignore is a different-file side effect the
  // current fixer (line-in-place replace on oldText) can't express safely.
  if (config.scope === 'project-local' && !config.isGitignored) {
    const basename = path.basename(config.filePath);
    issues.push({
      severity: 'error',
      check: 'mcph-gitignore',
      ruleId: 'mcph-config/local-file-not-gitignored',
      line: 1,
      message: `${basename} is not covered by .gitignore — machine-local overrides can leak via git`,
      suggestion: `Add "${basename}" to .gitignore in your project root.`,
    });
  }

  return issues;
}
