import * as fs from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { glob } from 'glob';
import { isSymlink, readSymlinkTarget } from '../utils/fs.js';

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

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'vendor']);

// Dotted directory names we DO want to descend into for context-file
// discovery. Blanket-skipping `.*` dirs (the old behavior) meant that
// e.g. `packages/foo/.claude/AGENTS.md` was never found, because the walker
// stopped at `packages/foo/` and never registered the nested `.claude/` for
// the bare `AGENTS.md` pattern. Keep this list in sync with the dotted
// prefixes appearing in CONTEXT_FILE_PATTERNS and the CLI's --watch
// directory list (src/cli.ts). MCP discovery (scanForMcpConfigs) globs only
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
}

export interface DiscoveredFile {
  absolutePath: string;
  relativePath: string;
  isSymlink: boolean;
  symlinkTarget?: string;
  type: 'context' | 'mcp-config';
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

  for (const matches of perDirMatches) {
    for (const match of matches) {
      const normalized = path.normalize(match);
      if (seen.has(normalized)) continue;
      seen.add(normalized);

      const relativePath = path.relative(projectRoot, normalized);
      const symlink = isSymlink(normalized);
      const target = symlink ? readSymlinkTarget(normalized) : undefined;

      found.push({
        absolutePath: normalized,
        relativePath: relativePath.replace(/\\/g, '/'),
        isSymlink: symlink,
        symlinkTarget: target,
        type: 'context',
      });
    }
  }

  return found.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

const MCP_CONFIG_PATTERNS = [
  '.mcp.json',
  '.cursor/mcp.json',
  '.vscode/mcp.json',
  '.amazonq/mcp.json',
  '.continue/mcpServers/*.json',
];

export async function scanForMcpConfigs(projectRoot: string): Promise<DiscoveredFile[]> {
  const found: DiscoveredFile[] = [];
  const seen = new Set<string>();

  for (const pattern of MCP_CONFIG_PATTERNS) {
    const matches = await glob(pattern, {
      cwd: projectRoot,
      absolute: true,
      nodir: true,
      dot: true,
    });

    for (const match of matches) {
      const normalized = path.normalize(match);
      if (seen.has(normalized)) continue;
      seen.add(normalized);

      const relativePath = path.relative(projectRoot, normalized);
      const symlink = isSymlink(normalized);
      const target = symlink ? readSymlinkTarget(normalized) : undefined;

      found.push({
        absolutePath: normalized,
        relativePath: relativePath.replace(/\\/g, '/'),
        isSymlink: symlink,
        symlinkTarget: target,
        type: 'mcp-config',
      });
    }
  }

  return found.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export async function scanGlobalMcpConfigs(): Promise<DiscoveredFile[]> {
  const found: DiscoveredFile[] = [];
  const seen = new Set<string>();
  // Env-first so HOME/USERPROFILE overrides in tests/CI apply, with an
  // os.homedir() fallback so env-stripped contexts (systemd services, minimal
  // containers) still resolve the real home. session-scanner and skill-scanner
  // resolve identically -- the home-scoped pillars must agree on what "home"
  // means.
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  if (!home) {
    // Without a resolvable home dir every entry below would degrade to a
    // RELATIVE path (path.join('', '.claude.json') === '.claude.json') that
    // accessSync resolves against process.cwd() -- surfacing a project-local
    // file mislabeled as '~/...'. Nothing global is resolvable here.
    return [];
  }

  const globalPaths: string[] = [
    path.join(home, '.claude.json'),
    path.join(home, '.claude', 'settings.json'),
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
    // "missing root key" info findings on these two files.
    //
    // The other global paths are MCP-specific by filename
    // (.cursor/mcp.json, .codeium/windsurf/mcp_config.json,
    // .aws/amazonq/mcp.json, claude_desktop_config.json) so we don't gate
    // those -- a malformed MCP file there is a legitimate finding.
    const isGeneralClaudeFile =
      normalized.endsWith(`${path.sep}.claude.json`) ||
      normalized.endsWith(`${path.sep}.claude${path.sep}settings.json`);
    if (isGeneralClaudeFile && !(await mcpFileHasMcpKey(normalized))) continue;

    const symlink = isSymlink(normalized);
    const target = symlink ? readSymlinkTarget(normalized) : undefined;

    found.push({
      absolutePath: normalized,
      relativePath: '~/' + path.relative(home, normalized).replace(/\\/g, '/'),
      isSymlink: symlink,
      symlinkTarget: target,
      type: 'mcp-config',
    });
  }

  return found.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

const MCP_KEY_RE = /"(mcpServers|servers)"\s*:/;

/**
 * Cheap text-only peek: does the file have a top-level "mcpServers" or
 * "servers" key? Avoids a full JSON parse here -- the mcp-parser will do that
 * authoritatively later. We only need a reliable enough signal to skip
 * obviously-non-MCP general Claude config files.
 *
 * `~/.claude/settings.json` is always small, so an 8KB prefix peek is plenty
 * and avoids any streaming overhead. `~/.claude.json` is Claude Code's own
 * state file -- on a heavily-used workstation it holds projects/history/
 * tipsHistory ahead of `mcpServers`, so the key routinely sits PAST 8KB. A
 * prefix-only peek there returns false and silently drops a real global MCP
 * config from discovery, so `.claude.json` gets a chunked streaming scan
 * (mcpFileStreamHasMcpKey) that bails the moment the key matches -- it stays
 * cheap when the key is near the top and only reads further when it has to.
 */
const PREFIX_BYTES = 8192;
async function mcpFileHasMcpKey(filePath: string): Promise<boolean> {
  if (filePath.endsWith(`${path.sep}.claude.json`)) {
    return mcpFileStreamHasMcpKey(filePath);
  }
  let fd: fs.promises.FileHandle | undefined;
  try {
    fd = await fs.promises.open(filePath, 'r');
    const buf = Buffer.alloc(PREFIX_BYTES);
    const { bytesRead } = await fd.read(buf, 0, PREFIX_BYTES, 0);
    const prefix = buf.subarray(0, bytesRead).toString('utf8');
    return MCP_KEY_RE.test(prefix);
  } catch {
    return false;
  } finally {
    await fd?.close().catch(() => {});
  }
}

/**
 * Streaming scan that reads the file in 64KB chunks and returns true as soon
 * as the mcp-root-key regex matches -- so a key near the top still bails after
 * one chunk (no full read), but a key buried megabytes in is still found. A
 * small carry-over from the previous chunk's tail is prepended to each chunk
 * so a key straddling a chunk boundary isn't missed.
 */
const STREAM_CHUNK_BYTES = 64 * 1024;
// Longest token the regex can match (`"mcpServers"` + optional whitespace +
// `:`) is well under 64; carry over enough to never split a match.
const STREAM_OVERLAP_BYTES = 64;
async function mcpFileStreamHasMcpKey(filePath: string): Promise<boolean> {
  let fd: fs.promises.FileHandle | undefined;
  try {
    fd = await fs.promises.open(filePath, 'r');
    const buf = Buffer.alloc(STREAM_CHUNK_BYTES);
    let carry = '';
    let pos = 0;
    for (;;) {
      const { bytesRead } = await fd.read(buf, 0, STREAM_CHUNK_BYTES, pos);
      if (bytesRead === 0) break;
      pos += bytesRead;
      const text = carry + buf.subarray(0, bytesRead).toString('utf8');
      if (MCP_KEY_RE.test(text)) return true;
      carry = text.slice(-STREAM_OVERLAP_BYTES);
    }
    return false;
  } catch {
    return false;
  } finally {
    await fd?.close().catch(() => {});
  }
}
