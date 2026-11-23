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
import { stripBom } from '../utils/fs.js';
import { claudeConfigDir, codexHomeDir, homeDir } from '../utils/claude-home.js';
import { currentGitOrg } from './sibling-org.js';

/** A known agent data directory and its provider. */
interface AgentDir {
  provider: AgentProvider;
  /** '' when the location cannot be resolved -- never matches. */
  dir: string;
  historyFile?: string;
}

/**
 * Known agent data directories, resolved per call rather than at module load
 * so a long-lived process (watch mode, the MCP server) and tests that redirect
 * HOME / USERPROFILE / CLAUDE_CONFIG_DIR see the current environment. Home
 * resolution lives in `utils/claude-home.ts` so every home-scoped pillar
 * (session, transcript, skills) agrees on what "home" means.
 */
function agentDirs(): AgentDir[] {
  const home = homeDir();
  // `join('', '.vibe')` is the cwd-relative `.vibe`; `existsSync` on that
  // resolves against cwd, so a project that happens to have its own dotdir
  // would be mistaken for the user's global agent data. Resolve to '' instead,
  // which `detectProviders` always rejects.
  const underHome = (...parts: string[]) => (home ? join(home, ...parts) : '');
  return [
    { provider: 'claude-code', dir: claudeConfigDir(), historyFile: 'history.jsonl' },
    { provider: 'codex-cli', dir: codexHomeDir(), historyFile: 'history.jsonl' },
    { provider: 'vibe-cli', dir: underHome('.vibe') },
    { provider: 'amazon-q', dir: underHome('.aws', 'amazonq') },
    {
      provider: 'goose',
      // On win32 the goose dir lives under %APPDATA%. If APPDATA is unset,
      // `join('', 'Block', 'goose')` yields the cwd-relative `Block/goose`,
      // so leave the dir empty and never match a cwd-relative `Block/goose`.
      dir:
        process.platform === 'win32'
          ? process.env.APPDATA
            ? join(process.env.APPDATA, 'Block', 'goose')
            : ''
          : underHome('.config', 'goose'),
    },
    { provider: 'continue', dir: underHome('.continue') },
    { provider: 'windsurf', dir: underHome('.windsurf') },
  ];
}

/**
 * Detect which agent providers are installed on this machine.
 */
export function detectProviders(): AgentProvider[] {
  // A dir that resolved to '' (no home, no override) is skipped explicitly:
  // all other readers (`readClaudeHistory`, `readClaudeMemories`, etc.) are
  // gated on this returning the matching provider, so short-circuiting here
  // is sufficient to prevent any cwd-relative lookups.
  return agentDirs()
    .filter((a) => a.dir !== '' && existsSync(a.dir))
    .map((a) => a.provider);
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
  try {
    for await (const rawLine of rl) {
      // A BOM-prefixed first line would fail JSON.parse and silently drop the
      // entry. stripBom is a single charCode check, so apply it per line
      // rather than tracking a first-line flag.
      const line = stripBom(rawLine);
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        const result = filter(parsed);
        if (result) results.push(result);
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // Stream-level errors — the file locked by a live agent appending to
    // history.jsonl (EBUSY/EPERM on Windows) or deleted between the
    // existsSync check and the open — degrade to the entries read so far.
    // Without this, the rejection propagates through scanSessionData's
    // Promise.all and discards the entire audit instead of just history.
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
   * always writes `project`; Codex CLI writes no project at all, in which case
   * we still want the display string.
   */
  requireProject: boolean;
  /** Field names tried in order for the session id. Default `['sessionId']`. */
  sessionFields?: readonly string[];
  /** Field names tried in order for a numeric timestamp. Default `['timestamp']`. */
  timestampFields?: readonly string[];
  /**
   * Unit of the timestamp field. Entries are normalized to epoch
   * milliseconds, which is what the session checks compare against.
   * Default `'ms'`.
   */
  timestampUnit?: 'ms' | 's';
}

/** First finite numeric value among the given field names, else 0. */
function pickNumber(entry: Record<string, unknown>, fields: readonly string[]): number {
  for (const f of fields) {
    const v = entry[f];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return 0;
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

    const rawTs = pickNumber(entry, opts.timestampFields ?? ['timestamp']);
    return {
      display,
      timestamp: opts.timestampUnit === 's' ? rawTs * 1000 : rawTs,
      project: project.replace(/\\/g, '/'),
      sessionId: pickField(entry, opts.sessionFields ?? ['sessionId']),
      provider: opts.provider,
    };
  });
}

/**
 * Resolve a provider's history.jsonl path from `agentDirs()` so the layout is
 * declared in one place. Providers without a `historyFile` resolve to `''`,
 * which `parseJsonlFiltered` treats as a missing file.
 */
function agentHistoryPath(provider: AgentProvider): string {
  const agent = agentDirs().find((a) => a.provider === provider);
  return agent?.historyFile ? join(agent.dir, agent.historyFile) : '';
}

/**
 * Read Claude Code history.jsonl — filter to command entries only.
 */
async function readClaudeHistory(): Promise<HistoryEntry[]> {
  return readJsonlHistory({
    historyPath: agentHistoryPath('claude-code'),
    provider: 'claude-code',
    displayFields: ['display'],
    projectFields: ['project'],
    requireProject: true,
  });
}

/**
 * Read Codex CLI history.jsonl (`$CODEX_HOME/history.jsonl`, default
 * `~/.codex`). Codex writes one `{"session_id":"<uuid>","ts":<unix seconds>,
 * "text":"<message>"}` object per line (codex-rs `message-history` crate,
 * `HistoryEntry`). It records no working directory, so every entry is
 * project-less: per-project checks drop it, and only checks that bind by an
 * explicit `--repo` spec can use it.
 */
async function readCodexHistory(): Promise<HistoryEntry[]> {
  return readJsonlHistory({
    historyPath: agentHistoryPath('codex-cli'),
    provider: 'codex-cli',
    displayFields: ['text'],
    projectFields: [],
    requireProject: false,
    sessionFields: ['session_id'],
    timestampFields: ['ts'],
    timestampUnit: 's',
  });
}

/**
 * Read all Claude Code memory files across all projects.
 */
async function readClaudeMemories(): Promise<MemoryEntry[]> {
  const configDir = claudeConfigDir();
  if (!configDir) return [];
  const projectsDir = join(configDir, 'projects');
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
 * Cap on simultaneous sibling resolutions. Each `resolveSibling` call creates
 * a FRESH simple-git instance, and simple-git's maxConcurrentProcesses
 * scheduler is per-instance — it never throttles across instances. Without
 * this cap, a parent dir with 200+ repos spawns 200+ simultaneous
 * `git remote` child processes (EMFILE/EAGAIN risk, worst on Windows).
 */
const SIBLING_RESOLVE_CONCURRENCY = 8;

/**
 * Map `items` through `fn` with at most `limit` calls in flight, preserving
 * input order in the results.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
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
  // Strategy: run the same bounded-parallel resolve over ALL candidates. For
  // non-git entries the `simpleGit` call short-circuits with no remotes and we
  // still emit a SiblingRepo with name+path (no `gitOrg`). Then if we have
  // a currentOrg we keep org-matched git repos AND every non-git sibling
  // (the org filter doesn't apply to repos that don't have an org). This
  // preserves parity with the <=50 branch, which never filters by org.
  if (candidates.length > 50) {
    const currentOrg = await currentGitOrg(projectRoot);

    const results = await mapWithConcurrency(
      candidates,
      SIBLING_RESOLVE_CONCURRENCY,
      resolveSibling,
    );

    if (currentOrg) {
      return results.filter((s) => !s.gitOrg || s.gitOrg === currentOrg);
    }
    return results;
  }

  // Normal path: resolve git remotes in parallel (bounded — see the
  // SIBLING_RESOLVE_CONCURRENCY note)
  return mapWithConcurrency(candidates, SIBLING_RESOLVE_CONCURRENCY, resolveSibling);
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
 * Which parts of the session context a caller needs. Each defaults to true.
 * Reading history streams every provider's whole history.jsonl, memories
 * parse every memory file of every project, and siblings spawn git per
 * candidate repo -- an audit running only transcript-backed checks needs
 * none of it, so the caller can skip what its selected checks never read.
 * A skipped part comes back empty.
 */
export interface SessionDataNeeds {
  history?: boolean;
  memories?: boolean;
  siblings?: boolean;
}

/**
 * Build the complete session context for a project.
 */
export async function scanSessionData(
  projectRoot: string,
  needs: SessionDataNeeds = {},
): Promise<SessionContext> {
  const providers = detectProviders();
  const { history = true, memories: wantMemories = true, siblings: wantSiblings = true } = needs;

  // Read history from all installed providers in parallel
  const historyPromises: Promise<HistoryEntry[]>[] = [];
  if (history && providers.includes('claude-code')) historyPromises.push(readClaudeHistory());
  if (history && providers.includes('codex-cli')) historyPromises.push(readCodexHistory());

  const [histories, memories, siblings] = await Promise.all([
    Promise.all(historyPromises).then((arrays) => arrays.flat()),
    wantMemories && providers.includes('claude-code') ? readClaudeMemories() : Promise.resolve([]),
    wantSiblings ? detectSiblings(projectRoot) : Promise.resolve([] as SiblingRepo[]),
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
