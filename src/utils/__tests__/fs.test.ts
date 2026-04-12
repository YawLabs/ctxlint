import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadPackageJson,
  resetPackageJsonCache,
  fileExists,
  isDirectory,
  isSymlink,
  readSymlinkTarget,
  readFileContent,
  getAllProjectFiles,
} from '../fs.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-fs-'));
  resetPackageJsonCache();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  resetPackageJsonCache();
});

describe('loadPackageJson', () => {
  it('returns null when no package.json exists', () => {
    expect(loadPackageJson(tmpDir)).toBeNull();
  });

  it('loads and parses package.json', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest' }, dependencies: { react: '^18' } }),
    );
    const pkg = loadPackageJson(tmpDir);
    expect(pkg?.scripts?.test).toBe('vitest');
    expect(pkg?.dependencies?.react).toBe('^18');
  });

  it('returns null and caches null for malformed JSON', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), 'not valid json{');
    expect(loadPackageJson(tmpDir)).toBeNull();
    // Second call hits cache (still null) without reparsing
    expect(loadPackageJson(tmpDir)).toBeNull();
  });

  it('caches parsed result per projectRoot', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ scripts: { build: 'tsc' } }),
    );
    const first = loadPackageJson(tmpDir);
    // Overwrite the file; cache should serve the original
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ scripts: { build: 'changed' } }),
    );
    const second = loadPackageJson(tmpDir);
    expect(second?.scripts?.build).toBe('tsc');
    expect(second).toBe(first);
  });

  it('resetPackageJsonCache forces a reload', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ scripts: { a: '1' } }));
    loadPackageJson(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ scripts: { a: '2' } }));
    resetPackageJsonCache();
    expect(loadPackageJson(tmpDir)?.scripts?.a).toBe('2');
  });
});

describe('fileExists', () => {
  it('returns true for an existing file', () => {
    const p = path.join(tmpDir, 'f.txt');
    fs.writeFileSync(p, 'x');
    expect(fileExists(p)).toBe(true);
  });

  it('returns false for a missing file', () => {
    expect(fileExists(path.join(tmpDir, 'missing.txt'))).toBe(false);
  });

  it('returns true for an existing directory', () => {
    expect(fileExists(tmpDir)).toBe(true);
  });
});

describe('isDirectory', () => {
  it('returns true for a directory', () => {
    expect(isDirectory(tmpDir)).toBe(true);
  });

  it('returns false for a regular file', () => {
    const p = path.join(tmpDir, 'f.txt');
    fs.writeFileSync(p, 'x');
    expect(isDirectory(p)).toBe(false);
  });

  it('returns false for a missing path', () => {
    expect(isDirectory(path.join(tmpDir, 'nope'))).toBe(false);
  });
});

describe('isSymlink / readSymlinkTarget', () => {
  it('returns false for a regular file', () => {
    const p = path.join(tmpDir, 'f.txt');
    fs.writeFileSync(p, 'x');
    expect(isSymlink(p)).toBe(false);
    expect(readSymlinkTarget(p)).toBeUndefined();
  });

  it('returns false for a missing path', () => {
    expect(isSymlink(path.join(tmpDir, 'nope'))).toBe(false);
    expect(readSymlinkTarget(path.join(tmpDir, 'nope'))).toBeUndefined();
  });

  // Symlink creation on Windows requires admin privileges; skip if it fails.
  it('detects a symlink when OS permits creation', () => {
    const target = path.join(tmpDir, 'target.txt');
    const link = path.join(tmpDir, 'link.txt');
    fs.writeFileSync(target, 'x');
    try {
      fs.symlinkSync(target, link);
    } catch {
      return; // symlink not supported in this test environment
    }
    expect(isSymlink(link)).toBe(true);
    expect(readSymlinkTarget(link)).toBe(target);
  });
});

describe('readFileContent', () => {
  it('reads file contents', () => {
    const p = path.join(tmpDir, 'f.txt');
    fs.writeFileSync(p, 'hello world');
    expect(readFileContent(p)).toBe('hello world');
  });

  it('throws "File not found" for missing paths', () => {
    expect(() => readFileContent(path.join(tmpDir, 'nope'))).toThrow('File not found');
  });
});

describe('getAllProjectFiles', () => {
  it('lists files recursively with project-root-relative paths', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'a');
    fs.mkdirSync(path.join(tmpDir, 'sub'));
    fs.writeFileSync(path.join(tmpDir, 'sub', 'b.txt'), 'b');

    const files = getAllProjectFiles(tmpDir).map((p) => p.replace(/\\/g, '/'));
    expect(files).toContain('a.txt');
    expect(files).toContain('sub/b.txt');
  });

  it('skips ignored directories (node_modules, .git, dist, etc.)', () => {
    for (const dir of ['node_modules', '.git', 'dist', 'build', 'coverage']) {
      fs.mkdirSync(path.join(tmpDir, dir));
      fs.writeFileSync(path.join(tmpDir, dir, 'junk.txt'), 'x');
    }
    fs.writeFileSync(path.join(tmpDir, 'real.txt'), 'x');

    const files = getAllProjectFiles(tmpDir).map((p) => p.replace(/\\/g, '/'));
    expect(files).toContain('real.txt');
    expect(files.some((f) => f.startsWith('node_modules/'))).toBe(false);
    expect(files.some((f) => f.startsWith('.git/'))).toBe(false);
    expect(files.some((f) => f.startsWith('dist/'))).toBe(false);
    expect(files.some((f) => f.startsWith('coverage/'))).toBe(false);
  });

  it('returns empty array for empty directory', () => {
    expect(getAllProjectFiles(tmpDir)).toEqual([]);
  });

  it('returns empty array for non-existent root', () => {
    expect(getAllProjectFiles(path.join(tmpDir, 'does-not-exist'))).toEqual([]);
  });

  it('honors the depth cap (>10 levels silently truncated)', () => {
    let current = tmpDir;
    for (let i = 0; i < 12; i++) {
      current = path.join(current, `d${i}`);
      fs.mkdirSync(current);
    }
    fs.writeFileSync(path.join(current, 'deep.txt'), 'x');
    const files = getAllProjectFiles(tmpDir).map((p) => p.replace(/\\/g, '/'));
    // File at depth >10 should NOT be found
    expect(files.some((f) => f.endsWith('/deep.txt'))).toBe(false);
  });
});
