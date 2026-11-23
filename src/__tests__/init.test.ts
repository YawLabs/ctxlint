import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { VERSION } from '../version.js';
import { fromMsysPath } from '../cli.js';

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

  // git runs hooks from the worktree root, so a hook for a subdirectory must
  // carry that subdirectory's path (relative to the root) or it lints the
  // wrong tree.
  it('works from a subdirectory of the repo and lints that subdirectory', () => {
    const sub = path.join(tmpDir, 'packages', 'app');
    fs.mkdirSync(sub, { recursive: true });
    const output = execFileSync('node', [CLI, 'init'], { cwd: sub, encoding: 'utf-8' });
    const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit');
    expect(fs.readFileSync(hookPath, 'utf-8')).toContain(
      `npx --yes @yawlabs/ctxlint@${VERSION} --strict packages/app\n`,
    );
    expect(fs.existsSync(path.join(sub, '.git'))).toBe(false);
    expect(output).toContain('packages/app');
    expect(output).toMatch(/repository root/);
  });

  it('init <subdir> writes the path relative to the repo root into the hook', () => {
    fs.mkdirSync(path.join(tmpDir, 'packages', 'foo'), { recursive: true });
    execFileSync('node', [CLI, 'init', 'packages/foo'], { cwd: tmpDir, encoding: 'utf-8' });
    const content = fs.readFileSync(path.join(tmpDir, '.git', 'hooks', 'pre-commit'), 'utf-8');
    expect(content).toContain(`npx --yes @yawlabs/ctxlint@${VERSION} --strict packages/foo\n`);
  });

  it('a second init for another package adds its own line; repeating one is a no-op', () => {
    fs.mkdirSync(path.join(tmpDir, 'packages', 'foo'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'packages', 'bar'), { recursive: true });
    execFileSync('node', [CLI, 'init', 'packages/foo'], { cwd: tmpDir, encoding: 'utf-8' });
    const second = execFileSync('node', [CLI, 'init', 'packages/bar'], {
      cwd: tmpDir,
      encoding: 'utf-8',
    });
    expect(second).toContain('Added ctxlint to existing pre-commit hook.');
    const again = execFileSync('node', [CLI, 'init', 'packages/foo'], {
      cwd: tmpDir,
      encoding: 'utf-8',
    });
    expect(again).toContain('already includes ctxlint');

    const content = fs.readFileSync(path.join(tmpDir, '.git', 'hooks', 'pre-commit'), 'utf-8');
    expect(content.match(/--strict packages\/foo$/gm)).toHaveLength(1);
    expect(content.match(/--strict packages\/bar$/gm)).toHaveLength(1);
    // The root (no path argument) is a different target from either package.
    const root = execFileSync('node', [CLI, 'init'], { cwd: tmpDir, encoding: 'utf-8' });
    expect(root).toContain('Added ctxlint to existing pre-commit hook.');
    expect(fs.readFileSync(path.join(tmpDir, '.git', 'hooks', 'pre-commit'), 'utf-8')).toMatch(
      new RegExp(`ctxlint@${VERSION.replace(/\./g, '\\.')} --strict$`, 'm'),
    );
  });

  // Hooks installed before --yes existed keep npx's install prompt until the
  // pin update also adds --yes.
  it('re-running init adds --yes to an older pinned hook', () => {
    const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, '#!/bin/sh\nnpx @yawlabs/ctxlint@0.27.0 --strict\n', {
      mode: 0o755,
    });
    const output = execFileSync('node', [CLI, 'init'], { cwd: tmpDir, encoding: 'utf-8' });
    expect(output).toContain(`Updated ctxlint pre-commit hook pin from 0.27.0 to ${VERSION}.`);
    expect(fs.readFileSync(hookPath, 'utf-8')).toBe(
      `#!/bin/sh\nnpx --yes @yawlabs/ctxlint@${VERSION} --strict\n`,
    );
  });

  it('re-running init adds --yes to a hook already at the current pin', () => {
    const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, `#!/bin/sh\nnpx @yawlabs/ctxlint@${VERSION} --strict\n`, {
      mode: 0o755,
    });
    const output = execFileSync('node', [CLI, 'init'], { cwd: tmpDir, encoding: 'utf-8' });
    expect(output).toContain('--yes');
    expect(output).not.toContain('already includes');
    expect(fs.readFileSync(hookPath, 'utf-8')).toBe(
      `#!/bin/sh\nnpx --yes @yawlabs/ctxlint@${VERSION} --strict\n`,
    );
  });

  // `-y` is npx's short form of --yes: a current hook using it needs no change,
  // so init must leave the file byte-for-byte alone (CRLF included).
  it('leaves a current hook that uses -y untouched', () => {
    const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    const original = `#!/bin/sh\r\nnpx -y @yawlabs/ctxlint@${VERSION} --strict\r\n`;
    fs.writeFileSync(hookPath, original, { mode: 0o755 });
    const output = execFileSync('node', [CLI, 'init'], { cwd: tmpDir, encoding: 'utf-8' });
    expect(output).toContain('already includes ctxlint');
    expect(fs.readFileSync(hookPath, 'utf-8')).toBe(original);
  });

  it('bumps an old pin on a -y hook without rewriting -y', () => {
    const hookPath = path.join(tmpDir, '.git', 'hooks', 'pre-commit');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, '#!/bin/sh\nnpx -y @yawlabs/ctxlint@0.27.0 --strict\n', {
      mode: 0o755,
    });
    const output = execFileSync('node', [CLI, 'init'], { cwd: tmpDir, encoding: 'utf-8' });
    expect(output).toContain(`Updated ctxlint pre-commit hook pin from 0.27.0 to ${VERSION}.`);
    expect(output).not.toContain('Added --yes');
    expect(fs.readFileSync(hookPath, 'utf-8')).toBe(
      `#!/bin/sh\nnpx -y @yawlabs/ctxlint@${VERSION} --strict\n`,
    );
  });

  // A user-level core.hooksPath is shared by every repo on the machine: a
  // hook pinned to this project must not land there silently.
  describe('a hooks directory outside the repository', () => {
    let shared: string;
    let globalConfig: string;
    let env: NodeJS.ProcessEnv;

    beforeEach(() => {
      shared = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-shared-hooks-'));
      globalConfig = path.join(shared, 'gitconfig');
      fs.writeFileSync(
        globalConfig,
        `[core]\n\thooksPath = ${path.join(shared, 'hooks').replace(/\\/g, '/')}\n`,
      );
      env = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig };
    });

    afterEach(() => {
      fs.rmSync(shared, { recursive: true, force: true });
    });

    it('is refused, naming the dir and where core.hooksPath is set', () => {
      const result = spawnSync('node', [CLI, 'init'], { cwd: tmpDir, encoding: 'utf-8', env });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(path.join(shared, 'hooks'));
      expect(result.stderr).toContain('core.hooksPath');
      expect(result.stderr).toContain('gitconfig');
      expect(result.stderr).toContain('--shared-hooks');
      expect(fs.existsSync(path.join(shared, 'hooks', 'pre-commit'))).toBe(false);
    });

    it('is allowed with --shared-hooks', () => {
      fs.mkdirSync(path.join(shared, 'hooks'));
      const result = spawnSync('node', [CLI, 'init', '--shared-hooks'], {
        cwd: tmpDir,
        encoding: 'utf-8',
        env,
      });
      expect(result.status).toBe(0);
      expect(fs.readFileSync(path.join(shared, 'hooks', 'pre-commit'), 'utf-8')).toContain(
        `@yawlabs/ctxlint@${VERSION}`,
      );
    });
  });

  it('documents --shared-hooks in init --help', () => {
    const output = execFileSync('node', [CLI, 'init', '--help'], { encoding: 'utf-8' });
    expect(output).toContain('--shared-hooks');
  });

  // A core.hooksPath whose parent does not exist is a misconfiguration (or a
  // misread path): fail instead of building a directory tree git never reads.
  it('fails rather than create a hooks dir whose parent does not exist', () => {
    git(['config', 'core.hooksPath', 'no/such/hooks']);
    const result = spawnSync('node', [CLI, 'init'], { cwd: tmpDir, encoding: 'utf-8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not exist');
    expect(fs.existsSync(path.join(tmpDir, 'no'))).toBe(false);
  });

  // Git for Windows hands back an MSYS-style core.hooksPath (/c/Users/...)
  // unchanged; path.resolve turned it into C:\c\Users\... and init wrote a
  // hook git never runs.
  it.runIf(process.platform === 'win32')('resolves an MSYS-style core.hooksPath', () => {
    const real = path.join(fs.realpathSync(tmpDir), '.githooks');
    fs.mkdirSync(real);
    const msys = real.replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`);
    fs.appendFileSync(
      path.join(tmpDir, '.git', 'config'),
      `[core]\n\thooksPath = ${msys.replace(/\\/g, '/')}\n`,
    );
    // Code without the MSYS conversion resolves /c/Users/... to C:\c\Users\...
    // and builds that tree outside tmpDir; remove it (only the dirs it made,
    // never a pre-existing non-empty ancestor) so a red run leaves no litter.
    const bogus = path.resolve(msys);
    try {
      const output = execFileSync('node', [CLI, 'init'], { cwd: tmpDir, encoding: 'utf-8' });
      expect(fs.existsSync(path.join(real, 'pre-commit'))).toBe(true);
      expect(output).toContain(path.join(real, 'pre-commit'));
    } finally {
      fs.rmSync(path.join(bogus, 'pre-commit'), { force: true });
      for (let dir = bogus; dir !== path.dirname(dir); dir = path.dirname(dir)) {
        try {
          fs.rmdirSync(dir); // fails (and stops) at the first non-empty dir
        } catch {
          break;
        }
      }
    }
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

  it('fromMsysPath converts /x/... to X:/... only on win32', () => {
    expect(fromMsysPath('/c/Users/me/hooks', 'win32')).toBe('C:/Users/me/hooks');
    expect(fromMsysPath('/d', 'win32')).toBe('D:/');
    expect(fromMsysPath('C:/Users/me', 'win32')).toBe('C:/Users/me');
    expect(fromMsysPath('/cd/hooks', 'win32')).toBe('/cd/hooks');
    expect(fromMsysPath('/c/Users/me', 'linux')).toBe('/c/Users/me');
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
