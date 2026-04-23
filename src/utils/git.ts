import simpleGit, { type SimpleGit } from 'simple-git';

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
 */
export async function getCommitsSinceBatch(
  projectRoot: string,
  paths: string[],
  since: Date,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const p of paths) counts.set(p, 0);
  if (paths.length === 0) return counts;

  try {
    const git = getGit(projectRoot);
    const SENTINEL = '___CTXLINT_COMMIT___';
    const raw = await git.raw([
      'log',
      `--since=${since.toISOString()}`,
      '--name-only',
      // %n emits a newline; prefixing with a valid format placeholder is
      // what keeps git from rejecting the sentinel as an invalid --pretty
      // format ("fatal: invalid --pretty format: ___CTXLINT_COMMIT___").
      `--format=%n${SENTINEL}`,
    ]);

    // Normalize path separators for cross-platform comparison.
    const normalize = (p: string) => p.replace(/\\/g, '/');
    const requested = new Set(paths.map(normalize));

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
      const changed = normalize(trimmed);
      // Count a changed file against any requested path that matches either
      // exactly or as a prefix (directory reference like `src/components/`).
      for (const req of requested) {
        if (changed === req || changed.startsWith(req.endsWith('/') ? req : req + '/')) {
          seenThisCommit.add(req);
        }
      }
    }
    if (inCommit) flush();
  } catch {
    // Fall through — leave zero counts for every path.
  }

  // Remap back to caller's original (non-normalized) path strings.
  const out = new Map<string, number>();
  for (const p of paths) {
    out.set(p, counts.get(p.replace(/\\/g, '/')) ?? 0);
  }
  return out;
}

export interface RenameInfo {
  oldPath: string;
  newPath: string;
  commitHash: string;
  daysAgo: number;
}

export async function findRenames(
  projectRoot: string,
  filePath: string,
): Promise<RenameInfo | null> {
  try {
    const git = getGit(projectRoot);
    const result = await git.raw([
      'log',
      '--diff-filter=R',
      '--find-renames',
      '--name-status',
      '--format=%H %ai',
      '-10',
      '--',
      filePath,
    ]);

    if (!result.trim()) return null;

    // Track the most recent commit header as we scan. A single commit can
    // contain multiple rename entries; peeking at `lines[i - 1]` broke when
    // that previous line was itself an `R<score>\told\tnew` row, causing
    // commitHash to fall back to 'unknown'.
    let currentHash = 'unknown';
    let currentDateStr: string | undefined;

    const lines = result.trim().split('\n');
    for (const line of lines) {
      const headerMatch = line.match(/^([a-f0-9]{7,40})\s+(.+)$/);
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
          return {
            oldPath: parts[1],
            newPath: parts[2],
            commitHash: currentHash,
            daysAgo,
          };
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}
