import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { applyFixes } from '../fixer.js';
import type { LintResult } from '../types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-fixer-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFixture(name: string, content: string): string {
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function makeResult(files: LintResult['files']): LintResult {
  return {
    version: '0.2.0',
    scannedAt: new Date().toISOString(),
    projectRoot: tmpDir,
    files,
    summary: { errors: 0, warnings: 0, info: 0, totalTokens: 0, estimatedWaste: 0 },
  };
}

describe('applyFixes', () => {
  it('replaces a broken path with the fix', () => {
    const filePath = writeFixture('CLAUDE.md', 'Check `src/old/file.ts` for details.\n');
    const result = makeResult([
      {
        path: 'CLAUDE.md',
        isSymlink: false,
        tokens: 10,
        lines: 1,
        issues: [
          {
            severity: 'error',
            check: 'paths',
            line: 1,
            message: 'src/old/file.ts does not exist',
            fix: {
              file: filePath,
              line: 1,
              oldText: 'src/old/file.ts',
              newText: 'src/new/file.ts',
            },
          },
        ],
      },
    ]);

    const summary = applyFixes(result);
    expect(summary.totalFixes).toBe(1);
    expect(summary.filesModified).toHaveLength(1);

    const updated = fs.readFileSync(filePath, 'utf-8');
    expect(updated).toContain('src/new/file.ts');
    expect(updated).not.toContain('src/old/file.ts');
  });

  it('applies multiple fixes to the same file', () => {
    const filePath = writeFixture(
      'CLAUDE.md',
      'Line 1: `src/a.ts`\nLine 2: `src/b.ts`\nLine 3: ok\n',
    );
    const result = makeResult([
      {
        path: 'CLAUDE.md',
        isSymlink: false,
        tokens: 10,
        lines: 3,
        issues: [
          {
            severity: 'error',
            check: 'paths',
            line: 1,
            message: 'src/a.ts does not exist',
            fix: { file: filePath, line: 1, oldText: 'src/a.ts', newText: 'src/aa.ts' },
          },
          {
            severity: 'error',
            check: 'paths',
            line: 2,
            message: 'src/b.ts does not exist',
            fix: { file: filePath, line: 2, oldText: 'src/b.ts', newText: 'src/bb.ts' },
          },
        ],
      },
    ]);

    const summary = applyFixes(result);
    expect(summary.totalFixes).toBe(2);

    const updated = fs.readFileSync(filePath, 'utf-8');
    expect(updated).toContain('src/aa.ts');
    expect(updated).toContain('src/bb.ts');
  });

  it('returns zero fixes when no issues have fix actions', () => {
    const result = makeResult([
      {
        path: 'CLAUDE.md',
        isSymlink: false,
        tokens: 10,
        lines: 1,
        issues: [{ severity: 'error', check: 'paths', line: 1, message: 'something broken' }],
      },
    ]);

    const summary = applyFixes(result);
    expect(summary.totalFixes).toBe(0);
    expect(summary.filesModified).toHaveLength(0);
  });

  it('skips fix if oldText not found on the target line', () => {
    const filePath = writeFixture('CLAUDE.md', 'This line has no path\n');
    const result = makeResult([
      {
        path: 'CLAUDE.md',
        isSymlink: false,
        tokens: 10,
        lines: 1,
        issues: [
          {
            severity: 'error',
            check: 'paths',
            line: 1,
            message: 'ghost.ts does not exist',
            fix: { file: filePath, line: 1, oldText: 'ghost.ts', newText: 'real.ts' },
          },
        ],
      },
    ]);

    const summary = applyFixes(result);
    expect(summary.totalFixes).toBe(0);
  });

  it('skips fix if line number is out of bounds', () => {
    const filePath = writeFixture('CLAUDE.md', 'One line\n');
    const result = makeResult([
      {
        path: 'CLAUDE.md',
        isSymlink: false,
        tokens: 10,
        lines: 1,
        issues: [
          {
            severity: 'error',
            check: 'paths',
            line: 999,
            message: 'nope',
            fix: { file: filePath, line: 999, oldText: 'x', newText: 'y' },
          },
        ],
      },
    ]);

    const summary = applyFixes(result);
    expect(summary.totalFixes).toBe(0);
  });

  it('dedupes identical fix actions targeting the same (line, oldText, newText)', () => {
    const filePath = writeFixture('CLAUDE.md', 'See `src/old.ts` for logic.\n');
    // Two issues with the SAME fix (line, oldText, newText) — e.g. both the
    // git-rename detector and the fuzzy-match fallback proposed the same
    // target. Without dedupe, the second fix becomes a no-op and totalFixes
    // over-counts.
    const result = makeResult([
      {
        path: 'CLAUDE.md',
        isSymlink: false,
        tokens: 10,
        lines: 1,
        issues: [
          {
            severity: 'error',
            check: 'paths',
            line: 1,
            message: 'duplicate 1',
            fix: { file: filePath, line: 1, oldText: 'src/old.ts', newText: 'src/new.ts' },
          },
          {
            severity: 'error',
            check: 'paths',
            line: 1,
            message: 'duplicate 2',
            fix: { file: filePath, line: 1, oldText: 'src/old.ts', newText: 'src/new.ts' },
          },
        ],
      },
    ]);

    const summary = applyFixes(result);
    expect(summary.totalFixes).toBe(1);
    expect(summary.filesModified).toHaveLength(1);
  });

  it('does not log when quiet: true is passed', () => {
    const filePath = writeFixture('CLAUDE.md', 'See `src/old.ts` here.\n');
    const result = makeResult([
      {
        path: 'CLAUDE.md',
        isSymlink: false,
        tokens: 10,
        lines: 1,
        issues: [
          {
            severity: 'error',
            check: 'paths',
            line: 1,
            message: '',
            fix: { file: filePath, line: 1, oldText: 'src/old.ts', newText: 'src/new.ts' },
          },
        ],
      },
    ]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const summary = applyFixes(result, { quiet: true });
      expect(summary.totalFixes).toBe(1);
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });

  it('skips a JSON fix that would produce invalid JSON and leaves file unchanged', () => {
    const filePath = writeFixture('bad.json', '{"servers": {"foo": {"command": "old"}}}\n');
    const original = fs.readFileSync(filePath, 'utf-8');
    const result = makeResult([
      {
        path: 'bad.json',
        isSymlink: false,
        tokens: 10,
        lines: 1,
        issues: [
          {
            severity: 'error',
            check: 'paths',
            line: 1,
            message: '',
            fix: { file: filePath, line: 1, oldText: '"old"}}}', newText: '"new"}BREAK' },
          },
        ],
      },
    ]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const summary = applyFixes(result);
      expect(summary.filesModified).toHaveLength(0);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe(original);
      const messages = logSpy.mock.calls.map((args) => args.join(' ')).join('\n');
      expect(messages).toContain('invalid JSON');
    } finally {
      logSpy.mockRestore();
    }
  });

  // When a directory rename lands on a line that references the renamed
  // prefix twice (e.g. "see src/old/a.ts and src/old/b.ts"), a naive
  // String.prototype.replace would only rewrite the first occurrence and
  // leave the second dangling. We use replaceAll on literal strings so both
  // get fixed in a single pass.
  it('rewrites every occurrence when oldText appears twice on one line', () => {
    const filePath = writeFixture(
      'CLAUDE.md',
      'Tests live in `src/old/foo.ts` and `src/old/bar.ts`.\n',
    );
    const result = makeResult([
      {
        path: 'CLAUDE.md',
        isSymlink: false,
        tokens: 10,
        lines: 1,
        issues: [
          {
            severity: 'error',
            check: 'paths',
            line: 1,
            message: 'src/old/ renamed',
            fix: { file: filePath, line: 1, oldText: 'src/old/', newText: 'src/new/' },
          },
        ],
      },
    ]);

    applyFixes(result);
    const updated = fs.readFileSync(filePath, 'utf-8');
    expect(updated).toContain('src/new/foo.ts');
    expect(updated).toContain('src/new/bar.ts');
    expect(updated).not.toContain('src/old/');
  });

  it('fixes across multiple files', () => {
    const file1 = writeFixture('CLAUDE.md', 'See `src/old.ts`\n');
    const file2 = writeFixture('AGENTS.md', 'Check `lib/old.ts`\n');
    const result = makeResult([
      {
        path: 'CLAUDE.md',
        isSymlink: false,
        tokens: 10,
        lines: 1,
        issues: [
          {
            severity: 'error',
            check: 'paths',
            line: 1,
            message: '',
            fix: { file: file1, line: 1, oldText: 'src/old.ts', newText: 'src/new.ts' },
          },
        ],
      },
      {
        path: 'AGENTS.md',
        isSymlink: false,
        tokens: 10,
        lines: 1,
        issues: [
          {
            severity: 'error',
            check: 'paths',
            line: 1,
            message: '',
            fix: { file: file2, line: 1, oldText: 'lib/old.ts', newText: 'lib/new.ts' },
          },
        ],
      },
    ]);

    const summary = applyFixes(result);
    expect(summary.totalFixes).toBe(2);
    expect(summary.filesModified).toHaveLength(2);
  });
});
