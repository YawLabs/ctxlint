import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { redactSecrets, redactSecretValue } from './checks/content-secrets.js';
import { redactLiteralCredentials } from './reporter.js';
import { isOutsideRelative } from '../utils/fs.js';
import type { LintResult, FixAction, CheckName } from './types.js';

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
   * If true, skip fixes whose target is a symlink: either the scanner flagged
   * the file as one, or an lstat of the fix's own target says so at apply
   * time (the target can differ from the FileResult's path, and the MCP
   * pillar never sets the flag). Defaults to true: writing through a symlink
   * silently modifies the target, which is almost never what the user wants
   * when `--fix` is auto-applied.
   */
  skipSymlinks?: boolean;
}

interface PendingFix {
  fix: FixAction;
  check: CheckName;
}

// Checks whose fix oldText IS a secret by definition. Their log lines redact
// the whole value, not only the parts a known token pattern matches (a
// high-entropy API_KEY value matches no pattern).
const SECRET_CHECKS: ReadonlySet<CheckName> = new Set<CheckName>([
  'mcp-security',
  'content-secrets',
]);

// Every other fix's text is masked for known token patterns AND for literal
// credentials (a URL password, a secret-named query param, a key-shaped run)
// that sit beside the part the fix changes -- the same treatment the JSON /
// SARIF output gives fix values, so --fix-dry-run cannot leak what --format
// json hides.
function displayFixText(text: string): string {
  return redactLiteralCredentials(redactSecrets(text));
}

function displayOldText(p: PendingFix): string {
  return SECRET_CHECKS.has(p.check)
    ? redactSecretValue(p.fix.oldText)
    : displayFixText(p.fix.oldText);
}

function isSymlinkOnDisk(filePath: string): boolean {
  try {
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch {
    // Missing or unreadable: the read below reports it.
    return false;
  }
}

type JsonValidity = 'strict' | 'jsonc' | 'invalid';
const VALIDITY_RANK: Record<JsonValidity, number> = { strict: 2, jsonc: 1, invalid: 0 };

/**
 * How well `text` parses: strict JSON, JSONC (comments / trailing commas, as
 * VS Code reads `.vscode/mcp.json`), or neither. A leading BOM is ignored --
 * JSON.parse rejects one, but editors and clients tolerate it.
 */
function jsonValidity(text: string): JsonValidity {
  const body = text.replace(/^\uFEFF/, '');
  try {
    JSON.parse(body);
    return 'strict';
  } catch {
    // fall through to the tolerant parse
  }
  const errors: ParseError[] = [];
  parseJsonc(body, errors, { allowTrailingComma: true });
  return errors.length === 0 ? 'jsonc' : 'invalid';
}

export function applyFixes(result: LintResult, options: FixOptions = {}): FixSummary {
  const log = options.quiet ? () => {} : console.log.bind(console);
  const dryRun = options.dryRun ?? false;
  const skipSymlinks = options.skipSymlinks ?? true;

  // Collect all fixable issues grouped by target file, skipping symlinks.
  // Dedupe identical actions: two producers (e.g. the git-rename detector and
  // the fuzzy-match fallback) can propose the same fix, and the second copy
  // would otherwise find its range already claimed and log a spurious
  // "Skipped". The key is a JSON tuple so no field value can collide with
  // another field's (a ':'-joined key made `a:b`+`c` equal `a`+`b:c`).
  const fixesByFile = new Map<string, PendingFix[]>();
  const dedupeKeys = new Map<string, Set<string>>();
  const skippedSymlinks = new Set<string>();
  const symlinkByTarget = new Map<string, boolean>();

  for (const file of result.files) {
    for (const issue of file.issues) {
      const fix = issue.fix;
      if (!fix) continue;
      if (skipSymlinks) {
        let targetIsLink = symlinkByTarget.get(fix.file);
        if (targetIsLink === undefined) {
          targetIsLink = isSymlinkOnDisk(fix.file);
          symlinkByTarget.set(fix.file, targetIsLink);
        }
        if (file.isSymlink || targetIsLink) {
          skippedSymlinks.add(fix.file);
          continue;
        }
      }
      const key = JSON.stringify([
        fix.line,
        fix.oldText,
        fix.newText,
        fix.column ?? null,
        fix.replaceAll ?? false,
      ]);
      let seenInFile = dedupeKeys.get(fix.file);
      if (!seenInFile) {
        seenInFile = new Set();
        dedupeKeys.set(fix.file, seenInFile);
      }
      if (seenInFile.has(key)) continue;
      seenInFile.add(key);

      const existing = fixesByFile.get(fix.file) || [];
      existing.push({ fix, check: issue.check });
      fixesByFile.set(fix.file, existing);
    }
  }

  for (const p of skippedSymlinks) {
    log(chalk.yellow('  Skipped') + ` ${p}: symlink (use --follow-symlinks to override)`);
  }

  let totalFixes = 0;
  const filesModified: string[] = [];

  for (const [filePath, fixes] of fixesByFile) {
    // Every line for this file is printed under one header naming it, so a
    // multi-file preview says which file each "Line N" belongs to.
    const header = chalk.bold(displayPath(filePath, result.projectRoot));
    const emit = (lines: string[]) => {
      if (lines.length === 0) return;
      log(header);
      for (const m of lines) log(m);
    };

    // A fix-target file can vanish or lose read permission between scan and
    // apply (the interactive --fix flow has an unbounded confirmation window
    // in between). Earlier Map entries are already written by this point, so
    // an unguarded throw here would abort with partial fix application and
    // no accurate FixSummary -- skip the file and keep going instead.
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      emit([chalk.yellow('  Skipped') + ` ${filePath}: ${(err as Error).message}`]);
      continue;
    }
    const lines = content.split('\n');
    let modified = false;

    // Group fixes by line so we can apply multiple fixes to the same line
    // against the original content before any modifications. (No line sort
    // needed — fixes are applied via in-place `lines[lineIdx] = ...`, not
    // by splicing, so fix order across lines doesn't shift indices.)
    const fixesByLine = new Map<number, PendingFix[]>();
    for (const p of fixes) {
      const existing = fixesByLine.get(p.fix.line) || [];
      existing.push(p);
      fixesByLine.set(p.fix.line, existing);
    }

    // Stage per-fix counts and log lines locally; only commit them to the
    // returned `totalFixes` and to the user-visible log once the file write
    // is confirmed (or, in dry-run, once we know the result would be valid).
    // Without the staging, a JSON-validation skip would still have already
    // bumped `totalFixes` and printed `Fixed` lines for changes that never
    // landed on disk — over-reporting the work that actually happened.
    // Per-fix skips are reported either way: they describe this run, not
    // the write.
    let perFileFixCount = 0;
    const perFileLogs: string[] = [];
    const perFileSkips: string[] = [];
    const skip = (reason: string) => perFileSkips.push(chalk.yellow('  Skipped') + `: ${reason}`);

    for (const [lineNum, lineFixes] of fixesByLine) {
      const lineIdx = lineNum - 1; // 0-indexed
      if (lineIdx < 0 || lineIdx >= lines.length) {
        for (let i = 0; i < lineFixes.length; i++) skip(`line ${lineNum} is past the end of file`);
        continue;
      }

      const original = lines[lineIdx];
      // Sort longest-oldText-first so a more-specific fix (e.g.
      // `src/old/util.ts` -> `src/new/util.ts`) claims its match ranges
      // before a more-general one that contains it as a substring (e.g.
      // `src/old` -> `src/new`) can claim overlapping ranges.
      // Stable sort is fine -- ties (equal length) keep their original order.
      const orderedLineFixes = [...lineFixes].sort(
        (a, b) => b.fix.oldText.length - a.fix.oldText.length,
      );

      // Every match is located against the ORIGINAL line text, then all
      // claimed ranges are spliced in one pass. Chaining replaceAll on the
      // mutated string let a later fix's oldText re-match an earlier fix's
      // newText output (fix A 'foo'->'bar' + fix B 'bar'->'baz' turned the
      // user's 'foo' into 'baz' -- content nobody asked to change; reachable
      // when two differently-stale refs on one line resolve to the same
      // target). Matching the original means each fix sees only text the
      // user actually wrote. A fix counts once toward the summary when it
      // lands at least one range.
      const replacements: Array<{ start: number; end: number; newText: string }> = [];
      const overlaps = (start: number, end: number) =>
        replacements.some((r) => start < r.end && end > r.start);
      for (const p of orderedLineFixes) {
        const { fix } = p;
        // An empty oldText would match at every position and never advance.
        if (fix.oldText.length === 0) continue;
        let matched = false;
        let found = false;
        if (fix.column != null) {
          // Column-anchored: claim ONLY the occurrence the producer located,
          // so a stale value that is a substring of a KEPT value on the same
          // line (e.g. `src/old.ts` inside `src/old.ts.bak`) is not rewritten
          // too. Verify the line still reads oldText at that column -- it can
          // drift between scan and apply -- and skip (not blind-replace) if not.
          const start = fix.column - 1;
          const end = start + fix.oldText.length;
          if (start >= 0 && original.slice(start, end) === fix.oldText) {
            found = true;
            if (!overlaps(start, end)) {
              replacements.push({ start, end, newText: fix.newText });
              matched = true;
            }
          }
        } else {
          // No column: rewrite the first unclaimed occurrence of oldText on
          // the line, or every occurrence when the producer asked for
          // replaceAll. First-only is the safe default: the line can change
          // between scan and apply, and a blind replaceAll would rewrite
          // copies the producer never looked at.
          let from = 0;
          while (from <= original.length) {
            const start = original.indexOf(fix.oldText, from);
            if (start === -1) break;
            found = true;
            const end = start + fix.oldText.length;
            if (overlaps(start, end)) {
              from = start + 1;
              continue;
            }
            replacements.push({ start, end, newText: fix.newText });
            matched = true;
            if (!fix.replaceAll) break;
            from = end;
          }
        }
        if (matched) {
          perFileFixCount++;
          const prefix = dryRun ? chalk.cyan('  Would fix') : chalk.green('  Fixed');
          perFileLogs.push(
            prefix +
              ` Line ${fix.line}: ${chalk.dim(displayOldText(p))} ${chalk.dim('->')} ${displayFixText(fix.newText)}`,
          );
        } else if (!found) {
          skip(`text not found on line ${fix.line}`);
        } else {
          skip(`text on line ${fix.line} is already claimed by another fix`);
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

    if (!modified) {
      emit(perFileSkips);
      continue;
    }

    const newContent = lines.join('\n');

    // For JSON files, refuse a fix that makes the file parse WORSE than it
    // did. The original's own state is the baseline: a BOM-prefixed file or
    // a JSONC file (comments, trailing commas -- fine for VS Code) is not
    // this fix's fault, and a file that never parsed cannot be judged.
    if (/\.json$/i.test(filePath)) {
      const before = jsonValidity(content);
      const after = jsonValidity(newContent);
      if (VALIDITY_RANK[after] < VALIDITY_RANK[before]) {
        emit([
          ...perFileSkips,
          chalk.yellow('  Skipped') + ` ${filePath}: fix would produce invalid JSON`,
        ]);
        continue;
      }
    }

    if (!dryRun) {
      // Deliberately an in-place write, not temp-file + rename: skill and
      // overlay files are often hardlinked into several trees, and a rename
      // would swap in a new inode and silently detach every other link. The
      // trade-off is atomicity -- a crash mid-write can leave a truncated
      // file. No backup copy is written either; it would litter the repo.
      try {
        fs.writeFileSync(filePath, newContent, 'utf-8');
      } catch (err) {
        // Same partial-application hazard as the read above (e.g. the file
        // turned read-only between scan and apply). Skip before the staged
        // count/logs commit so the FixSummary reflects only what landed.
        emit([
          ...perFileSkips,
          chalk.yellow('  Skipped') + ` ${filePath}: ${(err as Error).message}`,
        ]);
        continue;
      }
    }
    filesModified.push(filePath);
    totalFixes += perFileFixCount;
    emit([...perFileLogs, ...perFileSkips]);
  }

  return { totalFixes, filesModified };
}

/** The fix target relative to the project root when inside it, else absolute. */
function displayPath(filePath: string, projectRoot: string): string {
  if (!projectRoot) return filePath;
  const rel = path.relative(projectRoot, filePath);
  if (!rel || isOutsideRelative(rel)) return filePath;
  return rel.replace(/\\/g, '/');
}
