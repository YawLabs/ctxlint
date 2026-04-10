import * as fs from 'node:fs';
import chalk from 'chalk';
import type { LintResult, FixAction } from './types.js';

export interface FixSummary {
  totalFixes: number;
  filesModified: string[];
}

export interface FixOptions {
  quiet?: boolean;
}

export function applyFixes(result: LintResult, options: FixOptions = {}): FixSummary {
  const log = options.quiet ? () => {} : console.log.bind(console);
  // Collect all fixable issues grouped by file
  const fixesByFile = new Map<string, FixAction[]>();

  for (const file of result.files) {
    for (const issue of file.issues) {
      if (issue.fix) {
        const existing = fixesByFile.get(issue.fix.file) || [];
        existing.push(issue.fix);
        fixesByFile.set(issue.fix.file, existing);
      }
    }
  }

  let totalFixes = 0;
  const filesModified: string[] = [];

  for (const [filePath, fixes] of fixesByFile) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    let modified = false;

    // Sort fixes by line number descending so replacements don't shift line numbers
    const sortedFixes = [...fixes].sort((a, b) => b.line - a.line);

    // Group fixes by line so we can apply multiple fixes to the same line
    // against the original content before any modifications
    const fixesByLine = new Map<number, FixAction[]>();
    for (const fix of sortedFixes) {
      const existing = fixesByLine.get(fix.line) || [];
      existing.push(fix);
      fixesByLine.set(fix.line, existing);
    }

    for (const [lineNum, lineFixes] of fixesByLine) {
      const lineIdx = lineNum - 1; // 0-indexed
      if (lineIdx < 0 || lineIdx >= lines.length) continue;

      let line = lines[lineIdx];
      for (const fix of lineFixes) {
        if (line.includes(fix.oldText)) {
          line = line.replace(fix.oldText, fix.newText);
          totalFixes++;
          log(
            chalk.green('  Fixed') +
              ` Line ${fix.line}: ${chalk.dim(fix.oldText)} ${chalk.dim('\u2192')} ${fix.newText}`,
          );
        }
      }

      if (line !== lines[lineIdx]) {
        lines[lineIdx] = line;
        modified = true;
      }
    }

    if (modified) {
      const newContent = lines.join('\n');

      // For JSON files, validate the result is still valid JSON before writing
      if (filePath.endsWith('.json')) {
        try {
          JSON.parse(newContent);
        } catch {
          log(chalk.yellow('  Skipped') + ` ${filePath}: fix would produce invalid JSON`);
          continue;
        }
      }

      fs.writeFileSync(filePath, newContent, 'utf-8');
      filesModified.push(filePath);
    }
  }

  return { totalFixes, filesModified };
}
