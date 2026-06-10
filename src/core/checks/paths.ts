import * as path from 'node:path';
import levenshteinPkg from 'fast-levenshtein';
const levenshtein = levenshteinPkg.get;
import { glob } from 'glob';
import { fileExists, isDirectory, getAllProjectFiles } from '../../utils/fs.js';
import { findRenames } from '../../utils/git.js';
import type { ParsedContextFile, LintIssue } from '../types.js';

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
      const matches = path.isAbsolute(normalizedRef)
        ? await glob(normalizedRef, { absolute: true, nodir: false })
        : await glob(normalizedRef, { cwd: baseDir, nodir: false });
      if (matches.length === 0) {
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

    // Check for git renames
    const rename = await findRenames(projectRoot, ref.value);
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

    issues.push({
      severity: 'error',
      check: 'paths',
      ruleId: 'paths/not-found',
      line: ref.line,
      message: `${ref.value} does not exist`,
      suggestion,
      detail,
      fix: fixTarget
        ? { file: file.filePath, line: ref.line, oldText: ref.value, newText: fixTarget }
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
