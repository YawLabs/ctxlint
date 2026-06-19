import * as path from 'node:path';
import levenshteinPkg from 'fast-levenshtein';
const levenshtein = levenshteinPkg.get;
import { globIterate } from 'glob';
import { fileExists, isDirectory, getAllProjectFiles } from '../../utils/fs.js';
import { findRenamesBatch, resetRenameCache } from '../../utils/git.js';
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
  resetRenameCache();
}

interface PendingRenameCheck {
  ref: ParsedContextFile['references']['paths'][number];
  normalizedRef: string;
  baseDir: string;
  relTarget: string;
  isImport: boolean;
}

export async function checkPaths(
  file: ParsedContextFile,
  projectRoot: string,
): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];
  const projectFiles = getProjectFiles(projectRoot);

  // Resolve relative paths from the context file's directory
  const contextDir = path.dirname(file.filePath);

  // Accumulator for refs that need rename lookups (not-found, non-glob, non-dir).
  // These are batched into a single findRenamesBatch call after the synchronous
  // pass so the rename log is fetched at most once per projectRoot per tick.
  const pending: PendingRenameCheck[] = [];

  for (const ref of file.references.paths) {
    const rawNormalized = ref.value.replace(/\\/g, '/');

    // Claude Code @-imports (`@./rules/x.md`, `@rules/x.md`, `@../foo.md`,
    // `@~/.claude/foo.md`): the path AFTER the `@` is resolved relative to the
    // importing file's OWN directory (matching Claude Code / combineClaudeMd
    // import semantics), never the project root. Strip the `@` and resolve from
    // contextDir. Without this, `@./rules/x.md` in a subdirectory CLAUDE.md was
    // resolved against the repo root, reported as broken, and fuzzy-"fixed" to
    // an unrelated file -- corrupting durable source on `--fix`.
    const isImport = rawNormalized.startsWith('@');
    const normalizedRef = isImport ? rawNormalized.slice(1) : rawNormalized;

    // @~/... home-relative imports point outside the repo; ctxlint can't
    // validate the user's home dir, so don't flag them.
    if (isImport && normalizedRef.startsWith('~/')) continue;

    // A scoped npm package mention (`@anthropic-ai/sdk`) parses like an
    // @-import but names a package, not a file: exactly two slash-free
    // segments, no extension, no ./ or ../. Skip so it is never reported as a
    // broken path or fuzzy-"fixed" to an unrelated file.
    if (isImport && /^[\w.-]+\/[\w.-]+$/.test(normalizedRef) && !/\.\w+$/.test(normalizedRef)) {
      continue;
    }

    // Where to resolve from. Explicitly-relative refs (./foo, ../foo, and the
    // Windows-style .\foo, ..\foo) and @-imports are always relative to the
    // doc's own directory. A BARE relative ref (`rules/manifest.json`) is
    // ambiguous -- a top-level doc means project-root-relative, a subdirectory
    // doc usually means a sibling of itself -- so try BOTH, project root first.
    // The first base is the one the rename/fix coordinate logic uses when the
    // path resolves nowhere. Resolution uses the slash-normalized form so a
    // Windows-authored ref still validates when the lint host is POSIX.
    const explicitRel = /^\.\.?\//.test(normalizedRef);
    const baseDirs = explicitRel || isImport ? [contextDir] : [projectRoot, contextDir];
    const primaryBase = baseDirs[0];

    // Check if it's a glob pattern
    if (normalizedRef.includes('*')) {
      // Absolute globs (/etc/*.conf) must not be relativized against cwd, or
      // glob would treat them as relative and never match. (path.isAbsolute is
      // platform-specific: a C:/x/*.ts form only classifies absolute on Windows.)
      // Only existence is tested, so iterate and stop at the first match
      // instead of collecting every path the glob expands to.
      let hasMatch = false;
      if (path.isAbsolute(normalizedRef)) {
        const iter = globIterate(normalizedRef, {
          absolute: true,
          nodir: false,
          ignore: GLOB_IGNORE,
        });
        hasMatch = !(await iter.next()).done;
      } else {
        for (const b of baseDirs) {
          const iter = globIterate(normalizedRef, { cwd: b, nodir: false, ignore: GLOB_IGNORE });
          if (!(await iter.next()).done) {
            hasMatch = true;
            break;
          }
        }
      }
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
      if (!baseDirs.some((b) => isDirectory(path.resolve(b, normalizedRef)))) {
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

    const resolvedCandidates = baseDirs.map((b) => path.resolve(b, normalizedRef));
    if (resolvedCandidates.some((p) => fileExists(p) || isDirectory(p))) {
      continue; // Path is valid under at least one candidate base
    }

    // A ref that resolves OUTSIDE the project root under every candidate base
    // is not a repo reference ctxlint can validate: a symlink target relative
    // to where the link lives (`ln -sf ../../scripts/x .git/hooks/y`), an
    // absolute system path, or a `../` escape above the repo. Skip rather than
    // emit a confident-but-wrong "broken path" + autofix into another repo.
    const insideRoot = resolvedCandidates.some((p) => {
      const rel = path.relative(projectRoot, p);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
    if (!insideRoot) continue;

    // Path doesn't exist anywhere sensible -- queue for batched rename lookup.
    // findRenamesBatch matches in git's repo-relative coordinate space, while
    // ref.value may be context-file-relative (./sub/file.md in a subdirectory
    // doc) -- pass the resolved form relativized against the project root so
    // those refs can still exact-match a rename source. A bare-filename ref
    // stays bare (its resolved form relativizes back to itself), preserving the
    // conservative basename fallback.
    const resolvedPath = path.resolve(primaryBase, normalizedRef);
    const relTarget = path.relative(projectRoot, resolvedPath).replace(/\\/g, '/');
    pending.push({ ref, normalizedRef, baseDir: primaryBase, relTarget, isImport });
  }

  // Batch rename lookup -- single git subprocess for all pending refs.
  if (pending.length > 0) {
    const batchResult = await findRenamesBatch(
      projectRoot,
      pending.map((p) => p.relTarget),
    );

    for (const { ref, normalizedRef, baseDir, relTarget, isImport } of pending) {
      const rename = batchResult.get(relTarget) ?? null;

      let suggestion: string | undefined;
      let detail: string | undefined;
      let fixTarget: string | undefined;

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
        fixText = path
          .relative(contextDir, path.resolve(projectRoot, fixTarget))
          .replace(/\\/g, '/');
        // Re-add the leading ./ when the original ref carried one, so the
        // rewritten ref keeps its explicit-relative shape.
        if (/^\.\//.test(normalizedRef) && !fixText.startsWith('.')) {
          fixText = `./${fixText}`;
        }
      }
      // ref.value (oldText) for an @-import carries the leading `@`, which was
      // stripped from normalizedRef before resolution. Re-prefix it so the
      // rewrite replaces `@./rules/x.md` with `@./rules/moved.md`, not a bare
      // `./rules/moved.md` that drops the import marker.
      if (fixText && isImport) {
        fixText = `@${fixText}`;
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
          ? {
              file: file.filePath,
              line: ref.line,
              oldText: ref.value,
              newText: fixText,
              // Anchor the rewrite to this reference's exact column so a stale
              // path that is a substring of a kept path on the same line is not
              // also rewritten. ref.column points at the start of ref.value, and
              // ref.value is a prefix of the raw on-line match, so the fixer's
              // verify-slice (original.slice(col-1, col-1+len) === oldText) holds.
              column: ref.column,
            }
          : undefined,
      });
    }
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
