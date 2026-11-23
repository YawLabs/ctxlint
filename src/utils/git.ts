import * as fs from 'node:fs';
import * as path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import { isOutsideRelative } from './fs.js';

/**
 * Platforms whose DEFAULT filesystems are case-insensitive: Windows (NTFS)
 * and macOS (APFS / HFS+ default to case-insensitive, case-preserving). A doc
 * ref with the "wrong" casing resolves on disk there, so comparisons against
 * git's stored casing fold case. Linux (and a case-sensitive APFS volume) keep
 * exact matching; folding there would invent matches.
 */
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

/**
 * Normalize a path for cross-platform git comparison:
 *   - if the input is absolute and lives under `projectRoot`, relativize it
 *     against the project root (a Windows caller passing
 *     `C:\repo\src\foo.ts` for a project rooted at `C:\repo` collapses to
 *     `src/foo.ts`, which is what git emits)
 *   - swap backslashes for forward slashes
 *   - collapse `./` segments and resolve interior `../` where syntactically
 *     possible
 *   - on case-insensitive platforms (CASE_INSENSITIVE_FS), case-fold so a doc
 *     ref `SRC/Foo.ts` that resolves on disk for a file git stores as
 *     `src/foo.ts` still matches it
 *
 * Both the caller's referenced paths AND each line of git output get run
 * through this before being compared. getCommitActivity runs
 * `git log --relative`, so git emits paths relative to projectRoot (not the
 * repo root) with forward slashes and without drive letters; normalizing the
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
    // case-fold below. Fall back to the raw input if the absolute path is
    // OUTSIDE the project root -- path.relative emits `../../...` (or, on
    // Windows across drives, another absolute path) there, which can never
    // match anything git logs from inside this repo.
    const rel = path.relative(projectRoot, p);
    if (rel && !isOutsideRelative(rel)) {
      cleaned = rel.replace(/\\/g, '/');
    } else {
      // Strip drive letter as a last-ditch sanitization so we at least
      // don't carry `C:` into the comparison.
      cleaned = cleaned.replace(/^[A-Za-z]:/, '');
    }
  }
  // Preserve trailing `/` (path.posix.normalize keeps it; we don't strip
  // it on purpose -- the match loop relies on it as a directory boundary).
  const normalized = path.posix.normalize(cleaned);
  // Both comparison sides (caller refs and git output lines) run through this
  // function, so folding here keeps them consistent.
  return CASE_INSENSITIVE_FS ? normalized.toLowerCase() : normalized;
}

/**
 * Build a git pathspec for `p` so `git log -- <pathspec>` filters commits
 * server-side instead of streaming the entire history back to be filtered
 * in-process. Returns null when `p` must NOT become a pathspec:
 *
 *   - a glob ref (`src/*.ts`): getCommitActivity compares globs literally
 *     in-process (they count 0), whereas git would expand `*` as a wildcard --
 *     so a glob is kept out of the server-side filter entirely.
 *   - a ref resolving outside the project root (`../shared/x.ts`, an absolute
 *     path above projectRoot or on another drive): `--relative` drops every
 *     change outside projectRoot so it counts 0 either way, and an
 *     outside-repo pathspec makes git error, which would zero the WHOLE batch.
 *
 * A null result drops only THAT path from the server-side filter; the path is
 * still returned in the caller-facing map and still counts 0 via the in-process
 * pass. When every path returns null the caller omits `--` and falls back to
 * the unfiltered log (correct, just without the memory win).
 *
 * Unlike normalizePath this does NOT lowercase -- git pathspec matching is
 * case-sensitive against the stored tree, so casing is folded with the
 * `:(icase)` magic prefix on case-insensitive platforms instead, mirroring
 * normalizePath's fold so the server-side filter and the in-process comparison
 * agree on which commits count.
 */
function toGitPathspec(p: string, projectRoot: string): string | null {
  if (p.includes('*')) return null;
  let cleaned = p.replace(/\\/g, '/');
  if (path.isAbsolute(p)) {
    const rel = path.relative(projectRoot, p);
    if (!rel || isOutsideRelative(rel)) return null;
    cleaned = rel.replace(/\\/g, '/');
  }
  const normalized = path.posix.normalize(cleaned);
  if (isOutsideRelative(normalized)) return null;
  return CASE_INSENSITIVE_FS ? `:(icase)${normalized}` : normalized;
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

// Per-root memo of the repo probes. Every context file in a run asks the same
// question of the same root; without this each one spawned its own
// `git rev-parse`. Cleared by resetGit(), which the CLI, the MCP server and the
// LSP server call between runs, so a long-running host still notices
// `git init` / an unshallow.
const isRepoMemo = new Map<string, Promise<boolean>>();
const isShallowMemo = new Map<string, Promise<boolean>>();

/**
 * Drop the cached git instance and the per-root repo probes. Long-lived hosts
 * (MCP server, LSP server, watch mode) call this between runs.
 */
export function resetGit(): void {
  gitInstance = null;
  gitProjectRoot = null;
  isRepoMemo.clear();
  isShallowMemo.clear();
}

/** git's own answer that a directory is not in a work tree -- a stable fact. */
const NOT_A_REPO = /not a git repository/i;

/**
 * Memoize `probe` per root. A rejection is an answer worth caching only when
 * git itself said "not a git repository"; any other failure (git missing from
 * PATH, a spawn failure on a loaded machine, a lock) reads as false for THIS
 * call but is not cached, so the next call probes again instead of the whole
 * run -- or a long-lived server -- inheriting a transient error.
 *
 * Exported for tests (an injected probe); callers use isGitRepo / isShallowRepo.
 */
export function memoProbe(
  memo: Map<string, Promise<boolean>>,
  projectRoot: string,
  probe: () => Promise<boolean>,
): Promise<boolean> {
  let result = memo.get(projectRoot);
  if (!result) {
    const pending: Promise<boolean> = probe().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!NOT_A_REPO.test(message) && memo.get(projectRoot) === pending) {
        memo.delete(projectRoot);
      }
      return false;
    });
    result = pending;
    memo.set(projectRoot, result);
  }
  return result;
}

export function isGitRepo(projectRoot: string): Promise<boolean> {
  return memoProbe(isRepoMemo, projectRoot, async () => {
    await simpleGit(projectRoot).revparse(['--is-inside-work-tree']);
    return true;
  });
}

/**
 * True for a shallow clone (`git clone --depth N`, the CI default). History
 * there is truncated at a graft: the boundary commit appears to add every
 * file, so per-file "last commit" history (staleness) is meaningless. An older
 * git that does not know the flag echoes it back, which reads as not shallow.
 */
export function isShallowRepo(projectRoot: string): Promise<boolean> {
  return memoProbe(isShallowMemo, projectRoot, async () => {
    const out = await simpleGit(projectRoot).revparse(['--is-shallow-repository']);
    return out.trim() === 'true';
  });
}

/** A full (SHA-1 or SHA-256) commit hash. */
const FULL_HASH = '(?:[0-9a-f]{64}|[0-9a-f]{40})';

export interface LastCommit {
  /** Full commit hash. */
  hash: string;
  /** Author date of that commit. */
  date: Date;
}

/**
 * The most recent commit touching `filePath` (relative to projectRoot), or
 * null when the file has no history or git is unavailable.
 */
export async function getFileLastCommit(
  projectRoot: string,
  filePath: string,
): Promise<LastCommit | null> {
  try {
    const raw = await getGit(projectRoot).raw(['log', '-1', '--format=%H %aI', '--', filePath]);
    const m = raw.trim().match(new RegExp(`^(${FULL_HASH}) (\\S+)$`));
    if (!m) return null;
    return { hash: m[1], date: new Date(m[2]) };
  } catch {
    return null;
  }
}

export async function getFileLastModified(
  projectRoot: string,
  filePath: string,
): Promise<Date | null> {
  return (await getFileLastCommit(projectRoot, filePath))?.date ?? null;
}

export interface CommitActivity {
  /** Commits touching each requested path, keyed by the caller's original strings. */
  perPath: Map<string, number>;
  /** Distinct commits touching ANY requested path (one commit hitting 3 refs counts once). */
  distinctCommits: number;
}

/**
 * Runs a single `git log --relative --name-only` and counts, for all requested
 * paths, the commits that touched them after `since`. Batched so one
 * subprocess handles N paths (fork+exec is 20-80ms on Windows, so the savings
 * matter on files with many referenced paths).
 *
 * `since` is either `{ commit }` -- counts `<commit>..HEAD`, i.e. commits
 * strictly AFTER it, which is what staleness wants: the doc's own last commit
 * must not count as activity "since" itself -- or a Date (`--since`, which is
 * inclusive of commits at that instant).
 *
 * Paths are relative to projectRoot. `--relative` makes git emit paths in the
 * same space (and drop changes outside projectRoot), so a projectRoot that is
 * a SUBDIRECTORY of the repo (monorepo package) still matches; without it git
 * printed repo-root-relative paths that never equalled the refs.
 *
 * Matching is exact-string or trailing-slash directory-prefix ONLY. Glob
 * metacharacters are compared literally (`src/*.ts` never equals anything
 * git emits), so a raw glob ref silently counts 0 -- callers holding glob
 * refs must convert or drop them first (see the glob handling in
 * staleness.ts).
 */
export async function getCommitActivity(
  projectRoot: string,
  paths: string[],
  since: Date | { commit: string },
): Promise<CommitActivity> {
  // Caller-facing output map -- always keyed by the ORIGINAL strings the
  // caller passed in, regardless of how normalization mangled them
  // internally. Preserving the original keys is the function's contract;
  // staleness.ts iterates this map expecting its own ref strings back.
  const out = new Map<string, number>();
  for (const p of paths) out.set(p, 0);
  if (paths.length === 0) return { perPath: out, distinctCommits: 0 };

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
  let distinctCommits = 0;

  try {
    const git = getGit(projectRoot);
    const SENTINEL = '___CTXLINT_COMMIT___';

    // Server-side path filter: pass the requested paths as `-- <pathspec>` args
    // so git only logs commits that touch them, rather than streaming the whole
    // history into memory to be filtered below. Globs and root-escaping refs
    // are dropped from the pathspec (see toGitPathspec) and still count via the
    // in-process pass. When nothing is server-filterable we omit `--` and log
    // unfiltered -- the in-process pass keeps counts correct.
    const pathspecs: string[] = [];
    for (const p of paths) {
      const spec = toGitPathspec(p, projectRoot);
      if (spec) pathspecs.push(spec);
    }

    const logArgs = [
      // Git's default core.quotePath=true wraps non-ASCII paths in quotes
      // with octal escapes ("src/f\303\266\303\266.txt"); nothing below
      // unquotes, so the leading `"` would break both the exact and the
      // directory-prefix comparison. Emit raw UTF-8 instead.
      '-c',
      'core.quotepath=false',
      'log',
      since instanceof Date ? `--since=${since.toISOString()}` : `${since.commit}..HEAD`,
      '--relative',
      '--name-only',
      // %n emits a newline; prefixing with a valid format placeholder is
      // what keeps git from rejecting the sentinel as an invalid --pretty
      // format ("fatal: invalid --pretty format: ___CTXLINT_COMMIT___").
      `--format=%n${SENTINEL}`,
    ];
    if (pathspecs.length > 0) {
      logArgs.push('--', ...pathspecs);
    }

    const raw = await git.raw(logArgs);

    const requested = new Set(counts.keys());

    // Parse commit blocks: sentinel line, optional blank line, then a list of
    // changed paths until the next sentinel.
    const lines = raw.split('\n');
    let inCommit = false;
    const seenThisCommit = new Set<string>();
    const flush = () => {
      if (seenThisCommit.size > 0) distinctCommits++;
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
      // Git output paths are already projectRoot-relative (--relative); run
      // them through the same normalizer so both sides fold identically.
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
    // Leave zero counts for every path.
    distinctCommits = 0;
    for (const k of counts.keys()) counts.set(k, 0);
  }

  // Fan normalized counts back out to each caller-supplied original key.
  for (const [original, normalized] of originalToNormalized) {
    out.set(original, counts.get(normalized) ?? 0);
  }
  return { perPath: out, distinctCommits };
}

/**
 * Per-path commit counts since `since`. Thin wrapper over getCommitActivity
 * for callers that do not need the distinct-commit total.
 */
export async function getCommitsSinceBatch(
  projectRoot: string,
  paths: string[],
  since: Date | { commit: string },
): Promise<Map<string, number>> {
  return (await getCommitActivity(projectRoot, paths, since)).perPath;
}

export interface RenameInfo {
  oldPath: string;
  newPath: string;
  commitHash: string;
  daysAgo: number;
}

function normalizeRenamePath(p: string): string {
  const cleaned = p.replace(/\\/g, '/').replace(/^\.\//, '');
  // Same case-fold as normalizePath: a doc ref whose casing differs from git's
  // stored casing still resolves on a case-insensitive filesystem, so both
  // rename-match sides must fold consistently or the ref counts commits in
  // staleness yet never matches a rename source. Comparison-only --
  // RenameInfo carries git's raw casing, so the fix text written into the doc
  // is unaffected.
  return CASE_INSENSITIVE_FS ? cleaned.toLowerCase() : cleaned;
}

/** A parsed rename row plus its position in the log (0 = newest). */
interface RenameEntry extends RenameInfo {
  order: number;
}

export interface ParsedRenameLog {
  /** Every parsable rename row, in log order (newest first). */
  entries: RenameEntry[];
  /** Keyed by normalizeRenamePath(oldPath); the newest row per source wins. */
  allRenames: Map<string, RenameEntry>;
  /**
   * Keyed by basename of normalizeRenamePath(oldPath): the newest row per
   * DISTINCT source sharing that basename. More than one entry = ambiguous.
   */
  basenameBuckets: Map<string, RenameEntry[]>;
}

// Require the shipped `--format=%H %aI` shape: a 7-64 char hex hash (abbreviated
// or a full SHA-1 / SHA-256 object name), whitespace, then a year-leading date.
// `[T ]` after the date accepts both strict-ISO `%aI`
// (`2026-06-02T18:54:28-07:00`) and the older space-separated `%ai` shape. A
// looser `\s+(.+)` form would misdetect any non-rename line that merely starts
// with hex chars + whitespace as a commit header, overwriting the current
// hash/date mid-parse.
const RENAME_HEADER_RE = /^([a-f0-9]{7,64})\s+(\d{4}-\d\d-\d\d[T ].*)$/;

/**
 * Pure parser for the output of
 *   `git log --diff-filter=R --find-renames --name-status --format=%H %aI`.
 *
 * Tracks the most recent commit header while scanning, since one commit can
 * carry several `R<score>\told\tnew` rows (peeking at the previous line broke
 * when that line was itself a rename row). A row before any header gets the
 * literal hash 'unknown' and daysAgo 0; a row with fewer than three tab parts
 * is skipped.
 */
export function parseRenameLogAll(result: string): ParsedRenameLog {
  const entries: RenameEntry[] = [];
  const allRenames = new Map<string, RenameEntry>();
  const basenameBuckets = new Map<string, RenameEntry[]>();
  if (!result.trim()) return { entries, allRenames, basenameBuckets };

  let currentHash = 'unknown';
  let currentDateStr: string | undefined;

  for (const line of result.trim().split('\n')) {
    const headerMatch = line.match(RENAME_HEADER_RE);
    if (headerMatch) {
      currentHash = headerMatch[1].substring(0, 7);
      currentDateStr = headerMatch[2];
      continue;
    }
    if (!line.startsWith('R')) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const daysAgo = currentDateStr
      ? Math.floor((Date.now() - new Date(currentDateStr).getTime()) / (1000 * 60 * 60 * 24))
      : 0;
    const entry: RenameEntry = {
      oldPath: parts[1],
      newPath: parts[2].replace(/\r$/, ''),
      commitHash: currentHash,
      daysAgo,
      order: entries.length,
    };
    entries.push(entry);

    const oldNorm = normalizeRenamePath(entry.oldPath);
    // Newest entry wins (log walks newest-first); only insert if not yet seen.
    if (!allRenames.has(oldNorm)) allRenames.set(oldNorm, entry);
    const base = path.posix.basename(oldNorm);
    const bucket = basenameBuckets.get(base);
    if (!bucket) {
      basenameBuckets.set(base, [entry]);
    } else if (!bucket.some((r) => normalizeRenamePath(r.oldPath) === oldNorm)) {
      // Only the newest entry per distinct source path; the same source again
      // is an older rename of that file.
      bucket.push(entry);
    }
  }

  return { entries, allRenames, basenameBuckets };
}

/**
 * Follow a rename forward through later renames: for `a -> b` then (newer)
 * `b -> c`, a lookup of `a` must point at `c` -- `b` no longer exists. Only a
 * NEWER rename of the intermediate path is followed (an older `b -> x` was a
 * different file that happened to share the name). The result keeps the
 * original source and the commit that first renamed it away.
 */
function followRenameChain(parsed: ParsedRenameLog, start: RenameEntry): RenameInfo {
  let current = start;
  const visited = new Set<RenameEntry>([start]);
  for (;;) {
    const next = parsed.allRenames.get(normalizeRenamePath(current.newPath));
    if (!next || visited.has(next) || next.order >= current.order) break;
    visited.add(next);
    current = next;
  }
  return {
    oldPath: start.oldPath,
    newPath: current.newPath,
    commitHash: start.commitHash,
    daysAgo: start.daysAgo,
  };
}

/**
 * Look up the rename whose SOURCE path is `target` (git repo-root-relative):
 * exact first; then, when `bareName` is given (a bare filename with no `/`),
 * the rename whose source basename matches, provided that basename identifies
 * a single source. The match is followed through later renames.
 *
 * The fallback stays conservative because the result feeds an autofix
 * (paths.ts turns `newPath` into a fix the fixer writes into the user's doc):
 * a pathed target with no exact match returns null rather than guessing --
 * `docs/index.md` must NOT basename-match an unrelated `packages/web/index.md`
 * rename -- and an ambiguous basename (renames with DIFFERENT sources) also
 * returns null.
 */
function lookupRename(
  parsed: ParsedRenameLog,
  target: string,
  bareName: string | undefined,
): RenameInfo | null {
  const exact = parsed.allRenames.get(normalizeRenamePath(target));
  if (exact) return followRenameChain(parsed, exact);
  if (bareName === undefined) return null;
  const bucket = parsed.basenameBuckets.get(normalizeRenamePath(bareName));
  if (!bucket || bucket.length !== 1) return null;
  return followRenameChain(parsed, bucket[0]);
}

/** The bare-filename form of `p` (normalized), or undefined when it has a `/`. */
function bareFilename(p: string): string | undefined {
  const n = normalizeRenamePath(p);
  return n.includes('/') ? undefined : n;
}

/**
 * Pure lookup over a rename log (see parseRenameLogAll for the input shape).
 *
 * With `targetPath`, returns the rename whose source matches it (see
 * lookupRename for the exact-then-unique-basename contract and the chain
 * following). With no `targetPath` the first parsable rename wins.
 */
export function parseRenameLog(result: string, targetPath?: string): RenameInfo | null {
  const parsed = parseRenameLogAll(result);
  if (targetPath === undefined) {
    return parsed.entries.length > 0 ? followRenameChain(parsed, parsed.entries[0]) : null;
  }
  return lookupRename(parsed, targetPath, bareFilename(targetPath));
}

/**
 * Translate a projectRoot-relative (or absolute, inside the root) path into
 * git's repo-root-relative coordinate space by prepending `--show-prefix`
 * (projectRoot's path below the repo root, computed BY git) rather than
 * path.relative against `--show-toplevel`: git reports the toplevel in
 * canonical long form, while the caller's projectRoot may be an alias of the
 * same directory (Windows 8.3 short names like RUNNER~1, subst drives), and a
 * textual cross-comparison between the two forms silently fails. The
 * remaining segment is caller-space vs caller-space, so aliasing cancels out.
 * A path outside the root is returned in the caller's form.
 */
function toRepoTarget(projectRoot: string, prefix: string, filePath: string): string {
  const rel = path.relative(projectRoot, path.resolve(projectRoot, filePath));
  if (!rel || isOutsideRelative(rel)) return filePath;
  return prefix + rel.replace(/\\/g, '/');
}

/** Repo root reached from projectRoot by climbing one level per prefix segment. */
function repoRootFromPrefix(projectRoot: string, prefix: string): string {
  const depth = prefix.split('/').filter(Boolean).length;
  return path.resolve(projectRoot, ...Array<string>(depth).fill('..'));
}

/**
 * Resolve one caller path against a parsed log: exact match on the
 * repo-root-relative target, then the bare-filename fallback (using the
 * caller's own bare form when relativization turned `old.ts` into
 * `pkg/old.ts`). A suggestion whose final path does not exist on disk is
 * dropped -- the autofix must never point a doc at another missing file.
 */
function resolveRename(
  parsed: ParsedRenameLog,
  projectRoot: string,
  prefix: string,
  filePath: string,
): RenameInfo | null {
  const target = toRepoTarget(projectRoot, prefix, filePath);
  const info = lookupRename(parsed, target, bareFilename(filePath) ?? bareFilename(target));
  if (!info) return null;
  const onDisk = path.join(repoRootFromPrefix(projectRoot, prefix), info.newPath);
  return fs.existsSync(onDisk) ? info : null;
}

const RENAME_LOG_ARGS = [
  // Raw UTF-8 paths instead of quotePath's quoted octal escapes, which the
  // rename matching would never unquote (same rationale as getCommitActivity).
  '-c',
  'core.quotepath=false',
  'log',
  '--diff-filter=R',
  '--find-renames',
  '--name-status',
  // %aI (strict ISO 8601) parses via the ECMAScript Date spec; %ai's
  // space-separated shape only parses through engine-specific leniency.
  '--format=%H %aI',
];

async function readPrefix(git: SimpleGit): Promise<string> {
  try {
    return (await git.revparse(['--show-prefix'])).trim();
  } catch {
    // Prefix unavailable (GIT_DIR oddities): empty, which is correct when
    // projectRoot IS the repo root.
    return '';
  }
}

/**
 * `filePath` is interpreted relative to `projectRoot` (absolute paths inside
 * the root are accepted too). A ref that is relative to something else --
 * e.g. a `./sub/file.md` doc ref resolved from the context file's own
 * directory -- must be resolved by the caller first, or the coordinate
 * relativization lands on the wrong repo path.
 *
 * Paths in the result are git repo-root-relative unless `options.relativeTo`
 * is `'project'` (see FindRenamesOptions).
 */
export async function findRenames(
  projectRoot: string,
  filePath: string,
  options: FindRenamesOptions = {},
): Promise<RenameInfo | null> {
  try {
    const git = getGit(projectRoot);
    // A path-scoped `git log -- <old>` returns nothing once <old> has been
    // renamed away: the name no longer exists at HEAD, and `--follow` only
    // tracks a path that still exists. So scan recent renames across the repo
    // (unscoped) and match the entry whose SOURCE path is filePath. `-50`
    // bounds the walk to the 50 most recent rename commits.
    const raw = await git.raw([...RENAME_LOG_ARGS, '-50']);
    const prefix = await readPrefix(git);
    const info = resolveRename(parseRenameLogAll(raw), projectRoot, prefix, filePath);
    return options.relativeTo === 'project' ? toProjectCoords(prefix, info) : info;
  } catch {
    return null;
  }
}

interface RenameLogCache {
  parsed: ParsedRenameLog;
  prefix: string;
}

const renameCache = new Map<string, RenameLogCache>(); // key: projectRoot

export function resetRenameCache(): void {
  renameCache.clear();
}

export interface FindRenamesOptions {
  /**
   * Coordinate space of the returned `oldPath` / `newPath`. `'repo'` (the
   * default) is git's repo-root-relative form; `'project'` re-expresses both
   * relative to `projectRoot`, which differs when projectRoot is a repo
   * SUBDIRECTORY (`pkg/src/new.ts` -> `src/new.ts`; a target outside the
   * package comes back as `../other/x.ts`). Done textually with git's
   * `--show-prefix`, so filesystem aliasing of projectRoot cannot skew it.
   */
  relativeTo?: 'repo' | 'project';
}

/**
 * Re-express a repo-root-relative path relative to the `--show-prefix` dir
 * (`prefix` is git's form: forward slashes, trailing slash, '' at the root).
 */
export function fromRepoToProject(prefix: string, repoPath: string): string {
  if (!prefix) return repoPath;
  if (repoPath.startsWith(prefix)) return repoPath.slice(prefix.length);
  return path.posix.relative(prefix.replace(/\/$/, ''), repoPath);
}

function toProjectCoords(prefix: string, info: RenameInfo | null): RenameInfo | null {
  if (!info) return null;
  return {
    ...info,
    oldPath: fromRepoToProject(prefix, info.oldPath),
    newPath: fromRepoToProject(prefix, info.newPath),
  };
}

/**
 * Batched variant of `findRenames`: runs the rename log ONCE per `projectRoot`
 * (full history, no `-50` cap -- one subprocess pays for all N queried
 * paths), caches the parsed result, and resolves every `relPath` exactly as
 * findRenames would (same target translation, fallback, chain following and
 * existence check). Subsequent calls with the same `projectRoot` serve from
 * cache until resetRenameCache().
 *
 * Returns a Map keyed by each input `relPath`; the value is `RenameInfo` on
 * a match, `null` on no match or an ambiguous basename. Paths in the result
 * are repo-root-relative unless `options.relativeTo` is `'project'`.
 */
export async function findRenamesBatch(
  projectRoot: string,
  relPaths: readonly string[],
  options: FindRenamesOptions = {},
): Promise<Map<string, RenameInfo | null>> {
  const result = new Map<string, RenameInfo | null>();
  if (relPaths.length === 0) return result;

  let cache = renameCache.get(projectRoot);
  if (!cache) {
    try {
      const git = getGit(projectRoot);
      const raw = await git.raw(RENAME_LOG_ARGS);
      cache = { parsed: parseRenameLogAll(raw), prefix: await readPrefix(git) };
      renameCache.set(projectRoot, cache);
    } catch {
      // Git unavailable or not a repo -- return null for every path.
      for (const p of relPaths) result.set(p, null);
      return result;
    }
  }

  const { prefix } = cache;
  for (const relPath of relPaths) {
    const info = resolveRename(cache.parsed, projectRoot, prefix, relPath);
    result.set(relPath, options.relativeTo === 'project' ? toProjectCoords(prefix, info) : info);
  }
  return result;
}
