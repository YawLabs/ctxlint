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
      // totalFixes must NOT count the staged-but-skipped change. An earlier
      // version of the loop incremented `totalFixes` inside the inner per-fix
      // pass and only used the JSON-validation skip to bail out of the write,
      // so the summary over-reported what landed on disk.
      expect(summary.totalFixes).toBe(0);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe(original);
      const messages = logSpy.mock.calls.map((args) => args.join(' ')).join('\n');
      expect(messages).toContain('invalid JSON');
      // No "Fixed" / "Would fix" log line should land for a skipped file.
      expect(messages).not.toContain('Fixed');
      expect(messages).not.toContain('Would fix');
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

  // When two fixes target the same line and one's oldText is a substring of
  // the other (e.g. a dir rename `src/old` -> `src/new` plus a specific file
  // rename `src/old/util.ts` -> `src/new/util.ts`), applying the shorter one
  // first rewrites the prefix and leaves the longer fix's oldText no longer
  // present in the line -- silently dropping the more-specific fix. The
  // applier sorts longest-oldText-first to ensure the specific fix lands.
  it('applies overlapping same-line fixes when one oldText contains the other', () => {
    const filePath = writeFixture(
      'CLAUDE.md',
      'See `src/old/util.ts` plus other refs in `src/old/misc.ts`.\n',
    );
    const result = makeResult([
      {
        path: 'CLAUDE.md',
        isSymlink: false,
        tokens: 10,
        lines: 1,
        issues: [
          // Order matters: the general dir-rename fix is listed FIRST to
          // exercise the sort. Without the longest-first sort, this fix
          // would run before the specific one and rewrite `src/old/` to
          // `src/new/`, after which `src/old/util.ts` is no longer present.
          {
            severity: 'error',
            check: 'paths',
            line: 1,
            message: 'src/old/ renamed',
            fix: { file: filePath, line: 1, oldText: 'src/old/', newText: 'src/new/' },
          },
          {
            severity: 'error',
            check: 'paths',
            line: 1,
            message: 'src/old/util.ts moved',
            fix: {
              file: filePath,
              line: 1,
              oldText: 'src/old/util.ts',
              newText: 'src/renamed/util.ts',
            },
          },
        ],
      },
    ]);

    const summary = applyFixes(result);
    expect(summary.totalFixes).toBe(2);

    const updated = fs.readFileSync(filePath, 'utf-8');
    // The specific fix wins on its exact match.
    expect(updated).toContain('src/renamed/util.ts');
    // The general fix still rewrites the OTHER occurrence of src/old/.
    expect(updated).toContain('src/new/misc.ts');
    // Neither original path survives.
    expect(updated).not.toContain('src/old/');
  });

  // Two differently-stale refs on one line can resolve to the SAME target
  // (the basename-match pass in checks/paths.ts emits this shape). Chaining
  // replaceAll on the mutated line let fix B's oldText re-match inside fix
  // A's newText output, yielding nonexistent content like
  // `src/src/lib/util.ts`. Replacements must be computed against the
  // original line text and spliced once.
  it('does not cascade: a later fix cannot re-match an earlier fix output on the same line', () => {
    const filePath = writeFixture('CLAUDE.md', 'Edit old/util.ts and lib/util.ts\n');
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
            message: 'old/util.ts does not exist',
            fix: { file: filePath, line: 1, oldText: 'old/util.ts', newText: 'src/lib/util.ts' },
          },
          {
            severity: 'error',
            check: 'paths',
            line: 1,
            message: 'lib/util.ts does not exist',
            // Same newText as the fix above -- and its oldText is a substring
            // of that newText, the exact re-match shape.
            fix: { file: filePath, line: 1, oldText: 'lib/util.ts', newText: 'src/lib/util.ts' },
          },
        ],
      },
    ]);

    const summary = applyFixes(result);
    expect(summary.totalFixes).toBe(2);

    const updated = fs.readFileSync(filePath, 'utf-8');
    expect(updated).toBe('Edit src/lib/util.ts and src/lib/util.ts\n');
    expect(updated).not.toContain('src/src/');
  });

  // The interactive --fix flow has an unbounded confirmation window between
  // scan and apply, during which a fix-target file can be deleted or turn
  // read-only. A throw mid-loop would leave earlier writes applied with no
  // accurate summary; the fixer must skip the broken file and keep going.
  describe('unreadable / unwritable fix targets', () => {
    it('skips an unreadable file, continues to later files, keeps the summary accurate', () => {
      const missingPath = path.join(tmpDir, 'GONE.md'); // never created
      const goodPath = writeFixture('CLAUDE.md', 'See `src/old.ts`\n');
      const result = makeResult([
        {
          // Broken file FIRST so the loop must survive it to reach the good one.
          path: 'GONE.md',
          isSymlink: false,
          tokens: 10,
          lines: 1,
          issues: [
            {
              severity: 'error',
              check: 'paths',
              line: 1,
              message: '',
              fix: { file: missingPath, line: 1, oldText: 'a.ts', newText: 'b.ts' },
            },
          ],
        },
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
              fix: { file: goodPath, line: 1, oldText: 'src/old.ts', newText: 'src/new.ts' },
            },
          ],
        },
      ]);

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const summary = applyFixes(result);
        expect(summary.totalFixes).toBe(1);
        expect(summary.filesModified).toEqual([goodPath]);
        expect(fs.readFileSync(goodPath, 'utf-8')).toContain('src/new.ts');
        const messages = logSpy.mock.calls.map((args) => args.join(' ')).join('\n');
        expect(messages).toContain('Skipped');
        expect(messages).toContain('GONE.md');
      } finally {
        logSpy.mockRestore();
      }
    });

    it('skips a file whose write fails (read-only), continues, and does not count it', () => {
      const readonlyPath = writeFixture('LOCKED.md', 'See `src/old.ts`\n');
      const goodPath = writeFixture('CLAUDE.md', 'See `lib/old.ts`\n');
      fs.chmodSync(readonlyPath, 0o444);
      const result = makeResult([
        {
          path: 'LOCKED.md',
          isSymlink: false,
          tokens: 10,
          lines: 1,
          issues: [
            {
              severity: 'error',
              check: 'paths',
              line: 1,
              message: '',
              fix: { file: readonlyPath, line: 1, oldText: 'src/old.ts', newText: 'src/new.ts' },
            },
          ],
        },
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
              fix: { file: goodPath, line: 1, oldText: 'lib/old.ts', newText: 'lib/new.ts' },
            },
          ],
        },
      ]);

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const summary = applyFixes(result);
        expect(summary.totalFixes).toBe(1);
        expect(summary.filesModified).toEqual([goodPath]);
        expect(fs.readFileSync(goodPath, 'utf-8')).toContain('lib/new.ts');
        expect(fs.readFileSync(readonlyPath, 'utf-8')).toContain('src/old.ts');
        const messages = logSpy.mock.calls.map((args) => args.join(' ')).join('\n');
        expect(messages).toContain('Skipped');
        expect(messages).toContain('LOCKED.md');
      } finally {
        logSpy.mockRestore();
        // Restore write permission so afterEach rmSync can delete the tmp dir.
        fs.chmodSync(readonlyPath, 0o666);
      }
    });
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

  // -------------------------------------------------------------------------
  // Gap 3: dryRun.
  //
  // dryRun must leave every target file byte-for-byte unchanged while still
  // returning the same totalFixes / filesModified counts a real run would
  // (the "would-modify" contract documented on FixOptions.dryRun), and must
  // emit "Would fix" log lines instead of "Fixed".
  // -------------------------------------------------------------------------
  describe('dryRun', () => {
    it('writes nothing but returns the same counts as a real run', () => {
      const filePath = writeFixture('CLAUDE.md', 'Check `src/old/file.ts` for details.\n');
      const original = fs.readFileSync(filePath, 'utf-8');
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

      const summary = applyFixes(result, { dryRun: true });
      // Counts mirror a real run...
      expect(summary.totalFixes).toBe(1);
      expect(summary.filesModified).toEqual([filePath]);
      // ...but the file on disk is untouched.
      expect(fs.readFileSync(filePath, 'utf-8')).toBe(original);
    });

    it("logs 'Would fix' (not 'Fixed') under dryRun", () => {
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
        applyFixes(result, { dryRun: true });
        const messages = logSpy.mock.calls.map((args) => args.join(' ')).join('\n');
        expect(messages).toContain('Would fix');
        expect(messages).not.toContain('Fixed');
        // The change-detail still names old -> new so the preview is useful.
        expect(messages).toContain('src/old.ts');
        expect(messages).toContain('src/new.ts');
      } finally {
        logSpy.mockRestore();
      }
    });

    it('dryRun still respects quiet (no logs at all)', () => {
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
        const summary = applyFixes(result, { dryRun: true, quiet: true });
        expect(summary.totalFixes).toBe(1);
        expect(logSpy).not.toHaveBeenCalled();
      } finally {
        logSpy.mockRestore();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Gap 4: skipSymlinks default + --follow-symlinks override.
  //
  // The fixer keys symlink-skipping entirely off the scanner-supplied
  // `file.isSymlink` flag in the LintResult (fixer.ts:34-38, 51-54) -- it never
  // touches the filesystem to detect a symlink. So these tests set
  // isSymlink: true on a PLAIN on-disk file and assert the flag-driven branch,
  // which is faithful to the code path and does not require a real symlink
  // (symlink creation is EPERM on this Windows host without dev-mode anyway).
  // -------------------------------------------------------------------------
  describe('skipSymlinks', () => {
    it('skips a file flagged isSymlink by default, writes nothing, logs the skip', () => {
      const filePath = writeFixture('CLAUDE.md', 'See `src/old.ts` here.\n');
      const original = fs.readFileSync(filePath, 'utf-8');
      const result = makeResult([
        {
          path: filePath,
          isSymlink: true,
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
        const summary = applyFixes(result); // skipSymlinks defaults to true
        expect(summary.totalFixes).toBe(0);
        expect(summary.filesModified).toHaveLength(0);
        expect(fs.readFileSync(filePath, 'utf-8')).toBe(original);
        const messages = logSpy.mock.calls.map((args) => args.join(' ')).join('\n');
        expect(messages).toContain('Skipped');
        expect(messages).toContain('symlink');
        expect(messages).toContain('--follow-symlinks');
      } finally {
        logSpy.mockRestore();
      }
    });

    it('applies the fix to a symlink-flagged file when skipSymlinks: false (--follow-symlinks)', () => {
      const filePath = writeFixture('CLAUDE.md', 'See `src/old.ts` here.\n');
      const result = makeResult([
        {
          path: filePath,
          isSymlink: true,
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

      const summary = applyFixes(result, { skipSymlinks: false });
      expect(summary.totalFixes).toBe(1);
      expect(summary.filesModified).toEqual([filePath]);
      const updated = fs.readFileSync(filePath, 'utf-8');
      expect(updated).toContain('src/new.ts');
      expect(updated).not.toContain('src/old.ts');
    });

    it('does not skip a non-symlink file (isSymlink: false applies normally)', () => {
      const filePath = writeFixture('CLAUDE.md', 'See `src/old.ts` here.\n');
      const result = makeResult([
        {
          path: filePath,
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

      const summary = applyFixes(result); // default skipSymlinks: true, but file isn't a symlink
      expect(summary.totalFixes).toBe(1);
      expect(fs.readFileSync(filePath, 'utf-8')).toContain('src/new.ts');
    });
  });

  // -------------------------------------------------------------------------
  // Column-anchored fix (FixAction.column).
  //
  // When a stale path is a substring of a KEPT path on the same line
  // (e.g. `src/old.ts` inside `src/old.ts.bak`), a replaceAll rewrite would
  // corrupt the kept path. The column field lets the fixer claim only the
  // exact occurrence the scanner located.
  // -------------------------------------------------------------------------
  describe('column-anchored fixes', () => {
    it('rewrites only the column-pinned occurrence when stale text is a substring of a kept path', () => {
      // Line: "See src/old.ts and src/old.ts.bak"
      // src/old.ts starts at column 5 (1-indexed). src/old.ts.bak is the
      // kept path; its leading `src/old.ts` must NOT be rewritten.
      const line = 'See src/old.ts and src/old.ts.bak';
      const filePath = writeFixture('CLAUDE.md', `${line}\n`);
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
              message: 'src/old.ts does not exist',
              fix: {
                file: filePath,
                line: 1,
                oldText: 'src/old.ts',
                newText: 'src/new.ts',
                column: 5, // points at the standalone `src/old.ts`, not the one inside .bak
              },
            },
          ],
        },
      ]);

      const summary = applyFixes(result);
      expect(summary.totalFixes).toBe(1);

      const updated = fs.readFileSync(filePath, 'utf-8');
      // The standalone ref is rewritten.
      expect(updated).toContain('src/new.ts');
      // The .bak path keeps its original prefix -- not corrupted to src/new.ts.bak.
      expect(updated).toContain('src/old.ts.bak');
    });

    it('skips a column-anchored fix when the line has drifted since scan', () => {
      // Simulate: scanner saw `src/old.ts` at column 5, but the file was edited
      // before apply and that column now holds different text. The fixer must
      // skip rather than blind-replace.
      const filePath = writeFixture('CLAUDE.md', 'See src/other.ts instead\n');
      const original = fs.readFileSync(filePath, 'utf-8');
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
              message: 'src/old.ts does not exist',
              fix: {
                file: filePath,
                line: 1,
                oldText: 'src/old.ts',
                newText: 'src/new.ts',
                column: 5, // column 5 now reads 'src/other.ts', not 'src/old.ts'
              },
            },
          ],
        },
      ]);

      const summary = applyFixes(result);
      expect(summary.totalFixes).toBe(0);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe(original);
    });
  });
});
