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
 * diverged-file lineSet cache). A single-slot {root,data} cache thrashes when a
 * long-running MCP server alternates between sibling roots -- each switch evicts
 * the other root's parse, so a back-and-forth scan re-reads + re-parses on every
 * call. The keyed Map keeps each root's data resident; the 256-entry LRU cap
 * bounds memory (`Map` is insertion-ordered, so delete+set on hit promotes to
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
        if (IGNORED_DIRS.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
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
