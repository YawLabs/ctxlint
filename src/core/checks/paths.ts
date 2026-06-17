import * as path from 'node:path';
import levenshteinPkg from 'fast-levenshtein';
const levenshtein = levenshteinPkg.get;
import { globIterate } from 'glob';
import { fileExists, isDirectory, getAllProjectFiles } from '../../utils/fs.js';
import { findRenames } from '../../utils/git.js';
import type { ParsedContextFile, LintIssue } from '../types.js';

// Mirrors scanner.ts IGNORED_DIRS. Without it, a doc glob like
// `**/*.test.ts` (extractable from plain prose) crawls all of node_modules /
// dist / build on every lint of a large repo just to answer an existence
// question. Tradeoff: a glob whose ONLY matches live inside these dirs now
// reports no-match -- consistent with the project-file walk, which never
// surfaces those dirs either.
const GLOB_IGNORE = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'];

let cachedProjectFiles: { root: string; files: string[] } | null = null;

function getProjectFiles(projectRoot: string): string[] {
  if (cachedProjectFiles?.root === projectRoot) return cachedProjectFiles.files;
  const files = getAllProjectFiles(projectRoot);
  cachedProjectFiles = { root: projectRoot, files };
  return files;
}

export function resetPathsCache(): void {
  cachedProjectFiles = null;
}

export async function checkPaths(
  file: ParsedContextFile,
  projectRoot: string,
): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];
  const projectFiles = getProjectFiles(projectRoot);

  // Resolve relative paths from the context file's directory
  const contextDir = path.dirname(file.filePath);

  for (const ref of file.references.paths) {
    const normalizedRef = ref.value.replace(/\\/g, '/');
    // Resolve explicitly-relative refs (./foo, ../foo, and the Windows-style
    // .\foo, ..\foo) from the context file's directory, everything else from
    // the project root. Resolution uses the slash-normalized form so a
    // Windows-authored ref still validates when the lint host is POSIX.
    const baseDir = /^\.\.?\//.test(normalizedRef) ? contextDir : projectRoot;
    const resolvedPath = path.resolve(baseDir, normalizedRef);

    // Check if it's a glob pattern
    if (normalizedRef.includes('*')) {
      // Absolute globs (/etc/*.conf) must not be relativized against cwd, or
      // glob would treat them as relative and never match. (path.isAbsolute is
      // platform-specific: a C:/x/*.ts form only classifies absolute on Windows.)
      // Only existence is tested, so iterate and stop at the first match
      // instead of collecting every path the glob expands to.
      const iter = path.isAbsolute(normalizedRef)
        ? globIterate(normalizedRef, { absolute: true, nodir: false, ignore: GLOB_IGNORE })
        : globIterate(normalizedRef, { cwd: baseDir, nodir: false, ignore: GLOB_IGNORE });
      const hasMatch = !(await iter.next()).done;
      if (!hasMatch) {
        issues.push({
          severity: 'error',
          check: 'paths',
          ruleId: 'paths/glob-no-match',
          line: ref.line,
          message: `${ref.value} matches no files`,
          suggestion: 'Verify the glob pattern is correct',
        });
      }
      continue;
    }

    // Check if path exists as file or directory
    const isDir = normalizedRef.endsWith('/');
    if (isDir) {
      const dirPath = path.resolve(baseDir, normalizedRef);
      if (!isDirectory(dirPath)) {
        issues.push({
          severity: 'error',
          check: 'paths',
          ruleId: 'paths/directory-not-found',
          line: ref.line,
          message: `${ref.value} directory does not exist`,
        });
      }
      continue;
    }

    if (fileExists(resolvedPath) || isDirectory(resolvedPath)) {
      continue; // Path is valid
    }

    // Path doesn't exist — try to find what happened
    let suggestion: string | undefined;
    let detail: string | undefined;
    let fixTarget: string | undefined;

    // Check for git renames. findRenames matches in git's repo-relative
    // coordinate space, while ref.value may be context-file-relative
    // (./sub/file.md in a subdirectory doc) -- pass the resolved form
    // relativized against the project root so those refs can still
    // exact-match a rename source. A bare-filename ref stays bare (its
    // resolved form relativizes back to itself), preserving the
    // conservative basename fallback.
    const rename = await findRenames(
      projectRoot,
      path.relative(projectRoot, resolvedPath).replace(/\\/g, '/'),
    );
    if (rename) {
      fixTarget = rename.newPath;
      suggestion = `Did you mean ${rename.newPath}?`;
      detail = `Renamed ${rename.daysAgo} days ago in commit ${rename.commitHash}`;
    } else {
      // Fuzzy match against project files
      const match = findClosestMatch(normalizedRef, projectFiles);
      if (match) {
        fixTarget = match;
        suggestion = `Did you mean ${match}?`;
      }
    }

    // fixTarget is always project-root-relative (rename.newPath is git
    // repo-relative; findClosestMatch returns project-root-relative), but the
    // autofix replaces ref.value literally on its line. When the ref was
    // resolved from the context file's OWN directory (an explicit ./.. ref),
    // a root-relative newText would be re-interpreted relative to contextDir
    // by the consumer -- e.g. './sub/file.md' -> 'docs/sub/moved.md' reads as
    // docs/docs/sub/moved.md. Re-express the target in the ref's OWN base so
    // newText and oldText share a coordinate space. The human-readable
    // suggestion keeps the project-root-relative form.
    let fixText = fixTarget;
    if (fixTarget && baseDir === contextDir) {
      fixText = path.relative(contextDir, path.resolve(projectRoot, fixTarget)).replace(/\\/g, '/');
      // Re-add the leading ./ when the original ref carried one, so the
      // rewritten ref keeps its explicit-relative shape.
      if (/^\.\//.test(normalizedRef) && !fixText.startsWith('.')) {
        fixText = `./${fixText}`;
      }
    }

    issues.push({
      severity: 'error',
      check: 'paths',
      ruleId: 'paths/not-found',
      line: ref.line,
      message: `${ref.value} does not exist`,
      suggestion,
      detail,
      fix: fixText
        ? { file: file.filePath, line: ref.line, oldText: ref.value, newText: fixText }
        : undefined,
    });
  }

  return issues;
}

function findClosestMatch(target: string, files: string[]): string | null {
  const targetNorm = target.replace(/\\/g, '/');
  const targetBase = path.basename(targetNorm);

  // Pass 1: prefer files whose basename matches exactly (different directory).
  // Deliberately uncapped: basename equality is the signal, so the nearest
  // basename-equal candidate wins no matter how large the overall path-edit
  // distance is. Distance is used only to RANK among basename-equal
  // candidates; the absolute cap below belongs to the full-path fallback
  // pass alone.
  let basenameMatch: string | null = null;
  let basenameDistance = Infinity;
  for (const file of files) {
    const fileNorm = file.replace(/\\/g, '/');
    if (path.basename(fileNorm) === targetBase && fileNorm !== targetNorm) {
      const dist = levenshtein(targetNorm, fileNorm);
      if (dist < basenameDistance) {
        basenameDistance = dist;
        basenameMatch = fileNorm;
      }
    }
  }
  if (basenameMatch) return basenameMatch;

  // Pass 2 (fallback): Levenshtein over full paths with an absolute cap.
  // Length prefilter: |len(a) - len(b)| is a lower bound on Levenshtein
  // distance, so any candidate whose length differs from the target by more
  // than the current best can be skipped without computing.
  const absoluteCap = Math.max(targetNorm.length * 0.4, 5);
  let fullPathMatch: string | null = null;
  let fullPathDistance = Infinity;
  for (const file of files) {
    const fileNorm = file.replace(/\\/g, '/');
    const lenDelta = Math.abs(targetNorm.length - fileNorm.length);
    if (lenDelta >= fullPathDistance || lenDelta > absoluteCap) continue;
    const dist = levenshtein(targetNorm, fileNorm);
    if (dist < fullPathDistance && dist <= absoluteCap) {
      fullPathDistance = dist;
      fullPathMatch = fileNorm;
    }
  }
  return fullPathMatch;
}
