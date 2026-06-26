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
  stripBom,
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

  it('keeps both sibling roots cached when alternating between them (no single-slot thrash)', () => {
    // Within one lint pass spanning sibling roots (monorepo), a single-slot
    // {root,data} cache evicts the other root on every switch and re-reads +
    // re-parses on each call. The keyed LRU keeps both resident. (The MCP
    // server still clears the whole cache between tool calls -- this test
    // pins the within-pass behavior only.)
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-fs-a-'));
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-fs-b-'));
    try {
      fs.writeFileSync(path.join(rootA, 'package.json'), JSON.stringify({ scripts: { x: 'a' } }));
      fs.writeFileSync(path.join(rootB, 'package.json'), JSON.stringify({ scripts: { x: 'b' } }));

      const a1 = loadPackageJson(rootA);
      const b1 = loadPackageJson(rootB);

      // Overwrite both files on disk. If the cache thrashed (evicted on switch)
      // the next reads would re-parse and see the new content; the keyed cache
      // must still serve the originals for BOTH roots.
      fs.writeFileSync(
        path.join(rootA, 'package.json'),
        JSON.stringify({ scripts: { x: 'changed-a' } }),
      );
      fs.writeFileSync(
        path.join(rootB, 'package.json'),
        JSON.stringify({ scripts: { x: 'changed-b' } }),
      );

      // Alternate the access order to exercise LRU promotion on both.
      expect(loadPackageJson(rootA)?.scripts?.x).toBe('a');
      expect(loadPackageJson(rootB)?.scripts?.x).toBe('b');
      // Identity preserved per root (served from cache, not re-parsed).
      expect(loadPackageJson(rootA)).toBe(a1);
      expect(loadPackageJson(rootB)).toBe(b1);
    } finally {
      fs.rmSync(rootA, { recursive: true, force: true });
      fs.rmSync(rootB, { recursive: true, force: true });
    }
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

  // BOM fixtures spell the BOM as the visible \uFEFF escape, never a literal
  // U+FEFF: the literal is invisible in editors, so a retype or "fix
  // encoding" pass could delete it silently and flip these tests into
  // tautologies.
  it('strips a leading UTF-8 BOM', () => {
    const p = path.join(tmpDir, 'bom.txt');
    fs.writeFileSync(p, '\uFEFF# heading\n');
    expect(readFileContent(p)).toBe('# heading\n');
  });
});

describe('stripBom', () => {
  it('removes a leading U+FEFF', () => {
    expect(stripBom('\uFEFFhello')).toBe('hello');
  });

  it('leaves content without a BOM untouched', () => {
    expect(stripBom('hello')).toBe('hello');
  });

  it('only strips at the start, not mid-string', () => {
    expect(stripBom('hello\uFEFFworld')).toBe('hello\uFEFFworld');
  });

  it('handles empty input', () => {
    expect(stripBom('')).toBe('');
  });
});

describe('loadPackageJson with BOM', () => {
  it('parses a BOM-prefixed package.json', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      '\uFEFF' + JSON.stringify({ scripts: { test: 'vitest' } }),
    );
    const pkg = loadPackageJson(tmpDir);
    expect(pkg?.scripts?.test).toBe('vitest');
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

  it('keeps regular FILES named like ignored dirs (build, dist) in the list', () => {
    fs.writeFileSync(path.join(tmpDir, 'build'), '#!/bin/sh\necho build');
    fs.writeFileSync(path.join(tmpDir, 'dist'), 'x');
    fs.mkdirSync(path.join(tmpDir, 'vendor'));
    fs.writeFileSync(path.join(tmpDir, 'vendor', 'junk.txt'), 'x');

    const files = getAllProjectFiles(tmpDir).map((p) => p.replace(/\\/g, '/'));
    expect(files).toContain('build');
    expect(files).toContain('dist');
    // The DIRECTORY of the same ignored name is still skipped.
    expect(files.some((f) => f.startsWith('vendor/'))).toBe(false);
  });

  it('skips a .git FILE (worktree / submodule gitlink) at any walk depth', () => {
    // `.git` is a plain file -- not a directory -- at the root of git-worktree
    // checkouts and at `<submodule>/.git` inside any repo with submodules.
    fs.writeFileSync(path.join(tmpDir, '.git'), 'gitdir: ../repo/.git/worktrees/wt');
    fs.mkdirSync(path.join(tmpDir, 'sub'));
    fs.writeFileSync(path.join(tmpDir, 'sub', '.git'), 'gitdir: ../../.git/modules/sub');
    fs.writeFileSync(path.join(tmpDir, 'real.txt'), 'x');
    fs.writeFileSync(path.join(tmpDir, 'sub', 'inside.txt'), 'x');

    const files = getAllProjectFiles(tmpDir).map((p) => p.replace(/\\/g, '/'));
    expect(files).toContain('real.txt');
    expect(files).toContain('sub/inside.txt');
    expect(files).not.toContain('.git');
    expect(files).not.toContain('sub/.git');
  });

  it('includes a symlink-to-file as a project file (when OS permits creation)', () => {
    const target = path.join(tmpDir, 'target.txt');
    fs.writeFileSync(target, 'x');
    const link = path.join(tmpDir, 'alias.txt');
    try {
      fs.symlinkSync(target, link);
    } catch {
      return; // symlink not supported in this test environment
    }
    const files = getAllProjectFiles(tmpDir).map((p) => p.replace(/\\/g, '/'));
    expect(files).toContain('alias.txt');
    expect(files).toContain('target.txt');
  });

  it('neither lists nor walks through a symlink-to-directory (when OS permits creation)', () => {
    const realDir = path.join(tmpDir, 'real');
    fs.mkdirSync(realDir);
    fs.writeFileSync(path.join(realDir, 'inside.txt'), 'x');
    const link = path.join(tmpDir, 'linkdir');
    try {
      // 'junction' works without admin rights on Windows; the type argument
      // is ignored on POSIX.
      fs.symlinkSync(realDir, link, 'junction');
    } catch {
      return; // symlink not supported in this test environment
    }
    const files = getAllProjectFiles(tmpDir).map((p) => p.replace(/\\/g, '/'));
    expect(files).toContain('real/inside.txt');
    // Not listed as a bogus file entry, and not walked (no duplicate of
    // inside.txt under the link path -- symlink cycles must not recurse).
    expect(files).not.toContain('linkdir');
    expect(files.some((f) => f.startsWith('linkdir/'))).toBe(false);
  });

  it('skips a broken symlink without throwing (when OS permits creation)', () => {
    const link = path.join(tmpDir, 'dangling');
    try {
      fs.symlinkSync(path.join(tmpDir, 'missing-target'), link);
    } catch {
      return; // symlink not supported in this test environment
    }
    const files = getAllProjectFiles(tmpDir).map((p) => p.replace(/\\/g, '/'));
    expect(files).not.toContain('dangling');
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
