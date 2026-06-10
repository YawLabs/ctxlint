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
    // A fix-target file can vanish or lose read permission between scan and
    // apply (the interactive --fix flow has an unbounded confirmation window
    // in between). Earlier Map entries are already written by this point, so
    // an unguarded throw here would abort with partial fix application and
    // no accurate FixSummary -- skip the file and keep going instead.
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      log(chalk.yellow('  Skipped') + ` ${filePath}: ${(err as Error).message}`);
      continue;
    }
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

      const original = lines[lineIdx];
      // Sort longest-oldText-first so a more-specific fix (e.g.
      // `src/old/util.ts` -> `src/new/util.ts`) claims its match ranges
      // before a more-general one that contains it as a substring (e.g.
      // `src/old` -> `src/new`) can claim overlapping ranges.
      // Stable sort is fine -- ties (equal length) keep their original order.
      const orderedLineFixes = [...lineFixes].sort((a, b) => b.oldText.length - a.oldText.length);

      // Every match is located against the ORIGINAL line text, then all
      // claimed ranges are spliced in one pass. Chaining replaceAll on the
      // mutated string let a later fix's oldText re-match an earlier fix's
      // newText output (fix A 'foo'->'bar' + fix B 'bar'->'baz' turned the
      // user's 'foo' into 'baz' -- content nobody asked to change; reachable
      // when two differently-stale refs on one line resolve to the same
      // target). Matching the original means each fix sees only text the
      // user actually wrote. All occurrences of an oldText are still
      // rewritten (replaceAll semantics), and a fix counts once toward the
      // summary when it lands at least one range.
      const replacements: Array<{ start: number; end: number; newText: string }> = [];
      for (const fix of orderedLineFixes) {
        // An empty oldText would match at every position and never advance.
        if (fix.oldText.length === 0) continue;
        let matched = false;
        let from = 0;
        while (from <= original.length) {
          const start = original.indexOf(fix.oldText, from);
          if (start === -1) break;
          const end = start + fix.oldText.length;
          const overlapsClaimed = replacements.some((r) => start < r.end && end > r.start);
          if (overlapsClaimed) {
            from = start + 1;
          } else {
            replacements.push({ start, end, newText: fix.newText });
            matched = true;
            from = end;
          }
        }
        if (matched) {
          perFileFixCount++;
          const prefix = dryRun ? chalk.cyan('  Would fix') : chalk.green('  Fixed');
          perFileLogs.push(
            prefix +
              ` Line ${fix.line}: ${chalk.dim(fix.oldText)} ${chalk.dim('->')} ${fix.newText}`,
          );
        }
      }

      if (replacements.length > 0) {
        replacements.sort((a, b) => a.start - b.start);
        let rebuilt = '';
        let pos = 0;
        for (const r of replacements) {
          rebuilt += original.slice(pos, r.start) + r.newText;
          pos = r.end;
        }
        rebuilt += original.slice(pos);
        if (rebuilt !== original) {
          lines[lineIdx] = rebuilt;
          modified = true;
        }
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
        try {
          fs.writeFileSync(filePath, newContent, 'utf-8');
        } catch (err) {
          // Same partial-application hazard as the read above (e.g. the file
          // turned read-only between scan and apply). Skip before the staged
          // count/logs commit so the FixSummary reflects only what landed.
          log(chalk.yellow('  Skipped') + ` ${filePath}: ${(err as Error).message}`);
          continue;
        }
      }
      filesModified.push(filePath);
      totalFixes += perFileFixCount;
      for (const m of perFileLogs) log(m);
    }
  }

  return { totalFixes, filesModified };
}
