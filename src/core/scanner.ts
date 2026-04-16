import * as fs from 'node:fs';
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

export interface ScanOptions {
  depth?: number;
  extraPatterns?: string[];
}

export interface DiscoveredFile {
  absolutePath: string;
  relativePath: string;
  isSymlink: boolean;
  symlinkTarget?: string;
  type: 'context' | 'mcp-config' | 'mcph-config';
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
        if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          const fullPath = path.join(dir, entry.name);
          dirsToScan.push(fullPath);
          collectDirs(fullPath, currentDepth + 1);
        }
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

// .mcph.json is the @yawlabs/mcph CLI's config file.
// Precedence (most-specific to least): <cwd>/.mcph.local.json > <cwd>/.mcph.json > ~/.mcph.json.
const MCPH_CONFIG_PATTERNS = ['.mcph.json', '.mcph.local.json'];

export async function scanForMcphConfigs(projectRoot: string): Promise<DiscoveredFile[]> {
  const found: DiscoveredFile[] = [];
  const seen = new Set<string>();

  for (const pattern of MCPH_CONFIG_PATTERNS) {
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
        type: 'mcph-config',
      });
    }
  }

  return found.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export async function scanGlobalMcphConfigs(): Promise<DiscoveredFile[]> {
  const found: DiscoveredFile[] = [];
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const filePath = path.normalize(path.join(home, '.mcph.json'));

  try {
    fs.accessSync(filePath);
  } catch {
    return found;
  }

  const symlink = isSymlink(filePath);
  const target = symlink ? readSymlinkTarget(filePath) : undefined;

  found.push({
    absolutePath: filePath,
    relativePath: '~/.mcph.json',
    isSymlink: symlink,
    symlinkTarget: target,
    type: 'mcph-config',
  });

  return found;
}

export async function scanGlobalMcpConfigs(): Promise<DiscoveredFile[]> {
  const found: DiscoveredFile[] = [];
  const seen = new Set<string>();
  const home = process.env.HOME || process.env.USERPROFILE || '';

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
