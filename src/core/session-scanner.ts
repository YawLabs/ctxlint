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
    // On win32 the goose dir lives under %APPDATA%. If APPDATA is unset,
    // `join('', 'Block', 'goose')` yields the cwd-relative `Block/goose`,
    // which the HOME guard in `detectProviders` does NOT catch (HOME/USERPROFILE
    // may still be set). Leave the dir empty so `existsSync('')` is always false
    // and we never match a cwd-relative `Block/goose`, mirroring the HOME-guard intent.
    dir:
      process.platform === 'win32'
        ? process.env.APPDATA
          ? join(process.env.APPDATA, 'Block', 'goose')
          : ''
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
 * Pick the first non-empty string value from `entry` among the given field
 * names. Returns `''` when none are present, so callers decide what counts
 * as "missing" (some providers require the value, some tolerate empty).
 */
function pickField(entry: Record<string, unknown>, fields: readonly string[]): string {
  for (const f of fields) {
    const v = entry[f];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '';
}

interface JsonlHistoryReaderOptions {
  /** Path to the provider's history.jsonl. */
  historyPath: string;
  /** Provider tag to stamp on each emitted entry. */
  provider: AgentProvider;
  /** Field names tried in order to populate `display`. */
  displayFields: readonly string[];
  /** Field names tried in order to populate `project`. */
  projectFields: readonly string[];
  /**
   * If true, entries with no resolvable `project` are dropped. Claude Code
   * always writes `project`; Codex CLI sometimes only writes `cwd` and
   * occasionally neither, in which case we still want the display string.
   */
  requireProject: boolean;
}

/**
 * Read a provider's history.jsonl into normalized HistoryEntry rows. Shared
 * between Claude Code and Codex CLI — they differ only in which fields hold
 * the user input and the project path, plus whether `project` is required.
 */
export async function readJsonlHistory(opts: JsonlHistoryReaderOptions): Promise<HistoryEntry[]> {
  return parseJsonlFiltered(opts.historyPath, (parsed: unknown) => {
    if (!parsed || typeof parsed !== 'object') return null;
    const entry = parsed as Record<string, unknown>;

    const display = pickField(entry, opts.displayFields);
    if (!display) return null;

    const project = pickField(entry, opts.projectFields);
    if (opts.requireProject && !project) return null;

    return {
      display,
      timestamp: typeof entry.timestamp === 'number' ? entry.timestamp : 0,
      project: project.replace(/\\/g, '/'),
      sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : '',
      provider: opts.provider,
    };
  });
}

/**
 * Read Claude Code history.jsonl — filter to command entries only.
 */
async function readClaudeHistory(): Promise<HistoryEntry[]> {
  return readJsonlHistory({
    historyPath: join(home, '.claude', 'history.jsonl'),
    provider: 'claude-code',
    displayFields: ['display'],
    projectFields: ['project'],
    requireProject: true,
  });
}

/**
 * Read Codex CLI history.jsonl.
 */
async function readCodexHistory(): Promise<HistoryEntry[]> {
  return readJsonlHistory({
    historyPath: join(home, '.codex', 'history.jsonl'),
    provider: 'codex-cli',
    displayFields: ['display', 'command'],
    projectFields: ['project', 'cwd'],
    requireProject: false,
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

  // If too many candidates, narrow by current-org. Resolving git for every
  // candidate is the slow path we're trying to avoid, but skipping non-git
  // candidates entirely silently drops valid project siblings (a Cargo
  // workspace next door, a Python-only repo without `.git/`) — the normal
  // <=50 branch keeps them, so this branch must too.
  //
  // Strategy: run the same parallel resolve over ALL candidates. For non-git
  // entries the `simpleGit` call short-circuits with no remotes and we
  // still emit a SiblingRepo with name+path (no `gitOrg`). Then if we have
  // a currentOrg we keep org-matched git repos AND every non-git sibling
  // (the org filter doesn't apply to repos that don't have an org). This
  // preserves parity with the <=50 branch, which never filters by org.
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

    const results = await Promise.all(candidates.map((c) => resolveSibling(c)));

    if (currentOrg) {
      return results.filter((s) => !s.gitOrg || s.gitOrg === currentOrg);
    }
    return results;
  }

  // Normal path: resolve git remotes in parallel
  return Promise.all(candidates.map((c) => resolveSibling(c)));
}

/**
 * Resolve a candidate directory into a SiblingRepo. Non-git candidates and
 * unreadable git metadata both fall through to the catch block — callers
 * still get a SiblingRepo with `name` and `path`, just no `gitOrg`/
 * `gitRemoteUrl`. Both branches of `detectSiblings` (small / large) use this
 * so the >50 fast-path doesn't silently drop non-git project siblings.
 */
async function resolveSibling(c: {
  fullPath: string;
  entryPath: string;
  name: string;
}): Promise<SiblingRepo> {
  const sibling: SiblingRepo = { path: c.entryPath.replace(/\\/g, '/'), name: c.name };
  if (!existsSync(join(c.fullPath, '.git'))) return sibling;
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
