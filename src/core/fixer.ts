import * as fs from 'node:fs';
import chalk from 'chalk';
import type { LintResult, FixAction } from './types.js';

export interface FixSummary {
  totalFixes: number;
  filesModified: string[];
}

export interface FixOptions {
  quiet?: boolean;
  /**
   * Preview the diff without writing. Still returns accurate `totalFixes` and
   * `filesModified` counts (treated as "would-modify") so the caller can size
   * the summary. Use this for `--fix-dry-run` or when the user hasn't
   * confirmed a write.
   */
  dryRun?: boolean;
  /**
   * If true, skip fixes on files the scanner marked as symlinks. Defaults to
   * true: writing through a symlink silently modifies the target, which is
   * almost never what the user wants when `--fix` is auto-applied.
   */
  skipSymlinks?: boolean;
}

export function applyFixes(result: LintResult, options: FixOptions = {}): FixSummary {
  const log = options.quiet ? () => {} : console.log.bind(console);
  const dryRun = options.dryRun ?? false;
  const skipSymlinks = options.skipSymlinks ?? true;

  // Build a quick lookup: which files in the result are symlinks?
  const symlinkFiles = new Set<string>();
  if (skipSymlinks) {
    for (const f of result.files) {
      if (f.isSymlink) symlinkFiles.add(f.path);
    }
  }

  // Collect all fixable issues grouped by file, skipping symlinks. Dedupe on
  // (line, oldText, newText) because an earlier version silently dropped the
  // second of two fixes targeting the same (line, oldText) — line.replace()
  // only touches the first occurrence, so the second iteration became a no-op.
  const fixesByFile = new Map<string, FixAction[]>();
  const dedupeKeys = new Map<string, Set<string>>();
  const skippedSymlinks = new Set<string>();

  for (const file of result.files) {
    for (const issue of file.issues) {
      if (issue.fix) {
        if (skipSymlinks && file.isSymlink) {
          skippedSymlinks.add(file.path);
          continue;
        }
        const key = `${issue.fix.line}:${issue.fix.oldText}:${issue.fix.newText}`;
        let seenInFile = dedupeKeys.get(issue.fix.file);
        if (!seenInFile) {
          seenInFile = new Set();
          dedupeKeys.set(issue.fix.file, seenInFile);
        }
        if (seenInFile.has(key)) continue;
        seenInFile.add(key);

        const existing = fixesByFile.get(issue.fix.file) || [];
        existing.push(issue.fix);
        fixesByFile.set(issue.fix.file, existing);
      }
    }
  }

  for (const p of skippedSymlinks) {
    log(chalk.yellow('  Skipped') + ` ${p}: symlink (use --follow-symlinks to override)`);
  }

  let totalFixes = 0;
  const filesModified: string[] = [];

  for (const [filePath, fixes] of fixesByFile) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    let modified = false;

    // Group fixes by line so we can apply multiple fixes to the same line
    // against the original content before any modifications. (No line sort
    // needed — fixes are applied via in-place `lines[lineIdx] = ...`, not
    // by splicing, so fix order across lines doesn't shift indices.)
    const fixesByLine = new Map<number, FixAction[]>();
    for (const fix of fixes) {
      const existing = fixesByLine.get(fix.line) || [];
      existing.push(fix);
      fixesByLine.set(fix.line, existing);
    }

    // Stage per-fix counts and log lines locally; only commit them to the
    // returned `totalFixes` and to the user-visible log once the file write
    // is confirmed (or, in dry-run, once we know the result would be valid).
    // Without the staging, a JSON-validation skip would still have already
    // bumped `totalFixes` and printed `Fixed` lines for changes that never
    // landed on disk — over-reporting the work that actually happened.
    let perFileFixCount = 0;
    const perFileLogs: string[] = [];

    for (const [lineNum, lineFixes] of fixesByLine) {
      const lineIdx = lineNum - 1; // 0-indexed
      if (lineIdx < 0 || lineIdx >= lines.length) continue;

      let line = lines[lineIdx];
      for (const fix of lineFixes) {
        if (line.includes(fix.oldText)) {
          // replaceAll (not replace) so that if the same oldText literal
          // appears twice on one line — e.g. "see src/old/x.ts and src/old/y.ts"
          // where the dir got renamed — every occurrence is rewritten.
          // Fix actions carry literal strings (no regex), so replaceAll on a
          // string is the correct, non-escaping form.
          line = line.replaceAll(fix.oldText, fix.newText);
          perFileFixCount++;
          const prefix = dryRun ? chalk.cyan('  Would fix') : chalk.green('  Fixed');
          perFileLogs.push(
            prefix +
              ` Line ${fix.line}: ${chalk.dim(fix.oldText)} ${chalk.dim('->')} ${fix.newText}`,
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

      if (!dryRun) {
        fs.writeFileSync(filePath, newContent, 'utf-8');
      }
      filesModified.push(filePath);
      totalFixes += perFileFixCount;
      for (const m of perFileLogs) log(m);
    }
  }

  return { totalFixes, filesModified };
}
