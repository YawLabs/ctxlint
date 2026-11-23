import * as fs from 'node:fs';
import * as path from 'node:path';
import { globIterate } from 'glob/raw';
import {
  fileExists,
  isDirectory,
  getAllProjectFiles,
  IGNORED_DIRS,
  isOutsideRelative,
} from '../../utils/fs.js';
import { findRenamesBatch, resetRenameCache } from '../../utils/git.js';
import { closestMatch } from './closest-match.js';
import type { ParsedContextFile, LintIssue } from '../types.js';

// Directories a doc glob is never expanded into: the dependency, VCS,
// build-output and cache trees, which are both huge and generated. Without
// this, a glob like `**/*.test.ts` (extractable from plain prose) crawls all of
// node_modules / dist / build on every lint of a large repo just to answer an
// existence question. The list is the shared IGNORED_DIRS (utils/fs.ts), the
// same set getAllProjectFiles skips, so the two cannot drift.
// Tradeoff: an unanchored glob whose ONLY matches live inside these dirs
// reports no-match. A glob that NAMES one of them in its literal prefix
// (`dist/*.js`, `packages/a/build/*.js`) is about that tree, so that entry is
// dropped for it -- see globIgnoreFor.
const GLOB_IGNORE_DIRS: readonly string[] = [...IGNORED_DIRS];

/** Glob metacharacters (extglob `@(...)` etc. included); a segment containing one is not literal. */
const GLOB_MAGIC = /[*?[\]{}]|[!+@]\(/;

/**
 * The ignore list for one glob: GLOB_IGNORE_DIRS minus any directory the
 * pattern's literal prefix (the segments before the first one with a glob
 * metacharacter) walks into explicitly.
 */
function globIgnoreFor(pattern: string): string[] {
  const literal: string[] = [];
  for (const seg of pattern.split('/')) {
    if (GLOB_MAGIC.test(seg)) break;
    literal.push(seg);
  }
  return GLOB_IGNORE_DIRS.filter((d) => !literal.includes(d)).map((d) => `**/${d}/**`);
}

/** Path equality after resolution, ignoring trailing separators and (on Windows) case. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const r = path.resolve(p);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

/**
 * A checker for whether a path's segments below `projectRoot` match real
 * directory entries EXACTLY. Windows and macOS resolve `SRC/App.ts` to
 * `src/App.ts`, Linux does not, so a host-case existence check made results
 * depend on where ctxlint ran -- and a ref that passes locally fails on Linux
 * CI. Comparing against readdir names applies Linux's rule everywhere. Paths
 * outside the project root (already skipped by the caller) keep host rules.
 * Directory listings are cached for the life of the checker.
 *
 * `realSpelling(p)` answers the follow-up question for a path that failed the
 * exact check: the in-root path that matches it ignoring case (project-root-
 * relative, `/`-separated), or null when there is none.
 */
function caseExactChecker(projectRoot: string): {
  exact: (p: string) => boolean;
  realSpelling: (p: string) => string | null;
} {
  const root = path.resolve(projectRoot);
  const listings = new Map<string, Set<string> | null>();
  const entries = (dir: string): Set<string> | null => {
    if (!listings.has(dir)) {
      try {
        listings.set(dir, new Set(fs.readdirSync(dir)));
      } catch {
        listings.set(dir, null);
      }
    }
    return listings.get(dir) ?? null;
  };
  const exact = (p: string): boolean => {
    const rel = path.relative(root, path.resolve(p));
    if (rel === '' || isOutsideRelative(rel)) return true;
    let dir = root;
    for (const seg of rel.split(path.sep)) {
      if (!entries(dir)?.has(seg)) return false;
      dir = path.join(dir, seg);
    }
    return true;
  };
  const realSpelling = (p: string): string | null => {
    const rel = path.relative(root, path.resolve(p));
    if (rel === '' || isOutsideRelative(rel)) return null;
    let dir = root;
    const out: string[] = [];
    for (const seg of rel.split(path.sep)) {
      const names = entries(dir);
      if (!names) return null;
      const lower = seg.toLowerCase();
      const real = names.has(seg) ? seg : [...names].find((n) => n.toLowerCase() === lower);
      if (real === undefined) return null;
      out.push(real);
      dir = path.join(dir, real);
    }
    return out.join('/');
  };
  return { exact, realSpelling };
}

let cachedProjectFiles: { root: string; files: string[] } | null = null;
let cachedBasenameIndex: { root: string; index: Map<string, string[]> } | null = null;

function getProjectFiles(projectRoot: string): string[] {
  if (cachedProjectFiles?.root === projectRoot) return cachedProjectFiles.files;
  const files = getAllProjectFiles(projectRoot);
  cachedProjectFiles = { root: projectRoot, files };
  return files;
}

// Index project files by basename so findClosestMatch's common case (a doc ref
// whose basename exists somewhere in the tree) is an O(1) lookup + small-list
// levenshtein instead of an O(F) scan over every project file. Cached alongside
// cachedProjectFiles and keyed by projectRoot; resetPathsCache clears both.
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
  resetRenameCache();
}

interface PendingRenameCheck {
  ref: ParsedContextFile['references']['paths'][number];
  normalizedRef: string;
  baseDir: string;
  relTarget: string;
  isImport: boolean;
  /**
   * Set when the ref differs from a real path only in case: `text` is the ref
   * rewritten to the real spelling, in the ref's own coordinate space and form.
   */
  caseMatch: { text: string } | null;
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

  // Whether the doc is a ROOT-LEVEL agent-config doc: it sits directly inside a
  // dot-prefixed child of the project root (`<root>/.claude/CLAUDE.md`). Such a
  // doc's ./-relative refs conventionally mean "from the project root" (see the
  // baseDirs decision in the ref loop below). Loop-invariant -- depends only on
  // contextDir and projectRoot -- so compute once here, not per ref.
  const inRootDotConfigDir =
    samePath(path.dirname(contextDir), projectRoot) && path.basename(contextDir).startsWith('.');
  const { exact: caseExact, realSpelling } = caseExactChecker(projectRoot);

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

    // `@/components/ui` is a TS / bundler path alias (tsconfig `paths`, Vite
    // `resolve.alias`) whose target directory ctxlint does not resolve. With
    // the `@` stripped it would read as an absolute filesystem path.
    if (isImport && normalizedRef.startsWith('/')) continue;

    // Where to resolve from. Explicitly-relative refs (./foo, ../foo, and the
    // Windows-style .\foo, ..\foo) and @-imports are always relative to the
    // doc's own directory. A BARE relative ref (`rules/manifest.json`) is
    // ambiguous -- a top-level doc means project-root-relative, a subdirectory
    // doc usually means a sibling of itself -- so try BOTH, project root first.
    // The first base is the one the rename/fix coordinate logic uses when the
    // path resolves nowhere. Resolution uses the slash-normalized form so a
    // Windows-authored ref still validates when the lint host is POSIX.
    const explicitRel = /^\.\.?\//.test(normalizedRef);
    // A ./-relative ref in a ROOT-LEVEL agent-config doc (`<root>/.claude/CLAUDE.md`,
    // detected once as inRootDotConfigDir above) conventionally means "from the
    // project root", not from `.claude/` -- authors treat CLAUDE.md as the project's
    // instructions even though it physically lives in a dot-config dir. So for such a
    // doc, add projectRoot as a SECONDARY base for explicit-relative refs. contextDir
    // stays PRIMARY (baseDirs[0]) so @-import/./ autofix coordinates and rename
    // provenance are unchanged; a secondary base can only turn a false positive into a
    // pass, never create one. @-imports keep strict Claude-Code import semantics
    // (contextDir only) and are excluded.
    const baseDirs = isImport
      ? [contextDir]
      : explicitRel
        ? inRootDotConfigDir
          ? [contextDir, projectRoot]
          : [contextDir]
        : [projectRoot, contextDir];
    const primaryBase = baseDirs[0];
    const resolvedCandidates = baseDirs.map((b) => path.resolve(b, normalizedRef));

    // A ref that resolves OUTSIDE the project root under every candidate base
    // is not a repo reference ctxlint can validate: a symlink target relative
    // to where the link lives (`ln -sf ../../scripts/x .git/hooks/y`), an
    // absolute system path (`/etc/nginx/`), a URL path (`/api/*`), or a `../`
    // escape above the repo (`../other-repo/`). Skip rather than emit a
    // confident-but-wrong "broken path" + autofix into another repo. Checked
    // before the glob and directory branches so every ref shape gets it.
    const insideRoot = resolvedCandidates.some((p) => {
      const rel = path.relative(projectRoot, p);
      return rel === '' || !isOutsideRelative(rel);
    });
    if (!insideRoot) continue;

    // Check if it's a glob pattern
    if (normalizedRef.includes('*')) {
      // Absolute globs (/repo/src/*.ts) must not be relativized against cwd,
      // or glob would treat them as relative and never match. (path.isAbsolute
      // is platform-specific: a C:/x/*.ts form only classifies absolute on
      // Windows.) Only existence is tested, so iterate and stop at the first
      // case-exact match instead of collecting every path the glob expands to.
      // `nocase: false`: glob defaults to case-insensitive wildcard matching on
      // win32/darwin, so `src/*.TS` matched `src/app.ts` there and not on Linux.
      // caseExact below covers the literal segments; this covers the wildcards.
      const ignore = globIgnoreFor(normalizedRef.replace(/^\.\//, ''));
      const cwds = path.isAbsolute(normalizedRef) ? [undefined] : baseDirs;
      let hasMatch = false;
      for (const cwd of cwds) {
        for await (const match of globIterate(normalizedRef, {
          cwd,
          absolute: true,
          nodir: false,
          nocase: false,
          ignore,
        })) {
          if (caseExact(match)) {
            hasMatch = true;
            break;
          }
        }
        if (hasMatch) break;
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
      if (!resolvedCandidates.some((p) => isDirectory(p) && caseExact(p))) {
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

    if (resolvedCandidates.some((p) => (fileExists(p) || isDirectory(p)) && caseExact(p))) {
      continue; // Path is valid under at least one candidate base
    }

    // Path doesn't exist anywhere sensible -- queue for batched rename lookup.
    // findRenamesBatch takes project-root-relative paths (it translates them
    // into git's repo-relative space itself), while ref.value may be context-file-relative (./sub/file.md in a subdirectory
    // doc) -- pass the resolved form relativized against the project root so
    // those refs can still exact-match a rename source. A bare-filename ref
    // stays bare (its resolved form relativizes back to itself), preserving the
    // conservative basename fallback.
    const resolvedPath = path.resolve(primaryBase, normalizedRef);
    const relTarget = path.relative(projectRoot, resolvedPath).replace(/\\/g, '/');
    // A ref one case-change away from a real path opens on Windows/macOS, so
    // "does not exist" would be false there; it is reported as a case mismatch
    // with the real spelling. Same base precedence as the existence check.
    let caseMatch: PendingRenameCheck['caseMatch'] = null;
    for (const [i, p] of resolvedCandidates.entries()) {
      const real = realSpelling(p);
      if (real === null) continue;
      // The rewrite keeps the ref's own coordinate space and shape (`./`, `@`).
      let text = path.relative(baseDirs[i], path.join(projectRoot, real)).replace(/\\/g, '/');
      if (/^\.\//.test(normalizedRef) && !text.startsWith('.')) text = `./${text}`;
      if (isImport) text = `@${text}`;
      caseMatch = { text };
      break;
    }
    pending.push({ ref, normalizedRef, baseDir: primaryBase, relTarget, isImport, caseMatch });
  }

  // Batch rename lookup -- single git subprocess for all pending refs.
  if (pending.length > 0) {
    // relativeTo 'project': git reports renames repo-root-relative, which for a
    // projectRoot below the repo root (a monorepo package) carries the
    // package prefix (pkg/src/new.ts) -- wrong for a project-root-relative fix.
    const batchResult = await findRenamesBatch(
      projectRoot,
      pending.map((p) => p.relTarget),
      { relativeTo: 'project' },
    );

    for (const { ref, normalizedRef, baseDir, relTarget, isImport, caseMatch } of pending) {
      if (caseMatch) {
        issues.push({
          severity: 'error',
          check: 'paths',
          ruleId: 'paths/not-found',
          line: ref.line,
          // Name the spelling the fix writes (ref-relative): a project-root
          // spelling would point a subdirectory doc at the wrong place.
          message: `${ref.value} differs only in case from ${caseMatch.text}, so it fails on case-sensitive file systems`,
          suggestion: `Did you mean ${caseMatch.text}?`,
          fix: {
            file: file.filePath,
            line: ref.line,
            oldText: ref.value,
            newText: caseMatch.text,
            column: ref.column,
          },
        });
        continue;
      }
      const rename = batchResult.get(relTarget) ?? null;

      let suggestion: string | undefined;
      let detail: string | undefined;
      let fixTarget: string | undefined;

      if (rename) {
        fixTarget = rename.newPath;
        suggestion = `Did you mean ${rename.newPath}?`;
        detail = `Renamed ${rename.daysAgo} days ago in commit ${rename.commitHash}`;
      } else {
        // Fuzzy match against project files, in their (project-root-relative)
        // coordinate space. Every hit is suggested; only a confident one is
        // offered to --fix (see findClosestMatch).
        const closest = findClosestMatch(relTarget, projectFiles, basenameIndex);
        if (closest) {
          suggestion = `Did you mean ${closest.match}?`;
          if (closest.fixable) fixTarget = closest.match;
        }
      }

      // fixTarget is always project-root-relative (rename.newPath was asked for
      // with relativeTo 'project'; findClosestMatch's match is project-root-relative), but the
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

/**
 * Basename stems that identify nothing on their own: being the only
 * `index.ts` in the tree does not make it the file a doc's `src/api/index.ts`
 * meant. Compared lowercased, extension removed.
 */
const GENERIC_BASENAMES = new Set([
  'index',
  'main',
  'mod',
  'lib',
  '__init__',
  '__main__',
  'readme',
  'package',
  'tsconfig',
  'makefile',
  'dockerfile',
  'setup',
]);

/**
 * The project file closest to `target` (project-root-relative), and whether
 * it is confident enough to autofix to. Suggestions and fixes have different
 * bars: a wrong suggestion costs the reader a glance, a wrong --fix rewrites
 * durable source to point at an unrelated file.
 */
function findClosestMatch(
  target: string,
  files: string[],
  basenameIndex: Map<string, string[]>,
): { match: string; fixable: boolean } | null {
  const targetNorm = target.replace(/\\/g, '/');
  const targetBase = path.basename(targetNorm);
  const absoluteCap = Math.max(targetNorm.length * 0.4, 5);

  // Pass 1: O(1) basename-index lookup + small-list levenshtein. A file whose
  // basename matches the target's is a strong SUGGESTION regardless of overall
  // path-edit distance, so the pick is uncapped: distance only RANKS among
  // basename-equal candidates. The autofix is stricter: only when that file
  // is the ONLY one with the basename, the basename is not a generic one, and
  // the whole path is within the same cap as pass 2. Pulling the candidates
  // from the prebuilt index instead of scanning every project file makes the
  // common case O(1) + a walk over same-basename files rather than O(F).
  const candidates = (basenameIndex.get(targetBase) ?? []).filter((f) => f !== targetNorm);
  const byBasename = closestMatch(targetNorm, candidates);
  if (byBasename) {
    const stem = targetBase.replace(/\.[^.]*$/, '').toLowerCase();
    const fixable =
      candidates.length === 1 && byBasename.distance <= absoluteCap && !GENERIC_BASENAMES.has(stem);
    return { match: byBasename.match, fixable };
  }

  // Pass 2 (fallback): Levenshtein over full paths with an absolute cap. A
  // hit is a near-identical path (a typo), so it is fixable.
  const byPath = closestMatch(
    targetNorm,
    files.map((f) => f.replace(/\\/g, '/')),
    { maxDistance: absoluteCap },
  );
  return byPath ? { match: byPath.match, fixable: true } : null;
}
