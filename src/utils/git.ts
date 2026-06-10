import * as path from 'node:path';
import simpleGit, { type SimpleGit } from 'simple-git';

/**
 * Normalize a path for cross-platform git comparison:
 *   - if the input is absolute and lives under `projectRoot`, relativize it
 *     against the project root (a Windows caller passing
 *     `C:\repo\src\foo.ts` for a project rooted at `C:\repo` collapses to
 *     `src/foo.ts`, which is what git emits)
 *   - swap backslashes for forward slashes
 *   - collapse `./` segments and resolve interior `../` where syntactically
 *     possible
 *   - on win32, case-fold (Windows filesystems are case-insensitive, so a
 *     doc ref `SRC/Foo.ts` resolves on disk for a file git stores as
 *     `src/foo.ts` and must still match it)
 *
 * Both the caller's referenced paths AND each line of git output get run
 * through this before being compared. Git emits paths relative to the repo
 * root with forward slashes and without drive letters, so normalizing the
 * caller side is what lets `./src/foo.ts`, `src/foo.ts`, and
 * `C:\repo\src\foo.ts` all match the same `src/foo.ts` git output line.
 *
 * Trailing slashes are preserved (caller may pass `src/components/` to
 * indicate "match anything under this dir"); the match logic uses that
 * trailing slash as the directory-boundary signal.
 */
function normalizePath(p: string, projectRoot?: string): string {
  let cleaned = p.replace(/\\/g, '/');
  if (projectRoot && path.isAbsolute(p)) {
    // Use node's path.relative so mixed-separator project roots and (on
    // Windows) a differently-cased projectRoot PREFIX fall out naturally;
    // the relative segment keeps the caller's casing and is handled by the
    // win32 case-fold below. Fall back to the raw input if the absolute
    // path is OUTSIDE the project root -- path.relative would emit
    // `../../...` in that case, which is correct but unlikely to match
    // anything git logs from inside this repo.
    const rel = path.relative(projectRoot, p).replace(/\\/g, '/');
    if (rel && !rel.startsWith('..')) {
      cleaned = rel;
    } else {
      // Strip drive letter as a last-ditch sanitization so we at least
      // don't carry `C:` into the comparison.
      cleaned = cleaned.replace(/^[A-Za-z]:/, '');
    }
  }
  // Preserve trailing `/` (path.posix.normalize keeps it; we don't strip
  // it on purpose -- the match loop relies on it as a directory boundary).
  const normalized = path.posix.normalize(cleaned);
  // Windows filesystems are case-insensitive: a doc ref with the "wrong"
  // casing resolves on disk yet would fail the exact-equality comparison
  // against git's stored casing and silently count 0. Both comparison sides
  // (caller refs and git output lines) run through this function, so folding
  // here keeps them consistent. win32 only -- POSIX filesystems are
  // case-sensitive, where folding would invent matches.
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

let gitInstance: SimpleGit | null = null;
let gitProjectRoot: string | null = null;

export function getGit(projectRoot: string): SimpleGit {
  if (!gitInstance || gitProjectRoot !== projectRoot) {
    gitInstance = simpleGit(projectRoot);
    gitProjectRoot = projectRoot;
  }
  return gitInstance;
}

export function resetGit(): void {
  gitInstance = null;
  gitProjectRoot = null;
}

export async function isGitRepo(projectRoot: string): Promise<boolean> {
  try {
    const git = simpleGit(projectRoot);
    await git.revparse(['--is-inside-work-tree']);
    return true;
  } catch {
    return false;
  }
}

export async function getFileLastModified(
  projectRoot: string,
  filePath: string,
): Promise<Date | null> {
  try {
    const git = getGit(projectRoot);
    const log = await git.log({ file: filePath, maxCount: 1 });
    if (log.latest?.date) {
      return new Date(log.latest.date);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Runs a single `git log --name-only` against the repo and returns a map of
 * {path -> commit count since <date>} for all requested paths. Batched so
 * one subprocess handles N paths (fork+exec is 20-80ms on Windows, so the
 * savings matter on files with many referenced paths).
 *
 * Matching is exact-string or trailing-slash directory-prefix ONLY. Glob
 * metacharacters are compared literally (`src/*.ts` never equals anything
 * git emits), so a raw glob ref silently counts 0 -- callers holding glob
 * refs must convert or drop them first (see the glob handling in
 * staleness.ts).
 */
export async function getCommitsSinceBatch(
  projectRoot: string,
  paths: string[],
  since: Date,
): Promise<Map<string, number>> {
  // Caller-facing output map -- always keyed by the ORIGINAL strings the
  // caller passed in, regardless of how normalization mangled them
  // internally. Preserving the original keys is the function's contract;
  // staleness.ts iterates this map expecting its own ref strings back.
  const out = new Map<string, number>();
  for (const p of paths) out.set(p, 0);
  if (paths.length === 0) return out;

  // Internal counts keyed by the NORMALIZED form. Multiple originals may
  // collapse to the same normalized key (e.g. `src/foo.ts` and
  // `./src/foo.ts`); they share a count slot, then fan back out to each
  // original on the way out.
  const counts = new Map<string, number>();
  const originalToNormalized = new Map<string, string>();
  for (const p of paths) {
    const n = normalizePath(p, projectRoot);
    originalToNormalized.set(p, n);
    if (!counts.has(n)) counts.set(n, 0);
  }

  try {
    const git = getGit(projectRoot);
    const SENTINEL = '___CTXLINT_COMMIT___';
    const raw = await git.raw([
      // Git's default core.quotePath=true wraps non-ASCII paths in quotes
      // with octal escapes ("src/f\303\266\303\266.txt"); nothing below
      // unquotes, so the leading `"` would break both the exact and the
      // directory-prefix comparison. Emit raw UTF-8 instead.
      '-c',
      'core.quotepath=false',
      'log',
      `--since=${since.toISOString()}`,
      '--name-only',
      // %n emits a newline; prefixing with a valid format placeholder is
      // what keeps git from rejecting the sentinel as an invalid --pretty
      // format ("fatal: invalid --pretty format: ___CTXLINT_COMMIT___").
      `--format=%n${SENTINEL}`,
    ]);

    const requested = new Set(counts.keys());

    // Parse commit blocks: sentinel line, optional blank line, then a list of
    // changed paths until the next sentinel.
    const lines = raw.split('\n');
    let inCommit = false;
    const seenThisCommit = new Set<string>();
    const flush = () => {
      for (const p of seenThisCommit) {
        counts.set(p, (counts.get(p) ?? 0) + 1);
      }
      seenThisCommit.clear();
    };

    for (const line of lines) {
      if (line === SENTINEL) {
        if (inCommit) flush();
        inCommit = true;
        continue;
      }
      if (!inCommit) continue;
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Git output paths are already relative to the repo root, but run them
      // through the same normalizer for consistency (collapses any unusual
      // paths git might emit).
      const changed = normalizePath(trimmed);
      // Count a changed file against any requested path that matches either
      // exactly or as a prefix (directory reference like `src/components/`).
      // When `req` already ends in `/`, that slash IS the boundary --
      // startsWith alone is sufficient. Otherwise we synthesize a trailing
      // slash and require the next char in `changed` to be that slash
      // (handled by startsWith on `req + '/'`).
      for (const req of requested) {
        if (changed === req || (req.endsWith('/') && changed.startsWith(req))) {
          seenThisCommit.add(req);
          continue;
        }
        if (changed.startsWith(req + '/')) {
          seenThisCommit.add(req);
        }
      }
    }
    if (inCommit) flush();
  } catch {
    // Fall through -- leave zero counts for every path.
  }

  // Fan normalized counts back out to each caller-supplied original key.
  for (const [original, normalized] of originalToNormalized) {
    out.set(original, counts.get(normalized) ?? 0);
  }
  return out;
}

export interface RenameInfo {
  oldPath: string;
  newPath: string;
  commitHash: string;
  daysAgo: number;
}

function normalizeRenamePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Pure parser for the output of
 *   `git log --diff-filter=R --find-renames --name-status --format=%H %aI`.
 *
 * Extracted from `findRenames` so the line-by-line parsing (commit-header
 * tracking, multi-rename-per-commit handling, the `daysAgo` fallback when no
 * date header has been seen, and the malformed-`R`-line guard) can be unit
 * tested against representative raw git output.
 *
 * When `targetPath` is given, return the rename whose SOURCE (old) path matches
 * it -- exact first; for a BARE filename target (no `/`) fall back to the
 * rename whose source basename matches, provided that basename identifies a
 * single source. This is what lets `findRenames` scan an UN-scoped rename log
 * (the only query that surfaces a renamed-away path; see `findRenames`) and
 * still pick the right entry. With no `targetPath` the first parsable rename
 * wins (the original parser contract).
 *
 * The fallback stays conservative because the result feeds an autofix
 * (paths.ts turns `newPath` into a fix the fixer writes into the user's doc):
 * a pathed target with no exact match returns null rather than guessing, and
 * an ambiguous basename (matching renames with DIFFERENT sources) also
 * returns null.
 */
export function parseRenameLog(result: string, targetPath?: string): RenameInfo | null {
  if (!result.trim()) return null;

  const want = targetPath ? normalizeRenamePath(targetPath) : undefined;
  // Basename fallback applies to bare-filename targets only (a doc may
  // reference `old.ts` while git tracks `src/lib/old.ts`). A pathed ref like
  // `docs/index.md` must NOT basename-match an unrelated
  // `packages/web/index.md` rename -- that would autofix the doc to point at
  // the wrong file.
  const wantBase = want && !want.includes('/') ? want : undefined;

  // Track the most recent commit header as we scan. A single commit can
  // contain multiple rename entries; peeking at `lines[i - 1]` broke when
  // that previous line was itself an `R<score>\told\tnew` row, causing
  // commitHash to fall back to 'unknown'.
  let currentHash = 'unknown';
  let currentDateStr: string | undefined;
  // Newest rename whose source basename matches a bare-filename target, used
  // only when no row matches the target path exactly. Cleared (via the
  // ambiguity flag) when a second matching row has a DIFFERENT source.
  let basenameFallback: RenameInfo | null = null;
  let fallbackAmbiguous = false;

  const lines = result.trim().split('\n');
  for (const line of lines) {
    // Require the shipped `--format=%H %aI` shape: a 7-40 char hex hash, a
    // space, then a year-leading date. `[T ]` after the date accepts both
    // strict-ISO `%aI` (`2026-06-02T18:54:28-07:00`) and the older
    // space-separated `%ai` shape. The looser `\s+(.+)` form would misdetect
    // any non-rename line that merely starts with 7-40 hex chars + whitespace
    // as a commit header, overwriting currentHash/currentDateStr mid-parse.
    const headerMatch = line.match(/^([a-f0-9]{7,40})\s+(\d{4}-\d\d-\d\d[T ].*)$/);
    if (headerMatch) {
      currentHash = headerMatch[1].substring(0, 7);
      currentDateStr = headerMatch[2];
      continue;
    }
    if (line.startsWith('R')) {
      const parts = line.split('\t');
      if (parts.length >= 3) {
        const daysAgo = currentDateStr
          ? Math.floor((Date.now() - new Date(currentDateStr).getTime()) / (1000 * 60 * 60 * 24))
          : 0;
        const info: RenameInfo = {
          oldPath: parts[1],
          newPath: parts[2],
          commitHash: currentHash,
          daysAgo,
        };
        if (!want) return info;
        const oldNorm = normalizeRenamePath(info.oldPath);
        if (oldNorm === want) return info;
        if (wantBase && (oldNorm.split('/').pop() ?? oldNorm) === wantBase) {
          if (!basenameFallback) {
            // First (= newest; the log walks commits newest-first) match wins.
            basenameFallback = info;
          } else if (normalizeRenamePath(basenameFallback.oldPath) !== oldNorm) {
            // A second match with a different source means the bare filename
            // doesn't identify a single file -- don't guess. (The same source
            // matching again is just an older rename of that file; the newest
            // row already held is the right one.)
            fallbackAmbiguous = true;
          }
        }
      }
    }
  }

  return fallbackAmbiguous ? null : basenameFallback;
}

export async function findRenames(
  projectRoot: string,
  filePath: string,
): Promise<RenameInfo | null> {
  try {
    const git = getGit(projectRoot);
    // A path-scoped `git log -- <old>` returns nothing once <old> has been
    // renamed away: the name no longer exists at HEAD, and `--follow` only
    // tracks a path that still exists. So scan recent renames across the repo
    // (unscoped) and let parseRenameLog match the entry whose SOURCE path is
    // filePath. `-50` bounds the walk to the 50 most recent rename commits.
    const result = await git.raw([
      // Raw UTF-8 paths instead of quotePath's quoted octal escapes, which
      // parseRenameLog's matching would never unquote (same rationale as
      // getCommitsSinceBatch).
      '-c',
      'core.quotepath=false',
      'log',
      '--diff-filter=R',
      '--find-renames',
      '--name-status',
      // %aI (strict ISO 8601) parses via the ECMAScript Date spec; %ai's
      // space-separated shape only parses through engine-specific leniency.
      '--format=%H %aI',
      '-50',
    ]);

    return parseRenameLog(result, filePath);
  } catch {
    return null;
  }
}
