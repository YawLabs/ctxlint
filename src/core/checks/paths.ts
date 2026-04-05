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
  let bestMatch: string | null = null;
  let bestDistance = Infinity;

  for (const file of files) {
    const fileNorm = file.replace(/\\/g, '/');

    // First try exact basename match with different directory
    if (path.basename(fileNorm) === targetBase && fileNorm !== targetNorm) {
      const dist = levenshtein(targetNorm, fileNorm);
      if (dist < bestDistance) {
        bestDistance = dist;
        bestMatch = fileNorm;
      }
    }
  }

  // If no basename match, try Levenshtein on full paths
  if (!bestMatch) {
    for (const file of files) {
      const fileNorm = file.replace(/\\/g, '/');
      const dist = levenshtein(targetNorm, fileNorm);
      if (dist < bestDistance && dist <= Math.max(targetNorm.length * 0.4, 5)) {
        bestDistance = dist;
        bestMatch = fileNorm;
      }
    }
  }

  return bestMatch;
}
