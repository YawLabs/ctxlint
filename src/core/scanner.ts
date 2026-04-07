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

  for (const dir of dirsToScan) {
    for (const pattern of patterns) {
      const matches = await glob(pattern, {
        cwd: dir,
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
        });
      }
    }
  }

  return found.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}
