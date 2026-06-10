import * as fs from 'node:fs';
import * as path from 'node:path';

export interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

// A leading U+FEFF in a UTF-8 file is a byte-order mark. Windows editors
// (Notepad, older VS Code defaults) emit it; JSON.parse rejects it, the
// markdown heading regex won't match through it, and tokenizers count it
// as content. Strip on every text read into the linter pipeline.
export function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

/**
 * Keyed LRU cache of parsed package.json per project root (mirrors the
 * diverged-file lineSet cache). The cache amortizes loads WITHIN a single
 * lint pass: several checks consult package.json for the same root, and a
 * pass that spans sibling roots (monorepo) would thrash a single-slot
 * {root,data} cache on every root switch. It deliberately does NOT persist
 * across MCP tool calls -- the server clears it via resetPackageJsonCache()
 * after every handler so a long-running server never serves a stale parse
 * (see src/mcp/server.ts). The 256-entry LRU cap bounds memory within a pass
 * (`Map` is insertion-ordered, so delete+set on hit promotes to
 * most-recently-used and the oldest key evicts when over the cap).
 *
 * `null` (missing / malformed package.json) is cached too, so repeated misses
 * for the same root don't re-stat the filesystem.
 */
const PKG_CACHE_MAX_ENTRIES = 256;
const pkgJsonCache = new Map<string, PackageJson | null>();

export function loadPackageJson(projectRoot: string): PackageJson | null {
  if (pkgJsonCache.has(projectRoot)) {
    const cached = pkgJsonCache.get(projectRoot) ?? null;
    // Promote to most-recently-used.
    pkgJsonCache.delete(projectRoot);
    pkgJsonCache.set(projectRoot, cached);
    return cached;
  }

  let data: PackageJson | null;
  try {
    const content = stripBom(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'));
    data = JSON.parse(content) as PackageJson;
  } catch {
    data = null;
  }

  pkgJsonCache.set(projectRoot, data);
  if (pkgJsonCache.size > PKG_CACHE_MAX_ENTRIES) {
    const oldest = pkgJsonCache.keys().next().value;
    if (oldest !== undefined) pkgJsonCache.delete(oldest);
  }
  return data;
}

export function resetPackageJsonCache(): void {
  pkgJsonCache.clear();
}

export function fileExists(filePath: string): boolean {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

export function isDirectory(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

export function isSymlink(filePath: string): boolean {
  try {
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

export function readSymlinkTarget(filePath: string): string | undefined {
  try {
    return fs.readlinkSync(filePath);
  } catch {
    return undefined;
  }
}

export function readFileContent(filePath: string): string {
  try {
    return stripBom(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(`File not found: ${filePath}`, { cause: err });
    }
    if (code === 'EACCES') {
      throw new Error(`Permission denied: ${filePath}`, { cause: err });
    }
    throw err;
  }
}

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'vendor',
  '.next',
  '.nuxt',
  'coverage',
  '__pycache__',
]);

export function getAllProjectFiles(projectRoot: string): string[] {
  const files: string[] = [];

  function walk(dir: string, depth: number) {
    if (depth > 10) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        // `.git` is skipped regardless of type: a directory in a normal
        // checkout, but a FILE (gitlink) at the root of git-worktree
        // checkouts and at `<submodule>/.git` in any repo with submodules.
        // Letting the file form through would make `.git` a fuzzy-match /
        // autofix candidate in paths.ts. Checked before the symlink and
        // directory branches so every shape is caught at every walk depth.
        if (entry.name === '.git') continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) {
          // Never walk through a directory link -- a symlink cycle would
          // otherwise burn the whole depth budget. A link to a regular file
          // is still a project file, so resolve and keep it.
          try {
            if (fs.statSync(fullPath).isFile()) {
              files.push(path.relative(projectRoot, fullPath));
            }
          } catch {
            // broken link -- skip
          }
          continue;
        }
        if (entry.isDirectory()) {
          // Ignore-by-name applies to directories only: a FILE named `build`
          // or `dist` (e.g. an extensionless build script) is a real project
          // file and must stay in the list.
          if (IGNORED_DIRS.has(entry.name)) continue;
          walk(fullPath, depth + 1);
        } else {
          files.push(path.relative(projectRoot, fullPath));
        }
      }
    } catch {
      // skip
    }
  }

  walk(projectRoot, 0);
  return files;
}
