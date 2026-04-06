import * as fs from 'node:fs';
import * as path from 'node:path';
import { glob } from 'glob';
import { isSymlink, readSymlinkTarget } from '../utils/fs.js';

const CONTEXT_FILE_PATTERNS = [
  'CLAUDE.md',
  'CLAUDE.local.md',
  'AGENTS.md',
  '.cursorrules',
  '.cursor/rules/*.md',
  '.cursor/rules/*.mdc',
  'copilot-instructions.md',
  '.github/copilot-instructions.md',
  '.github/instructions/*.md',
  '.windsurfrules',
  '.windsurf/rules/*.md',
  'GEMINI.md',
  'JULES.md',
  '.clinerules',
  'CONVENTIONS.md',
  'CODEX.md',
  '.aiderules',
  '.aide/rules/*.md',
  '.amazonq/rules/*.md',
  '.goose/instructions.md',
];

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'vendor']);

export interface DiscoveredFile {
  absolutePath: string;
  relativePath: string;
  isSymlink: boolean;
  symlinkTarget?: string;
}

export async function scanForContextFiles(projectRoot: string): Promise<DiscoveredFile[]> {
  const found: DiscoveredFile[] = [];
  const seen = new Set<string>();

  // Scan root and first level of subdirectories
  const dirsToScan = [projectRoot];

  try {
    const entries = fs.readdirSync(projectRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        dirsToScan.push(path.join(projectRoot, entry.name));
      }
    }
  } catch {
    // just scan root
  }

  for (const dir of dirsToScan) {
    for (const pattern of CONTEXT_FILE_PATTERNS) {
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
