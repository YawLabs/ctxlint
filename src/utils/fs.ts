import * as fs from 'node:fs';
import * as path from 'node:path';

export interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

let pkgJsonCache: { root: string; data: PackageJson | null } | null = null;

export function loadPackageJson(projectRoot: string): PackageJson | null {
  if (pkgJsonCache?.root === projectRoot) return pkgJsonCache.data;
  try {
    const content = fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8');
    const data = JSON.parse(content) as PackageJson;
    pkgJsonCache = { root: projectRoot, data };
    return data;
  } catch {
    pkgJsonCache = { root: projectRoot, data: null };
    return null;
  }
}

export function resetPackageJsonCache(): void {
  pkgJsonCache = null;
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
    return fs.readFileSync(filePath, 'utf-8');
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
