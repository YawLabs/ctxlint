import chalk from 'chalk';
import type { LintResult, LintIssue } from './types.js';

export function formatText(result: LintResult, verbose: boolean = false): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(chalk.bold(`ctxlint v${result.version}`));
  lines.push('');
  lines.push(`Scanning ${result.projectRoot}...`);
  lines.push('');

  // Summary of found files
  const totalTokens = result.summary.totalTokens;
  lines.push(
    `Found ${result.files.length} context file${result.files.length !== 1 ? 's' : ''} (${totalTokens.toLocaleString()} tokens total)`,
  );

  for (const file of result.files) {
    let desc = `  ${file.path} (${file.tokens.toLocaleString()} tokens, ${file.lines} lines)`;
    if (file.isSymlink && file.symlinkTarget) {
      desc = `  ${file.path} ${chalk.dim(`\u2192 ${file.symlinkTarget} (symlink)`)}`;
    }
    lines.push(desc);
  }

  lines.push('');

  // Per-file issues
  for (const file of result.files) {
    const fileIssues = file.issues;
    if (fileIssues.length === 0 && !verbose) continue;

    lines.push(chalk.underline(file.path));

    if (fileIssues.length === 0) {
      lines.push(chalk.green('  \u2713 All checks passed'));
    } else {
      for (const issue of fileIssues) {
        lines.push(formatIssue(issue));
      }
    }

    lines.push('');
  }

  // Summary
  const { errors, warnings, info } = result.summary;
  const parts: string[] = [];
  if (errors > 0) parts.push(chalk.red(`${errors} error${errors !== 1 ? 's' : ''}`));
  if (warnings > 0) parts.push(chalk.yellow(`${warnings} warning${warnings !== 1 ? 's' : ''}`));
  if (info > 0) parts.push(chalk.blue(`${info} info`));

  if (parts.length > 0) {
    lines.push(`Summary: ${parts.join(', ')}`);
  } else {
    lines.push(chalk.green('No issues found!'));
  }

  lines.push(`  Token usage: ${totalTokens.toLocaleString()} tokens per agent session`);

  if (result.summary.estimatedWaste > 0) {
    lines.push(`  Estimated waste: ~${result.summary.estimatedWaste} tokens (redundant content)`);
  }

  lines.push('');

  return lines.join('\n');
}

export function formatJson(result: LintResult): string {
  return JSON.stringify(result, null, 2);
}

export function formatTokenReport(result: LintResult): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(chalk.bold('Token Usage Report'));
  lines.push('');

  const maxPathLen = Math.max(...result.files.map((f) => f.path.length), 4);

  lines.push(
    `  ${chalk.dim('File'.padEnd(maxPathLen))}  ${chalk.dim('Tokens'.padStart(8))}  ${chalk.dim('Lines'.padStart(6))}`,
  );
  lines.push(`  ${'─'.repeat(maxPathLen)}  ${'─'.repeat(8)}  ${'─'.repeat(6)}`);

  for (const file of result.files) {
    const tokenStr = file.tokens.toLocaleString().padStart(8);
    const lineStr = file.lines.toString().padStart(6);
    lines.push(`  ${file.path.padEnd(maxPathLen)}  ${tokenStr}  ${lineStr}`);
  }

  lines.push(`  ${'─'.repeat(maxPathLen)}  ${'─'.repeat(8)}  ${'─'.repeat(6)}`);
  lines.push(
    `  ${'Total'.padEnd(maxPathLen)}  ${result.summary.totalTokens.toLocaleString().padStart(8)}`,
  );

  if (result.summary.estimatedWaste > 0) {
    lines.push('');
    lines.push(
      chalk.yellow(
        `  ~${result.summary.estimatedWaste} tokens estimated waste from redundant content`,
      ),
    );
  }

  lines.push('');

  return lines.join('\n');
}

function formatIssue(issue: LintIssue): string {
  const icon =
    issue.severity === 'error'
      ? chalk.red('\u2717')
      : issue.severity === 'warning'
        ? chalk.yellow('\u26A0')
        : chalk.blue('\u2139');

  const lineRef = issue.line > 0 ? `Line ${issue.line}: ` : '';
  let line = `  ${icon} ${lineRef}${issue.message}`;

  if (issue.suggestion) {
    line += `\n    ${chalk.dim('\u2192')} ${chalk.dim(issue.suggestion)}`;
  }
  if (issue.detail) {
    line += `\n    ${chalk.dim(issue.detail)}`;
  }

  return line;
}
