import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { promptYesNo } from '../cli.js';

const CLI = path.resolve(__dirname, '../../dist/index.js');
const FIXTURES = path.resolve(__dirname, '../../fixtures');

// spawnSync (not execFileSync) so stderr is captured on the success path
// too -- these tests assert progress text lands on stderr, not stdout.
function run(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync('node', [CLI, ...args], {
    encoding: 'utf-8',
    timeout: 15000,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status ?? 1,
  };
}

// A minimal project with exactly one broken, auto-fixable path reference:
// CLAUDE.md points at lib/helpers.ts while the file lives at src/helpers.ts.
// The paths check's basename fuzzy match produces the fix without needing
// git history, so the fixture works in a bare temp dir.
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-fix-cli-'));
  fs.mkdirSync(path.join(tmpDir, 'src'));
  fs.writeFileSync(path.join(tmpDir, 'src', 'helpers.ts'), 'export {};\n');
  fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# Project\n\n- Utils: `lib/helpers.ts`\n');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('--fix with machine-readable formats', () => {
  it('--fix --format json keeps stdout parseable and reports post-fix state', () => {
    const { stdout, stderr, exitCode } = run([
      tmpDir,
      '--fix',
      '--format',
      'json',
      '--checks',
      'paths',
    ]);
    expect(exitCode).toBe(0);

    // Stdout must be ONLY the JSON document -- the "Fixed N issue(s)..."
    // progress line goes to stderr, never interleaved with the payload.
    const parsed = JSON.parse(stdout);
    expect(stderr).toContain('Fixed 1 issue');

    // The report reflects the post-fix re-audit, not the pre-fix result
    // (which counted the just-repaired issue as still present).
    expect(parsed.summary.errors).toBe(0);
    expect(fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf-8')).toContain('src/helpers.ts');
  });

  it('--fix --strict exits 0 when every issue was repaired', () => {
    const { exitCode } = run([tmpDir, '--fix', '--strict', '--quiet', '--checks', 'paths']);
    expect(exitCode).toBe(0);
  });

  it('--fix-dry-run --format json keeps stdout parseable, reports pre-fix state, writes nothing', () => {
    const { stdout, exitCode } = run([
      tmpDir,
      '--fix-dry-run',
      '--format',
      'json',
      '--checks',
      'paths',
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    // Dry run leaves the disk untouched, so the pre-fix summary is correct.
    expect(parsed.summary.errors).toBe(1);
    expect(fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf-8')).toContain('lib/helpers.ts');
  });

  it('--fix-dry-run --format json stays parseable with zero fixable issues', () => {
    // "No auto-fixable issues." used to print to stdout ahead of the payload,
    // corrupting json output even when nothing was fixable.
    const { stdout, exitCode } = run([
      path.join(FIXTURES, 'healthy-project'),
      '--fix-dry-run',
      '--format',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.files.length).toBeGreaterThan(0);
  });

  it('--fix --format sarif keeps stdout parseable as SARIF', () => {
    const { stdout, exitCode } = run([tmpDir, '--fix', '--format', 'sarif', '--checks', 'paths']);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.$schema).toContain('sarif');
  });
});

describe('promptYesNo stream binding', () => {
  // The prompt only fires when process.stdout.isTTY is true, which the
  // spawned-with-pipes e2e runs above can never exercise -- so the
  // stdout-purity half of the prompt is pinned in-process instead. The
  // prompt (and the TTY echo readline manages) must land on stderr, or an
  // interactive `--fix --format json` run captured from a PTY emits prompt
  // text ahead of the JSON document.
  it('writes the prompt to stderr, never stdout', async () => {
    const fakeStdin = new PassThrough();
    const stdinDesc = Object.getOwnPropertyDescriptor(process, 'stdin')!;
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });

    const stderrWrites: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        stderrWrites.push(chunk.toString());
        return true;
      });

    try {
      const pending = promptYesNo('Apply these fixes? [y/N] ');
      fakeStdin.write('y\n');
      await expect(pending).resolves.toBe(true);
      expect(stderrWrites.join('')).toContain('Apply these fixes?');
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      Object.defineProperty(process, 'stdin', stdinDesc);
    }
  });

  it('answers other than y/yes resolve false', async () => {
    const fakeStdin = new PassThrough();
    const stdinDesc = Object.getOwnPropertyDescriptor(process, 'stdin')!;
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      const pending = promptYesNo('Apply these fixes? [y/N] ');
      fakeStdin.write('nope\n');
      await expect(pending).resolves.toBe(false);
    } finally {
      stderrSpy.mockRestore();
      Object.defineProperty(process, 'stdin', stdinDesc);
    }
  });
});
