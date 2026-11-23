import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { promptYesNo, needsFixConfirmation } from '../cli.js';

const CLI = path.resolve(__dirname, '../../dist/index.js');
const FIXTURES = path.resolve(__dirname, '../../fixtures');

// spawnSync (not execFileSync) so stderr is captured on the success path
// too -- these tests assert progress text lands on stderr, not stdout.
function run(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync('node', [CLI, ...args], {
    encoding: 'utf-8',
    // 60s to match vitest.config.ts's Windows testTimeout. This inner
    // ceiling was left at 15s when that was raised, so a real `node`
    // spawn on a contended Windows box was killed at 15s and surfaced
    // as ETIMEDOUT / exitCode 1 -- a load artifact indistinguishable
    // from a genuine failure. The outer testTimeout still catches a
    // true hang.
    timeout: 60000,
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

describe('--fix-dry-run text output', () => {
  it('names the file and never prints the secret it would replace', () => {
    const token = `ghp_${'A1b2C3d4E5'.repeat(3)}abcdef`;
    fs.writeFileSync(
      path.join(tmpDir, '.mcp.json'),
      `${JSON.stringify(
        { mcpServers: { gh: { command: 'npx', env: { GITHUB_TOKEN: token } } } },
        null,
        2,
      )}\n`,
    );
    // The secret rules only fire in git-tracked files.
    const git = (...args: string[]) =>
      spawnSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: tmpDir, encoding: 'utf-8' });
    if (git('init', '-q').status !== 0) return; // git unavailable
    git('add', '.mcp.json');

    const { stdout, exitCode } = run([tmpDir, '--mcp-only', '--fix-dry-run']);
    expect(exitCode).not.toBe(2);
    const preview = stdout.slice(stdout.indexOf('Would fix'));
    expect(preview).toContain('Would fix');
    expect(stdout).not.toContain(token);
    // The per-file header precedes the preview line.
    const lines = stdout.split('\n');
    const lineIdx = lines.findIndex((l) => l.includes('Would fix Line'));
    expect(lines[lineIdx - 1].trim()).toBe('.mcp.json');
    expect(fs.readFileSync(path.join(tmpDir, '.mcp.json'), 'utf-8')).toContain(token);
  });

  it('never prints a literal credential sitting beside an env ref in a syntax fix', () => {
    // An mcp-env/wrong-syntax fix touches a value that also holds literal
    // credentials (a secret-named query param, a key-shaped header run). Those
    // literals match no known-token pattern, so redactSecrets alone let them
    // through the preview.
    const queryKey = 'Qw9Er8Ty7Ui6Op5As4Df3Gh';
    const headerKey = 'Pq1Wo2Ei3Ru4Ty5Yu6Io7Pa8Sd9Fg0Hj';
    fs.mkdirSync(path.join(tmpDir, '.cursor'));
    fs.writeFileSync(
      path.join(tmpDir, '.cursor', 'mcp.json'),
      `${JSON.stringify(
        {
          mcpServers: {
            api: {
              url: `https://api.example.com/mcp?api_key=${queryKey}&ws=\${WORKSPACE}`,
              headers: { 'X-Api-Key': `${headerKey}\${SUFFIX}` },
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const { stdout, exitCode } = run([tmpDir, '--mcp-only', '--fix-dry-run']);
    expect(exitCode).not.toBe(2);
    expect(stdout).toContain('Would fix');
    expect(stdout).not.toContain(queryKey);
    expect(stdout).not.toContain(headerKey);
    // Dry run: the file is untouched.
    expect(fs.readFileSync(path.join(tmpDir, '.cursor', 'mcp.json'), 'utf-8')).toContain(
      '&ws=${WORKSPACE}',
    );
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

describe('--fix confirmation gate', () => {
  // A closed stdin (`ctxlint --fix < /dev/null` from a terminal, an editor
  // task) used to leave readline unsettled forever: the CLI then exited 0 with
  // no report. End-of-input is an answer, and the answer is no.
  it('promptYesNo resolves false when stdin closes without an answer', async () => {
    const fakeStdin = new PassThrough();
    const stdinDesc = Object.getOwnPropertyDescriptor(process, 'stdin')!;
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      const pending = promptYesNo('Apply these fixes? [y/N] ');
      fakeStdin.end();
      const outcome = await Promise.race([
        pending,
        new Promise((resolve) => setTimeout(() => resolve('unsettled'), 5000)),
      ]);
      expect(outcome).toBe(false);
    } finally {
      stderrSpy.mockRestore();
      Object.defineProperty(process, 'stdin', stdinDesc);
    }
  });

  // needsFixConfirmation takes the action's raw commander flags and is called
  // verbatim at the call site, so these pin the real gate, not a copy of it.
  const tty = (stdin: boolean, stdout: boolean) => ({
    stdin: { isTTY: stdin },
    stdout: { isTTY: stdout },
  });

  it('prompts only when both stdin and stdout are terminals and --yes is absent', () => {
    expect(needsFixConfirmation({ fix: true }, tty(true, true))).toBe(true);
    expect(needsFixConfirmation({ fix: true, yes: true }, tty(true, true))).toBe(false);
    // The prompt READS stdin: a terminal stdout over a piped/closed stdin has
    // no one to answer it.
    expect(needsFixConfirmation({ fix: true }, tty(false, true))).toBe(false);
    expect(needsFixConfirmation({ fix: true }, tty(true, false))).toBe(false);
  });

  // --quiet silences output; it is not consent. `--fix --quiet` in a terminal
  // used to write without the confirmation the --yes help says is required.
  it('--quiet does not waive the confirmation', () => {
    expect(needsFixConfirmation({ fix: true, quiet: true }, tty(true, true))).toBe(true);
  });

  it('reads the real process streams by default', () => {
    const inDesc = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const outDesc = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const set = (s: NodeJS.ReadStream | NodeJS.WriteStream, v: boolean) =>
      Object.defineProperty(s, 'isTTY', { value: v, configurable: true, writable: true });
    try {
      set(process.stdin, true);
      set(process.stdout, true);
      expect(needsFixConfirmation({ fix: true, quiet: true })).toBe(true);
      set(process.stdin, false);
      expect(needsFixConfirmation({ fix: true, quiet: true })).toBe(false);
    } finally {
      for (const [s, d] of [
        [process.stdin, inDesc],
        [process.stdout, outDesc],
      ] as const) {
        if (d) Object.defineProperty(s, 'isTTY', d);
        else delete (s as { isTTY?: boolean }).isTTY;
      }
    }
  });
});
