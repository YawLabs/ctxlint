import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { simpleGit } from 'simple-git';
import type { AgentProvider, HistoryEntry, MemoryEntry, SessionContext, SiblingRepo } from './types.js';
import { decodeProjectDir, parseMemoryFile } from './session-parser.js';

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
  return AGENT_DIRS.filter((a) => existsSync(a.dir)).map((a) => a.provider);
}

/**
 * Parse a JSONL file line by line, applying a filter to each parsed line.
 * Only keeps lines that match the filter to minimize memory usage.
 */
async function parseJsonlFiltered<T>(
  filePath: string,
  filter: (line: unknown) => T | null,
): Promise<T[]> {
  if (!existsSync(filePath)) return [];
  const content = await readFile(filePath, 'utf-8');
  const results: T[] = [];
  for (const line of content.split('\n')) {
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

    const decodedPath = decodeProjectDir(projDir);
    const files = await readdir(memoryDir).catch(() => []);

    for (const file of files) {
      if (!file.endsWith('.md') || file === 'MEMORY.md') continue;
      try {
        const entry = await parseMemoryFile(join(memoryDir, file), decodedPath);
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
  const siblings: SiblingRepo[] = [];

  let entries: string[];
  try {
    entries = await readdir(parentDir);
  } catch {
    return [];
  }

  // Filter to directories that look like repos
  for (const entry of entries) {
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

    // Skip obvious non-project dirs
    if (entry.startsWith('.') || entry === 'node_modules') continue;

    // Check for git repo or package.json as project indicator
    const isProject =
      existsSync(join(fullPath, '.git')) ||
      existsSync(join(fullPath, 'package.json')) ||
      existsSync(join(fullPath, 'Cargo.toml')) ||
      existsSync(join(fullPath, 'go.mod')) ||
      existsSync(join(fullPath, 'pyproject.toml'));

    if (!isProject) continue;

    const sibling: SiblingRepo = {
      path: entryPath.replace(/\\/g, '/'),
      name: entry,
    };

    // Try to get git org
    try {
      const git = simpleGit(fullPath);
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

    siblings.push(sibling);
  }

  // If too many siblings (>50), filter to same git org only
  if (siblings.length > 50) {
    const currentGit = simpleGit(projectRoot);
    let currentOrg: string | undefined;
    try {
      const remotes = await currentGit.getRemotes(true);
      const origin = remotes.find((r) => r.name === 'origin');
      const orgMatch = origin?.refs?.fetch?.match(/github\.com[:/]([^/]+)\//);
      if (orgMatch) currentOrg = orgMatch[1];
    } catch {
      // no git
    }

    if (currentOrg) {
      return siblings.filter((s) => s.gitOrg === currentOrg);
    }
  }

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
