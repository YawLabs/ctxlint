import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const CLI = path.resolve(__dirname, '../../../dist/index.js');

let tmpDir: string;

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
