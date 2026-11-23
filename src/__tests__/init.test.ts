import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { VERSION } from '../version.js';

// `init` lives inline in src/cli.ts and is driven end-to-end through the
// built bundle, so this is a CLI integration test (hence src/__tests__, next
// to entry.test.ts, not src/core/__tests__).
const CLI = path.resolve(__dirname, '../../dist/index.js');

let tmpDir: string;

function git(args: string[]): void {
  execFileSync('git', args, { cwd: tmpDir, stdio: 'ignore' });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-init-'));
  // Initialize a git repo in the temp dir
  execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'ignore' });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ctxlint init', () => {
  it('creates a pre-commit hook', () => {
    execFileSync('node', [CLI, 'init'], { cwd: tmpDir, encoding: 'utf-8' });
    const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit');
    expect(fs.existsSync(hookPath)).toBe(true);
    const content = fs.readFileSync(hookPath, 'utf-8');
    expect(content).toContain('ctxlint');
    expect(content).toContain('--strict');
  });

  // Pinning guards against silent rule-set drift when a repo is checked out
  // months after `ctxlint init` ran. A bare `npx @yawlabs/ctxlint` would
  // resolve `latest` at commit time; `@<version>` locks to the version that
  // wrote the hook.
  it('pins the hook to a specific ctxlint version', () => {
    execFileSync('node', [CLI, 'init'], { cwd: tmpDir, encoding: 'utf-8' });
    const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit');
    const content = fs.readFileSync(hookPath, 'utf-8');
    expect(content).toMatch(/@yawlabs\/ctxlint@\d+\.\d+\.\d+/);
  });

  // A hook has no terminal to answer npx's "Need to install ... Ok to
  // proceed?" prompt: without --yes the first commit on a machine without
  // the pinned version cached hangs or fails.
  it('runs npx with --yes so the hook never prompts to install', () => {
    execFileSync('node', [CLI, 'init'], { cwd: tmpDir, encoding: 'utf-8' });
    const content = fs.readFileSync(path.join(tmpDir, '.git', 'hooks', 'pre-commit'), 'utf-8');
    expect(content).toContain(`npx --yes @yawlabs/ctxlint@${VERSION} --strict`);
  });

  it('does not overwrite existing ctxlint hook', () => {
    // Run init twice
    execFileSync('node', [CLI, 'init'], { cwd: tmpDir, encoding: 'utf-8' });
    const output = execFileSync('node', [CLI, 'init'], { cwd: tmpDir, encoding: 'utf-8' });
    expect(output).toContain('already');

    // Should only have one ctxlint reference
    const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit');
    const content = fs.readFileSync(hookPath, 'utf-8');
    const matches = content.match(/ctxlint/g);
    expect(matches!.length).toBeLessThanOrEqual(2); // the npx command has it once, shebang comment once
  });

  it('appends to existing pre-commit hook', () => {
    const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, '#!/bin/sh\necho "existing hook"\n', { mode: 0o755 });

    execFileSync('node', [CLI, 'init'], { cwd: tmpDir, encoding: 'utf-8' });

    const content = fs.readFileSync(hookPath, 'utf-8');
    expect(content).toContain('existing hook');
    expect(content).toContain('ctxlint');
  });

  // Already-installed detection matches the actual `npx @yawlabs/ctxlint`
  // command shape, not any 'ctxlint' substring -- a hook that merely mentions
  // ctxlint in a comment (or in an unrelated tool name) still needs the real
  // command appended.
  it('appends the command when an existing hook only mentions ctxlint in a comment', () => {
    const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(
      hookPath,
      '#!/bin/sh\n# team conventions: see the ctxlint section of the handbook\necho ok\n',
      { mode: 0o755 },
    );

    const output = execFileSync('node', [CLI, 'init'], { cwd: tmpDir, encoding: 'utf-8' });
    expect(output).toContain('Added ctxlint to existing pre-commit hook.');
    const content = fs.readFileSync(hookPath, 'utf-8');
    expect(content).toMatch(/npx --yes @yawlabs\/ctxlint@\d+\.\d+\.\d+ --strict/);
  });

  it('re-running init bumps an older version pin in place', () => {
    execFileSync('node', [CLI, 'init'], { cwd: tmpDir, encoding: 'utf-8' });
    const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit');
    const downgraded = fs
      .readFileSync(hookPath, 'utf-8')
      .replace(/@yawlabs\/ctxlint@\d+\.\d+\.\d+/, '@yawlabs/ctxlint@0.0.1');
    fs.writeFileSync(hookPath, downgraded);

    const output = execFileSync('node', [CLI, 'init'], { cwd: tmpDir, encoding: 'utf-8' });
    expect(output).toContain(`Updated ctxlint pre-commit hook pin from 0.0.1 to ${VERSION}.`);

    const content = fs.readFileSync(hookPath, 'utf-8');
    expect(content).not.toContain('@yawlabs/ctxlint@0.0.1');
    expect(content).toContain(`@yawlabs/ctxlint@${VERSION}`);
    // The pin was rewritten in place, not re-appended.
    expect(content.match(/npx --yes @yawlabs\/ctxlint/g)!.length).toBe(1);
  });

  // `.git` is a FILE in a linked worktree (and in a submodule), pointing at
  // the real git dir. Joining `.git/hooks` onto it crashed with ENOTDIR. Hooks
  // live in the common git dir, which `git rev-parse --git-path hooks` names.
  it('installs into the shared hooks dir from a linked worktree', () => {
    git([
      '-c',
      'user.email=t@example.com',
      '-c',
      'user.name=t',
      'commit',
      '--allow-empty',
      '-m',
      'init',
    ]);
    const worktree = path.join(tmpDir, 'wt');
    git(['worktree', 'add', worktree]);
    expect(fs.statSync(path.join(worktree, '.git')).isFile()).toBe(true);

    const output = execFileSync('node', [CLI, 'init'], { cwd: worktree, encoding: 'utf-8' });
    const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit');
    expect(fs.readFileSync(hookPath, 'utf-8')).toContain(
      `npx --yes @yawlabs/ctxlint@${VERSION} --strict`,
    );
    expect(output).toContain(fs.realpathSync(hookPath));
  });

  // With core.hooksPath set git never runs .git/hooks/pre-commit, so writing
  // there and reporting success was a lie.
  it('honours core.hooksPath', () => {
    git(['config', 'core.hooksPath', '.githooks']);
    const output = execFileSync('node', [CLI, 'init'], { cwd: tmpDir, encoding: 'utf-8' });
    const hookPath = path.join(tmpDir, '.githooks', 'pre-commit');
    expect(fs.readFileSync(hookPath, 'utf-8')).toContain('@yawlabs/ctxlint@');
    expect(fs.existsSync(path.join(tmpDir, '.git', 'hooks', 'pre-commit'))).toBe(false);
    expect(output).toContain(fs.realpathSync(hookPath));
  });

  it('works from a subdirectory of the repo', () => {
    const sub = path.join(tmpDir, 'packages', 'app');
    fs.mkdirSync(sub, { recursive: true });
    execFileSync('node', [CLI, 'init'], { cwd: sub, encoding: 'utf-8' });
    expect(fs.existsSync(path.join(tmpDir, '.git', 'hooks', 'pre-commit'))).toBe(true);
    expect(fs.existsSync(path.join(sub, '.git'))).toBe(false);
  });

  // An unexpected failure inside an action (here EISDIR reading the hook)
  // must surface as a clean one-line error with exit 2, not an unhandled
  // rejection's stack trace.
  it('reports an unexpected failure without a stack trace and exits 2', () => {
    fs.mkdirSync(path.join(tmpDir, '.git', 'hooks', 'pre-commit'), { recursive: true });
    const result = spawnSync('node', [CLI, 'init'], { cwd: tmpDir, encoding: 'utf-8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/^Error: /m);
    expect(result.stderr).not.toMatch(/^\s+at /m);
  });

  // A repo git refuses to read (corrupt config, safe.directory "dubious
  // ownership") is still a repo: "Run git init first" would be wrong advice.
  // git's own message is surfaced instead.
  it("surfaces git's own error when git refuses an existing repo", () => {
    fs.writeFileSync(path.join(tmpDir, '.git', 'config'), '[core\n\tgarbage = = =\n');
    const result = spawnSync('node', [CLI, 'init'], { cwd: tmpDir, encoding: 'utf-8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/bad config/i);
    expect(result.stderr).not.toContain('not a git repository');
    expect(result.stderr).not.toContain('git init');
  });

  it('fails outside a git repo', () => {
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-nogit-'));
    try {
      execFileSync('node', [CLI, 'init'], { cwd: nonGitDir, encoding: 'utf-8' });
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.status).not.toBe(0);
      expect(err.stderr || err.stdout).toContain('not a git repository');
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true });
    }
  });
});
