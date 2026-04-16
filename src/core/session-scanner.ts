import { readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { simpleGit } from 'simple-git';
import type {
  AgentProvider,
  HistoryEntry,
  MemoryEntry,
  SessionContext,
  SiblingRepo,
} from './types.js';
import { parseMemoryFile } from './session-parser.js';

const home = process.env.HOME || process.env.USERPROFILE || '';

/** Known agent data directories and their providers */
const AGENT_DIRS: Array<{ provider: AgentProvider; dir: string; historyFile?: string }> = [
  { provider: 'claude-code', dir: join(home, '.claude'), historyFile: 'history.jsonl' },
  { provider: 'codex-cli', dir: join(home, '.codex'), historyFile: 'history.jsonl' },
  { provider: 'vibe-cli', dir: join(home, '.vibe') },
  {
    provider: 'amazon-q',
    dir: join(home, '.aws', 'amazonq'),
  },
  {
    provider: 'goose',
    dir:
      process.platform === 'win32'
        ? join(process.env.APPDATA || '', 'Block', 'goose')
        : join(home, '.config', 'goose'),
  },
  { provider: 'continue', dir: join(home, '.continue') },
  {
    provider: 'windsurf',
    dir: join(home, '.windsurf'),
  },
];

/**
 * Detect which agent providers are installed on this machine.
 */
export function detectProviders(): AgentProvider[] {
  // If neither HOME nor USERPROFILE is set, `home` is empty and
  // `join('', '.claude')` produces the relative path `.claude`. `existsSync`
  // on that resolves against cwd, so a project that happens to have its
  // own `.claude/` would get mistaken for the user's global agent data.
  // All other readers (`readClaudeHistory`, `readClaudeMemories`, etc.) are
  // gated on this returning the matching provider, so short-circuiting here
  // is sufficient to prevent any cwd-relative lookups.
  if (!home) return [];
  return AGENT_DIRS.filter((a) => existsSync(a.dir)).map((a) => a.provider);
}

/**
 * Parse a JSONL file line by line using streaming to avoid loading large files
 * (e.g. history.jsonl can grow to 100MB+) entirely into memory.
 */
async function parseJsonlFiltered<T>(
  filePath: string,
  filter: (line: unknown) => T | null,
): Promise<T[]> {
  if (!existsSync(filePath)) return [];
  const results: T[] = [];
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      const result = filter(parsed);
      if (result) results.push(result);
    } catch {
      // skip malformed lines
    }
  }
  return results;
}

/**
 * Read Claude Code history.jsonl — filter to command entries only.
 */
async function readClaudeHistory(): Promise<HistoryEntry[]> {
  const historyPath = join(home, '.claude', 'history.jsonl');
  return parseJsonlFiltered(historyPath, (entry: any) => {
    if (!entry.display || !entry.project) return null;
    return {
      display: entry.display,
      timestamp: entry.timestamp || 0,
      project: entry.project.replace(/\\/g, '/'),
      sessionId: entry.sessionId || '',
      provider: 'claude-code' as AgentProvider,
    };
  });
}

/**
 * Read Codex CLI history.jsonl.
 */
async function readCodexHistory(): Promise<HistoryEntry[]> {
  const historyPath = join(home, '.codex', 'history.jsonl');
  return parseJsonlFiltered(historyPath, (entry: any) => {
    if (!entry.display && !entry.command) return null;
    return {
      display: entry.display || entry.command || '',
      timestamp: entry.timestamp || 0,
      project: (entry.project || entry.cwd || '').replace(/\\/g, '/'),
      sessionId: entry.sessionId || '',
      provider: 'codex-cli' as AgentProvider,
    };
  });
}

/**
 * Read all Claude Code memory files across all projects.
 */
async function readClaudeMemories(): Promise<MemoryEntry[]> {
  const projectsDir = join(home, '.claude', 'projects');
  if (!existsSync(projectsDir)) return [];

  const memories: MemoryEntry[] = [];
  const projectDirs = await readdir(projectsDir).catch(() => []);

  for (const projDir of projectDirs) {
    const memoryDir = join(projectsDir, projDir, 'memory');
    if (!existsSync(memoryDir)) continue;

    // Store the encoded directory name as projectDir — callers use
    // projectDirMatchesPath() to compare against real filesystem paths.
    const files = await readdir(memoryDir).catch(() => []);

    for (const file of files) {
      if (!file.endsWith('.md') || file === 'MEMORY.md') continue;
      try {
        const entry = await parseMemoryFile(join(memoryDir, file), projDir);
        memories.push(entry);
      } catch {
        // skip unreadable files
      }
    }
  }

  return memories;
}

/**
 * Detect per-project aider history files across sibling repos.
 * Aider stores history in the project directory itself.
 */
function detectAiderInSiblings(siblings: SiblingRepo[]): AgentProvider | null {
  for (const sib of siblings) {
    if (existsSync(join(sib.path, '.aider.chat.history.md'))) {
      return 'aider';
    }
  }
  return null;
}

/**
 * Detect sibling repositories.
 * Default: same parent directory. Falls back to git org matching if too many.
 */
export async function detectSiblings(projectRoot: string): Promise<SiblingRepo[]> {
  const parentDir = dirname(resolve(projectRoot));

  let entries: string[];
  try {
    entries = await readdir(parentDir);
  } catch {
    return [];
  }

  // First pass: cheaply collect candidate project directories (no git calls)
  const candidates: Array<{ fullPath: string; entryPath: string; name: string }> = [];
  for (const entry of entries) {
    // Skip obvious non-project dirs (cheap string check before I/O)
    if (entry.startsWith('.') || entry === 'node_modules') continue;

    const fullPath = join(parentDir, entry);
    const entryPath = resolve(fullPath);

    // Skip current project
    if (entryPath === resolve(projectRoot)) continue;

    try {
      const s = await stat(fullPath);
      if (!s.isDirectory()) continue;
    } catch {
      continue;
    }

    // Check for git repo or package.json as project indicator
    const isProject =
      existsSync(join(fullPath, '.git')) ||
      existsSync(join(fullPath, 'package.json')) ||
      existsSync(join(fullPath, 'Cargo.toml')) ||
      existsSync(join(fullPath, 'go.mod')) ||
      existsSync(join(fullPath, 'pyproject.toml'));

    if (!isProject) continue;
    candidates.push({ fullPath, entryPath, name: entry });
  }

  // If too many candidates, get current org first and only resolve git for matches
  if (candidates.length > 50) {
    let currentOrg: string | undefined;
    try {
      const currentGit = simpleGit(projectRoot);
      const remotes = await currentGit.getRemotes(true);
      const origin = remotes.find((r) => r.name === 'origin');
      const orgMatch = origin?.refs?.fetch?.match(/github\.com[:/]([^/]+)\//);
      if (orgMatch) currentOrg = orgMatch[1];
    } catch {
      // no git
    }

    // Only resolve git remotes for candidates with .git dirs
    const gitCandidates = candidates.filter((c) => existsSync(join(c.fullPath, '.git')));
    const results = await Promise.all(
      gitCandidates.map(async (c) => {
        const sibling: SiblingRepo = { path: c.entryPath.replace(/\\/g, '/'), name: c.name };
        try {
          const git = simpleGit(c.fullPath);
          const remotes = await git.getRemotes(true);
          const origin = remotes.find((r) => r.name === 'origin');
          if (origin?.refs?.fetch) {
            sibling.gitRemoteUrl = origin.refs.fetch;
            const orgMatch = origin.refs.fetch.match(/github\.com[:/]([^/]+)\//);
            if (orgMatch) sibling.gitOrg = orgMatch[1];
          }
        } catch {
          // not a git repo or no remote
        }
        return sibling;
      }),
    );

    if (currentOrg) {
      return results.filter((s) => s.gitOrg === currentOrg);
    }
    return results;
  }

  // Normal path: resolve git remotes in parallel
  const siblings = await Promise.all(
    candidates.map(async (c) => {
      const sibling: SiblingRepo = { path: c.entryPath.replace(/\\/g, '/'), name: c.name };
      try {
        const git = simpleGit(c.fullPath);
        const remotes = await git.getRemotes(true);
        const origin = remotes.find((r) => r.name === 'origin');
        if (origin?.refs?.fetch) {
          sibling.gitRemoteUrl = origin.refs.fetch;
          const orgMatch = origin.refs.fetch.match(/github\.com[:/]([^/]+)\//);
          if (orgMatch) sibling.gitOrg = orgMatch[1];
        }
      } catch {
        // not a git repo or no remote
      }
      return sibling;
    }),
  );

  return siblings;
}

/**
 * Build the complete session context for a project.
 */
export async function scanSessionData(projectRoot: string): Promise<SessionContext> {
  const providers = detectProviders();

  // Read history from all installed providers in parallel
  const historyPromises: Promise<HistoryEntry[]>[] = [];
  if (providers.includes('claude-code')) historyPromises.push(readClaudeHistory());
  if (providers.includes('codex-cli')) historyPromises.push(readCodexHistory());

  const [histories, memories, siblings] = await Promise.all([
    Promise.all(historyPromises).then((arrays) => arrays.flat()),
    providers.includes('claude-code') ? readClaudeMemories() : Promise.resolve([]),
    detectSiblings(projectRoot),
  ]);

  // Check if aider is used in any sibling
  const aider = detectAiderInSiblings(siblings);
  if (aider && !providers.includes('aider')) {
    providers.push('aider');
  }

  return {
    history: histories,
    memories,
    siblings,
    currentProject: resolve(projectRoot).replace(/\\/g, '/'),
    providers,
  };
}
