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

export async function getCommitsSince(
  projectRoot: string,
  filePath: string,
  since: Date,
): Promise<number> {
  try {
    const git = getGit(projectRoot);
    const log = await git.log({
      file: filePath,
      '--since': since.toISOString(),
    });
    return log.total;
  } catch {
    return 0;
  }
}

/**
 * Batched version of getCommitsSince: runs a single `git log --name-only`
 * against the repo and returns a map of {path → commit count since <date>}
 * for all requested paths. Much faster than N individual `getCommitsSince`
 * calls because each of those spawns a `git` subprocess (20-80ms on Windows).
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
      `--format=${SENTINEL}`,
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

    const lines = result.trim().split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('R')) {
        const parts = line.split('\t');
        if (parts.length >= 3) {
          const hashLine = lines[i - 1] || '';
          const hashMatch = hashLine.match(/^([a-f0-9]+)\s+(.+)/);
          const commitHash = hashMatch?.[1]?.substring(0, 7) || 'unknown';
          const dateStr = hashMatch?.[2];
          const daysAgo = dateStr
            ? Math.floor((Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24))
            : 0;

          return {
            oldPath: parts[1],
            newPath: parts[2],
            commitHash,
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
