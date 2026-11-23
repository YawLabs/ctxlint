import * as fs from 'node:fs';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { glob } from 'glob/raw';
import { IGNORED_DIRS, isOutsideRelative, isSymlink, readSymlinkTarget } from '../utils/fs.js';
import { matchesGlob } from './ignore-file.js';
import { claudeConfigDir, homeDir } from '../utils/claude-home.js';

const CONTEXT_FILE_PATTERNS = [
  // Claude Code
  'CLAUDE.md',
  'CLAUDE.local.md',
  '.claude/rules/*.md',

  // AGENTS.md (AAIF / Linux Foundation standard)
  'AGENTS.md',
  'AGENT.md',
  'AGENTS.override.md',

  // Cursor
  '.cursorrules',
  '.cursor/rules/*.md',
  '.cursor/rules/*.mdc',
  '.cursor/rules/*/RULE.md',

  // GitHub Copilot
  '.github/copilot-instructions.md',
  '.github/instructions/*.md',
  '.github/git-commit-instructions.md',

  // Windsurf
  '.windsurfrules',
  '.windsurf/rules/*.md',

  // Gemini CLI
  'GEMINI.md',

  // Cline
  '.clinerules',
  '.clinerules/*.md',

  // Aider — note: .aiderules has no file extension; this is the intended format
  '.aiderules',

  // Aide / Codestory
  '.aide/rules/*.md',

  // Amazon Q Developer
  '.amazonq/rules/*.md',

  // Goose (Block)
  '.goose/instructions.md',
  '.goosehints',

  // JetBrains Junie
  '.junie/guidelines.md',
  '.junie/AGENTS.md',

  // JetBrains AI Assistant
  '.aiassistant/rules/*.md',

  // Continue
  '.continuerules',
  '.continue/rules/*.md',

  // Zed
  '.rules',

  // Replit
  'replit.md',
];

// Dotted directory names we DO want to descend into for context-file
// discovery. Blanket-skipping `.*` dirs (the old behavior) meant that
// e.g. `packages/foo/.claude/AGENTS.md` was never found, because the walker
// stopped at `packages/foo/` and never registered the nested `.claude/` for
// the bare `AGENTS.md` pattern. Keep this list in sync with the dotted
// prefixes appearing in CONTEXT_FILE_PATTERNS. The CLI's --watch mode has no
// separate list: it watches the whole tree and filters events through
// scanForContextFiles, so it follows this set. MCP discovery (scanForMcpConfigs) globs only
// at the project root by design and never uses this walk, so
// MCP_CONFIG_PATTERNS does not constrain the list. '.vscode' has no built-in
// context pattern but stays allowlisted so user-supplied extraPatterns can
// reach into nested .vscode/ dirs.
const ALLOWED_DOT_DIRS = new Set([
  '.claude',
  '.cursor',
  '.github',
  '.windsurf',
  '.clinerules',
  '.aide',
  '.amazonq',
  '.goose',
  '.junie',
  '.aiassistant',
  '.continue',
  '.vscode',
]);

export interface ScanOptions {
  depth?: number;
  extraPatterns?: string[];
  /**
   * Globs matched against each discovered file's project-relative path. A match
   * drops the file from the corpus entirely, so it produces no findings AND is
   * invisible to the cross-file checks (contradictions, duplicate-content),
   * which compare only what discovery returned.
   *
   * That corpus-level drop is the point, and it is why exclusion lives here
   * rather than in `.ctxlintignore`: an ignore-file rule is `checkName
   * [fileGlob]`, so it can suppress per-file findings but cannot reach a
   * project-level finding, whose FileResult path is the literal `(project)`
   * and matches no path glob.
   */
  exclude?: string[];
}

export interface DiscoveredFile {
  absolutePath: string;
  relativePath: string;
  isSymlink: boolean;
  symlinkTarget?: string;
  type: 'context' | 'mcp-config';
}

// Reading and tokenizing a multi-MB file stalls the single-threaded, long-
// running stdio MCP server; 5 MB (~1.25M tokens) is far past any real context
// file, so cap reads there. A capped file is dropped with a stderr warning
// (never stdout: that carries JSON / SARIF output and the stdio protocols).
// Applies to project scans only -- the global scan (scanGlobalMcpConfigs)
// deliberately keeps reading ~/.claude.json, Claude Code's own large state
// file, via its streaming key-peek.
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Code-unit order: deterministic across hosts, unlike locale-aware localeCompare. */
function byRelativePath(a: DiscoveredFile, b: DiscoveredFile): number {
  if (a.relativePath < b.relativePath) return -1;
  return a.relativePath > b.relativePath ? 1 : 0;
}

function resolveRealRoot(projectRoot: string): string {
  try {
    return fs.realpathSync(projectRoot);
  } catch {
    return path.resolve(projectRoot);
  }
}

/**
 * Decide whether a discovered project file must be EXCLUDED from linting:
 *   - its real path escapes the project root. EVERY match is realpath'd, not
 *     only a match that is itself a symlink: a symlinked or junctioned
 *     DIRECTORY on the way (`.claude` -> somewhere else) makes
 *     `.claude/rules/x.md` a plain file whose content still lives outside the
 *     tree. A CLAUDE.md symlinked to ~/.ssh/config or /etc/passwd would
 *     otherwise have its out-of-tree content read, tokenized, and echoed into
 *     findings. Reported on stderr so the drop is not silent; or
 *   - a file over MAX_FILE_BYTES (reading it would stall the stdio server),
 *     reported on stderr so the drop is not silent.
 * `realProjectRoot` must be realpath-resolved so an in-root target is not
 * misjudged as escaping when the root itself lives under a symlinked path
 * (e.g. macOS /tmp -> /private/tmp).
 */
function isExcludedScanTarget(
  normalized: string,
  realProjectRoot: string,
  relativePath: string,
): boolean {
  let real: string;
  try {
    real = fs.realpathSync(normalized);
  } catch {
    return true; // broken / unreadable link
  }
  if (isOutsideRelative(path.relative(realProjectRoot, real))) {
    // Same channel as the size-cap drop below: a file under a symlinked or
    // junctioned dir (.claude/rules -> a shared rules dir) otherwise vanishes
    // from the corpus and the run reports "No issues found".
    console.error(`Warning: skipping ${relativePath}: resolves outside the project root`);
    return true;
  }
  let size: number;
  try {
    size = fs.statSync(normalized).size;
  } catch {
    return true;
  }
  if (size > MAX_FILE_BYTES) {
    const mb = (size / (1024 * 1024)).toFixed(1);
    console.error(
      `Warning: skipping ${relativePath}: ${mb} MB exceeds the ${MAX_FILE_BYTES / (1024 * 1024)} MB limit for linted files`,
    );
    return true;
  }
  return false;
}

/**
 * True when `relativePath` (forward-slash form) matches any of the `exclude`
 * globs. Deliberately shares `matchesGlob` with the .ctxlintignore path so both
 * surfaces agree on glob semantics -- notably `{ dot: true }`, without which
 * `.claude/**` would silently match nothing.
 */
function isExcludedByGlob(relativePath: string, exclude: string[] | undefined): boolean {
  if (!exclude || exclude.length === 0) return false;
  return exclude.some((pattern) => matchesGlob(relativePath, pattern));
}

export async function scanForContextFiles(
  projectRoot: string,
  options: ScanOptions = {},
): Promise<DiscoveredFile[]> {
  const maxDepth = options.depth ?? 2;
  const patterns = [...CONTEXT_FILE_PATTERNS, ...(options.extraPatterns || [])];
  const found: DiscoveredFile[] = [];
  const seen = new Set<string>();

  // Collect directories to scan up to maxDepth
  const dirsToScan = [projectRoot];

  function collectDirs(dir: string, currentDepth: number) {
    if (currentDepth >= maxDepth) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name)) continue;
        // Allow non-dotted dirs, or dotted dirs on the allowlist (e.g.
        // nested .claude/, .cursor/, .github/ in monorepo subpackages).
        // Blanket-skipping all dotted dirs hid context files inside them.
        if (entry.name.startsWith('.') && !ALLOWED_DOT_DIRS.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        dirsToScan.push(fullPath);
        collectDirs(fullPath, currentDepth + 1);
      }
    } catch {
      // skip inaccessible directories
    }
  }

  collectDirs(projectRoot, 0);

  // One glob call per directory (passing all patterns as an array). Previously
  // this was a nested loop (32 patterns × N subdirs = 32N calls), each doing
  // its own readdirSync. Passing patterns as a single array lets glob share
  // the directory read across all patterns — ~32x fewer filesystem scans.
  const perDirMatches = await Promise.all(
    dirsToScan.map((dir) => glob(patterns, { cwd: dir, absolute: true, nodir: true, dot: true })),
  );

  const realRoot = resolveRealRoot(projectRoot);
  for (const matches of perDirMatches) {
    for (const match of matches) {
      const normalized = path.normalize(match);
      if (seen.has(normalized)) continue;
      seen.add(normalized);

      // Forward-slash form: the shape stored on DiscoveredFile.relativePath
      // and the one the exclude globs match -- `path.relative` yields
      // backslashes on Windows, and a `fixtures/**` glob would never match them.
      const relativePath = path.relative(projectRoot, normalized).replace(/\\/g, '/');
      // Exclude globs first: an excluded file is never stat'd, so it cannot
      // trip the size warning either.
      if (isExcludedByGlob(relativePath, options.exclude)) continue;
      if (isExcludedScanTarget(normalized, realRoot, relativePath)) continue;
      const symlink = isSymlink(normalized);
      const target = symlink ? readSymlinkTarget(normalized) : undefined;

      found.push({
        absolutePath: normalized,
        relativePath,
        isSymlink: symlink,
        symlinkTarget: target,
        type: 'context',
      });
    }
  }

  return found.sort(byRelativePath);
}

const MCP_CONFIG_PATTERNS = [
  '.mcp.json',
  '.cursor/mcp.json',
  '.vscode/mcp.json',
  '.amazonq/mcp.json',
  '.continue/mcpServers/*.json',
];

export async function scanForMcpConfigs(
  projectRoot: string,
  options: Pick<ScanOptions, 'exclude'> = {},
): Promise<DiscoveredFile[]> {
  const found: DiscoveredFile[] = [];
  const seen = new Set<string>();
  const realRoot = resolveRealRoot(projectRoot);

  // Single batched glob call across all patterns (mirrors scanForContextFiles):
  // glob shares the directory read across patterns instead of one readdir per
  // pattern. The exclude globs and the escaping-path / oversized-file
  // exclusion below apply exactly as they do to context files.
  const matches = await glob(MCP_CONFIG_PATTERNS, {
    cwd: projectRoot,
    absolute: true,
    nodir: true,
    dot: true,
  });

  for (const match of matches) {
    const normalized = path.normalize(match);
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    const relativePath = path.relative(projectRoot, normalized).replace(/\\/g, '/');
    if (isExcludedByGlob(relativePath, options.exclude)) continue;
    if (isExcludedScanTarget(normalized, realRoot, relativePath)) continue;
    const symlink = isSymlink(normalized);
    const target = symlink ? readSymlinkTarget(normalized) : undefined;

    found.push({
      absolutePath: normalized,
      relativePath,
      isSymlink: symlink,
      symlinkTarget: target,
      type: 'mcp-config',
    });
  }

  return found.sort(byRelativePath);
}

export async function scanGlobalMcpConfigs(): Promise<DiscoveredFile[]> {
  const found: DiscoveredFile[] = [];
  const seen = new Set<string>();
  // homeDir() / claudeConfigDir() are the shared resolution every
  // home-scoped pillar uses (env first so test/CI overrides apply, then
  // os.homedir() for env-stripped contexts), so they agree on what "home"
  // means. Claude Code's settings.json follows CLAUDE_CONFIG_DIR, and so does
  // its state file: with the override set, Claude Code keeps .claude.json
  // inside that dir, so it is preferred there and ~/.claude.json is the
  // fallback (an older install that predates the override).
  const home = homeDir();
  if (!home) {
    // Without a resolvable home dir every entry below would degrade to a
    // RELATIVE path (path.join('', '.claude.json') === '.claude.json') that
    // accessSync resolves against process.cwd() -- surfacing a project-local
    // file mislabeled as '~/...'. Nothing global is resolvable here.
    return [];
  }

  const homeStatePath = path.normalize(path.join(home, '.claude.json'));
  const configDirStatePath = process.env.CLAUDE_CONFIG_DIR
    ? path.normalize(path.join(claudeConfigDir(), '.claude.json'))
    : homeStatePath;
  const claudeStatePath = fs.existsSync(configDirStatePath) ? configDirStatePath : homeStatePath;
  const claudeSettingsPath = path.normalize(path.join(claudeConfigDir(), 'settings.json'));
  const globalPaths: string[] = [
    claudeStatePath,
    claudeSettingsPath,
    path.join(home, '.cursor', 'mcp.json'),
    path.join(home, '.codeium', 'windsurf', 'mcp_config.json'),
    path.join(home, '.aws', 'amazonq', 'mcp.json'),
  ];

  // Platform-specific Claude Desktop config
  if (process.platform === 'darwin') {
    globalPaths.push(
      path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    );
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    globalPaths.push(path.join(appData, 'Claude', 'claude_desktop_config.json'));
  }

  // Cline (VS Code extension saoudrizwan.claude-dev) keeps its MCP servers in
  // the extension's globalStorage under the platform's VS Code user dir; the
  // Cline CLI uses ~/.cline/data/settings/ (per docs.cline.bot, overridable
  // with CLINE_MCP_SETTINGS_PATH, which is honoured when set).
  globalPaths.push(
    process.env.CLINE_MCP_SETTINGS_PATH ||
      path.join(home, '.cline', 'data', 'settings', 'cline_mcp_settings.json'),
  );
  globalPaths.push(
    path.join(
      vscodeUserDir(home),
      'globalStorage',
      'saoudrizwan.claude-dev',
      'settings',
      'cline_mcp_settings.json',
    ),
  );

  for (const filePath of globalPaths) {
    const normalized = path.normalize(filePath);
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    try {
      fs.accessSync(normalized);
    } catch {
      continue;
    }

    // ~/.claude.json and ~/.claude/settings.json are general Claude Code
    // config files -- they MAY contain `mcpServers` but most workstations
    // never put one there. Skip when there's no recognizable MCP root key so
    // a clean workstation running `--mcp-global` doesn't get spurious
    // "missing root key" info findings on these two files. ~/.claude.json
    // also passes with a non-empty projects.*.mcpServers: that is where a
    // plain `claude mcp add` (local scope) writes, and mcp-parser lints it.
    //
    // The other global paths are MCP-specific by filename
    // (.cursor/mcp.json, .codeium/windsurf/mcp_config.json,
    // .aws/amazonq/mcp.json, claude_desktop_config.json,
    // cline_mcp_settings.json) so we don't gate
    // those -- a malformed MCP file there is a legitimate finding.
    if (normalized === claudeStatePath || normalized === claudeSettingsPath) {
      const projectServers = normalized === claudeStatePath;
      if (!(await mcpFileHasMcpKey(normalized, { projectServers }))) continue;
    }

    const symlink = isSymlink(normalized);
    const target = symlink ? readSymlinkTarget(normalized) : undefined;

    found.push({
      absolutePath: normalized,
      relativePath: displayGlobalPath(home, normalized),
      isSymlink: symlink,
      symlinkTarget: target,
      type: 'mcp-config',
    });
  }

  return found.sort(byRelativePath);
}

/**
 * `~/<rel>` for a global config under home; the absolute path (forward
 * slashes) for one outside it, e.g. a CLAUDE_CONFIG_DIR or
 * CLINE_MCP_SETTINGS_PATH elsewhere -- `~/../..` would misname it.
 */
function displayGlobalPath(home: string, filePath: string): string {
  const rel = path.relative(home, filePath);
  if (isOutsideRelative(rel)) return filePath.replace(/\\/g, '/');
  return '~/' + rel.replace(/\\/g, '/');
}

/**
 * VS Code's per-user data directory ("User"), where extensions keep their
 * globalStorage: %APPDATA%\Code\User on Windows,
 * ~/Library/Application Support/Code/User on macOS, and
 * $XDG_CONFIG_HOME/Code/User (default ~/.config/Code/User) elsewhere.
 */
function vscodeUserDir(home: string): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Code', 'User');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Code', 'User');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Code', 'User');
}

const MCP_ROOT_KEYS: ReadonlySet<string> = new Set(['mcpServers', 'servers']);
/** Longest key worth buffering: anything longer cannot be a key we look for. */
const MAX_KEY_CHARS = 32;
/** Stands in for a key too long to buffer: still a key, never a match. */
const OVERFLOW_KEY = '\u0000';

export interface RootKeyScannerOptions {
  /**
   * Also answer true for a NON-EMPTY `projects.<any>.mcpServers` object --
   * where Claude Code writes local-scope servers in ~/.claude.json (every
   * plain `claude mcp add`). Empty `"mcpServers": {}` blocks, which Claude
   * Code writes for every project it has opened, do not count.
   */
  projectServers?: boolean;
}

/**
 * Incremental, string-aware JSON scanner that answers one question: does the
 * ROOT object have one of `keys` as a direct member (or, with
 * `projectServers`, a non-empty `projects.*.mcpServers`)? Other nested
 * occurrences do not count -- a depth-blind regex let every ~/.claude.json
 * through the gate. Text inside string values (`"note": "\"mcpServers\": x"`)
 * does not count either.
 *
 * Fed in chunks so a key megabytes into the file is still found without
 * holding the whole file; state (container stack, in-string, escape, pending
 * key) carries across chunk boundaries, so a key straddling a boundary is
 * seen. Not a validator: malformed JSON just yields false (or a best-effort
 * true), and the mcp-parser reports it authoritatively later.
 */
export class RootKeyScanner {
  /** Open containers, outermost first, each with the key it was opened under. */
  private readonly stack: { isObject: boolean; key: string | null }[] = [];
  /** The key most recently seen (before its ':') at each depth. */
  private readonly keyAtDepth: (string | null)[] = [];
  private started = false;
  private inString = false;
  private escape = false;
  private collecting = false;
  private keyBuf = '';
  private keyOverflow = false;
  /** A just-closed key-position string, waiting to see whether a ':' makes it a key. */
  private pendingKey: string | null = null;
  /** 1: saw `projects.*."mcpServers":`, want '{'. 2: saw its '{', want a key. */
  private projectServersState: 0 | 1 | 2 = 0;
  private readonly maxKeyDepth: number;

  constructor(
    private readonly keys: ReadonlySet<string>,
    private readonly options: RootKeyScannerOptions = {},
  ) {
    this.maxKeyDepth = options.projectServers ? 3 : 1;
  }

  /** Feed the next chunk of text; true as soon as a match is seen. */
  feed(text: string): boolean {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (this.inString) {
        if (this.escape) {
          this.escape = false;
          this.appendKey(ch);
        } else if (ch === '\\') {
          this.escape = true;
          this.appendKey(ch);
        } else if (ch === '"') {
          this.inString = false;
          if (this.collecting) {
            this.pendingKey = this.keyOverflow ? OVERFLOW_KEY : this.keyBuf;
            this.collecting = false;
          }
        } else {
          this.appendKey(ch);
        }
        continue;
      }
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '﻿') continue;

      if (this.projectServersState === 2) {
        // The first member of a projects.*.mcpServers object: non-empty.
        if (ch === '"') return true;
        this.projectServersState = 0;
      } else if (this.projectServersState === 1 && ch !== '{') {
        this.projectServersState = 0;
      }

      const depth = this.stack.length;
      if (ch === '"') {
        this.inString = true;
        this.pendingKey = null;
        if (depth >= 1 && depth <= this.maxKeyDepth && this.stack[depth - 1].isObject) {
          this.collecting = true;
          this.keyBuf = '';
          this.keyOverflow = false;
        }
        continue;
      }
      if (ch === ':') {
        const key = this.pendingKey;
        this.pendingKey = null;
        if (key === null) continue;
        this.keyAtDepth[depth] = key;
        if (depth === 1 && this.stack[0].isObject && this.keys.has(key)) return true;
        if (this.options.projectServers && depth === 3 && key === 'mcpServers') {
          const [root, projects, project] = this.stack;
          if (
            root.isObject &&
            projects.isObject &&
            projects.key === 'projects' &&
            project.isObject
          ) {
            this.projectServersState = 1;
          }
        }
        continue;
      }
      this.pendingKey = null;
      if (ch === '{' || ch === '[') {
        if (!this.started) this.started = true;
        else if (depth === 0) continue; // trailing garbage after the root
        const parent = this.stack[depth - 1];
        this.stack.push({
          isObject: ch === '{',
          key: parent?.isObject ? (this.keyAtDepth[depth] ?? null) : null,
        });
        this.keyAtDepth[depth + 1] = null;
        if (this.projectServersState === 1) this.projectServersState = 2;
      } else if (ch === '}' || ch === ']') {
        this.stack.pop();
      }
    }
    return false;
  }

  private appendKey(ch: string): void {
    if (!this.collecting || this.keyOverflow) return;
    if (this.keyBuf.length >= MAX_KEY_CHARS) this.keyOverflow = true;
    else this.keyBuf += ch;
  }
}

/**
 * Does the file have a TOP-LEVEL "mcpServers" or "servers" key (or, with
 * `projectServers`, a non-empty projects.*.mcpServers)? A cheap,
 * streaming text scan (RootKeyScanner) rather than a full JSON parse -- the
 * mcp-parser does that authoritatively later; we only need a reliable signal
 * to skip general Claude config files that carry no MCP servers.
 *
 * Streams in 64KB chunks and bails the moment the key is seen, so a key near
 * the top costs one chunk. `~/.claude.json` is Claude Code's own state file:
 * on a heavily-used workstation projects/history/tipsHistory precede
 * `mcpServers`, so the key routinely sits far past any fixed prefix, and a
 * prefix-only peek silently dropped a real global MCP config. A StringDecoder
 * keeps a multi-byte UTF-8 character split across chunks intact.
 */
const STREAM_CHUNK_BYTES = 64 * 1024;
async function mcpFileHasMcpKey(
  filePath: string,
  options: RootKeyScannerOptions = {},
): Promise<boolean> {
  let fd: fs.promises.FileHandle | undefined;
  try {
    fd = await fs.promises.open(filePath, 'r');
    const buf = Buffer.alloc(STREAM_CHUNK_BYTES);
    const decoder = new StringDecoder('utf8');
    const scanner = new RootKeyScanner(MCP_ROOT_KEYS, options);
    let pos = 0;
    for (;;) {
      const { bytesRead } = await fd.read(buf, 0, STREAM_CHUNK_BYTES, pos);
      if (bytesRead === 0) break;
      pos += bytesRead;
      if (scanner.feed(decoder.write(buf.subarray(0, bytesRead)))) return true;
    }
    return scanner.feed(decoder.end());
  } catch {
    return false;
  } finally {
    await fd?.close().catch(() => {});
  }
}
