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
