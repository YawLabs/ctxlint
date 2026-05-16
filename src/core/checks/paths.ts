import * as path from 'node:path';
import levenshteinPkg from 'fast-levenshtein';
const levenshtein = levenshteinPkg.get;
import { glob } from 'glob';
import { fileExists, isDirectory, getAllProjectFiles } from '../../utils/fs.js';
import { findRenames } from '../../utils/git.js';
import type { ParsedContextFile, LintIssue } from '../types.js';

let cachedProjectFiles: { root: string; files: string[] } | null = null;
let cachedBasenameIndex: { root: string; index: Map<string, string[]> } | null = null;

function getProjectFiles(projectRoot: string): string[] {
  if (cachedProjectFiles?.root === projectRoot) return cachedProjectFiles.files;
  const files = getAllProjectFiles(projectRoot);
  cachedProjectFiles = { root: projectRoot, files };
  return files;
}

function getBasenameIndex(projectRoot: string, files: string[]): Map<string, string[]> {
  if (cachedBasenameIndex?.root === projectRoot) return cachedBasenameIndex.index;
  const index = new Map<string, string[]>();
  for (const file of files) {
    const norm = file.replace(/\\/g, '/');
    const base = path.basename(norm);
    const list = index.get(base);
    if (list) list.push(norm);
    else index.set(base, [norm]);
  }
  cachedBasenameIndex = { root: projectRoot, index };
  return index;
}

export function resetPathsCache(): void {
  cachedProjectFiles = null;
  cachedBasenameIndex = null;
}

export async function checkPaths(
  file: ParsedContextFile,
  projectRoot: string,
): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];
  const projectFiles = getProjectFiles(projectRoot);
  const basenameIndex = getBasenameIndex(projectRoot, projectFiles);

  // Resolve relative paths from the context file's directory
  const contextDir = path.dirname(file.filePath);

  for (const ref of file.references.paths) {
    // Resolve ./foo from context file dir, everything else from project root
    const baseDir =
      ref.value.startsWith('./') || ref.value.startsWith('../') ? contextDir : projectRoot;
    const resolvedPath = path.resolve(baseDir, ref.value);
    const normalizedRef = ref.value.replace(/\\/g, '/');

    // Check if it's a glob pattern
    if (normalizedRef.includes('*')) {
      const matches = await glob(normalizedRef, { cwd: baseDir, nodir: false });
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
      const match = findClosestMatch(normalizedRef, projectFiles, basenameIndex);
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

function findClosestMatch(
  target: string,
  files: string[],
  basenameIndex: Map<string, string[]>,
): string | null {
  const targetNorm = target.replace(/\\/g, '/');
  const targetBase = path.basename(targetNorm);

  // Pass 1: O(1) basename index lookup + small-list levenshtein.
  // Basename-equal candidates in different directories are a strong signal
  // regardless of overall path-edit distance.
  const candidates = basenameIndex.get(targetBase) ?? [];
  let basenameMatch: string | null = null;
  let basenameDistance = Infinity;
  for (const fileNorm of candidates) {
    if (fileNorm !== targetNorm) {
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
