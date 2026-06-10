import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { VERSION } from '../version.js';

const CLI = path.resolve(__dirname, '../../dist/index.js');
const FIXTURES = path.resolve(__dirname, '../../fixtures');
const PKG = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8'));

function run(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      encoding: 'utf-8',
      timeout: 15000,
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: any) {
    return { stdout: err.stdout || '', stderr: err.stderr || '', exitCode: err.status ?? 1 };
  }
}

describe('entry point routing (index.ts)', () => {
  it('--mcp-server flag launches MCP server (exits when stdin closes)', () => {
    // The MCP server reads from stdin; with no input it should start then exit
    try {
      execFileSync('node', [CLI, '--mcp-server'], {
        encoding: 'utf-8',
        input: '', // empty stdin causes immediate close
        timeout: 5000,
      });
    } catch (err: any) {
      // Server exits with error when stdin closes — that's expected behavior
      // The key assertion: it did NOT run the CLI linter (no "No context files" output)
      expect(err.stdout || '').not.toContain('No context files');
      expect(err.stdout || '').not.toContain('Scanning');
    }
  });

  it('`serve` subcommand launches MCP server (alias for --mcp-server)', () => {
    try {
      execFileSync('node', [CLI, 'serve'], {
        encoding: 'utf-8',
        input: '',
        timeout: 5000,
      });
    } catch (err: any) {
      expect(err.stdout || '').not.toContain('No context files');
      expect(err.stdout || '').not.toContain('Scanning');
    }
  });

  it('without --mcp-server runs the CLI linter', () => {
    const { stdout, exitCode } = run([path.join(FIXTURES, 'healthy-project')]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('CLAUDE.md');
  });
});

describe('CLI --mcp flag (config linting, not server)', () => {
  it('--mcp-only runs MCP config checks and finds issues', () => {
    const { stdout } = run([
      path.join(FIXTURES, 'mcp-configs', 'wrong-root-key'),
      '--format',
      'json',
      '--mcp-only',
    ]);
    const parsed = JSON.parse(stdout);
    expect(parsed.files.length).toBeGreaterThan(0);
    expect(parsed.summary.errors).toBeGreaterThan(0);
  });

  it('--mcp adds MCP checks alongside context file checks', () => {
    const { stdout } = run([
      path.join(FIXTURES, 'mcp-configs', 'hardcoded-secrets'),
      '--format',
      'json',
      '--mcp',
    ]);
    const parsed = JSON.parse(stdout);
    // Should have files (MCP configs found as .mcp.json)
    expect(parsed.files).toBeDefined();
  });
});

describe('CLI help and version', () => {
  it('--help shows all flags including --mcp-server', () => {
    const { stdout } = run(['--help']);
    expect(stdout).toContain('--mcp-server');
    expect(stdout).toContain('--mcp-only');
    expect(stdout).toContain('--mcp-global');
    expect(stdout).toContain('--mcp');
    expect(stdout).toContain('--strict');
    expect(stdout).toContain('--fix');
    expect(stdout).toContain('--format');
  });

  it('--help description mentions MCP', () => {
    const { stdout } = run(['--help']);
    expect(stdout).toContain('MCP server configs');
  });

  it('--version outputs the correct version', () => {
    const { stdout } = run(['--version']);
    expect(stdout.trim()).toBe(VERSION);
  });
});

describe('package.json consistency', () => {
  // NOT `PKG.version === VERSION`: under vitest (unbundled) VERSION is read
  // from the same package.json PKG was parsed from, so that comparison can
  // never fail. server.json's two version fields are independently written
  // (release.sh step 4 syncs them), so drift there is a real failure mode --
  // a mismatched manifest publishes an MCP Registry entry pointing at the
  // wrong npm version.
  it('server.json versions match package.json', () => {
    const serverJson = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../../server.json'), 'utf-8'),
    );
    expect(serverJson.version).toBe(PKG.version);
    expect(serverJson.packages[0].version).toBe(PKG.version);
  });

  it('main/exports point at the built bundle', () => {
    expect(PKG.main).toBe('dist/index.js');
    expect(PKG.exports['.']).toBe('./dist/index.js');
  });

  it('test scripts build first (CLI tests run against dist)', () => {
    expect(PKG.scripts.pretest).toBe('node build.mjs');
    expect(PKG.scripts['pretest:run']).toBe('node build.mjs');
  });

  it('engines requires Node >=20', () => {
    expect(PKG.engines.node).toBe('>=20');
  });

  it('repository URL uses correct case (YawLabs)', () => {
    expect(PKG.repository.url).toContain('YawLabs/ctxlint');
  });

  it('bugs URL uses correct case', () => {
    expect(PKG.bugs.url).toContain('YawLabs/ctxlint');
  });

  it('description mentions MCP', () => {
    expect(PKG.description).toContain('MCP');
  });

  it('files array includes specs and rule catalogs', () => {
    expect(PKG.files).toContain('CONTEXT_LINT_SPEC.md');
    expect(PKG.files).toContain('MCP_CONFIG_LINT_SPEC.md');
    expect(PKG.files).toContain('context-lint-rules.json');
    expect(PKG.files).toContain('mcp-config-lint-rules.json');
  });

  it('files array includes pre-commit hooks', () => {
    expect(PKG.files).toContain('.pre-commit-hooks.yaml');
  });

  it('tiktoken is a dev dependency (bundled at build time)', () => {
    expect(PKG.devDependencies?.tiktoken).toBeDefined();
    expect(PKG.dependencies?.tiktoken).toBeUndefined();
  });
});

describe('CLI --depth flag', () => {
  // nested-context's only context file sits at sub/CLAUDE.md (depth 1), so a
  // true root-only scan finds nothing while the default depth finds it. The
  // old `parseInt(...) || 2` coerced --depth 0 to 2, making both runs equal.
  it('--depth 0 scans only the project root (not coerced to the default)', () => {
    const rootOnly = run([
      path.join(FIXTURES, 'nested-context'),
      '--format',
      'json',
      '--depth',
      '0',
    ]);
    expect(rootOnly.exitCode).toBe(0);
    expect(JSON.parse(rootOnly.stdout).files).toEqual([]);

    const defaultDepth = run([path.join(FIXTURES, 'nested-context'), '--format', 'json']);
    expect(JSON.parse(defaultDepth.stdout).files.length).toBeGreaterThan(0);
  });

  it('non-numeric --depth falls back to the default instead of crashing', () => {
    const result = run([
      path.join(FIXTURES, 'nested-context'),
      '--format',
      'json',
      '--depth',
      'abc',
    ]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).files.length).toBeGreaterThan(0);
  });
});

describe('repo policy', () => {
  const ROOT = path.resolve(__dirname, '../..');

  // Org policy: never suggest the web login flow -- it overwrites the
  // automation token in ~/.npmrc with a 2FA-bound session and the next
  // publish EOTPs. The failure-path guidance must point at restoring the
  // automation token instead.
  it('release.sh never suggests npm login', () => {
    const releaseSh = fs.readFileSync(path.join(ROOT, 'release.sh'), 'utf-8');
    expect(releaseSh).not.toMatch(/npm login/);
  });

  // GH Actions script-injection guard: `${{ inputs.* }}` interpolated into a
  // `run:` body becomes part of the shell script verbatim. Inputs must flow
  // through env vars; the only lines allowed to interpolate are the
  // CTXLINT_* env assignments.
  it('action.yml does not interpolate expressions into run scripts', () => {
    const action = fs.readFileSync(path.join(ROOT, 'action.yml'), 'utf-8');
    const interpolatingLines = action.split('\n').filter((l) => l.includes('${{'));
    expect(interpolatingLines.length).toBeGreaterThan(0);
    for (const line of interpolatingLines) {
      expect(line).toMatch(/^\s+CTXLINT_[A-Z_]+: \$\{\{ inputs\./);
    }
  });

  // release.sh step 6 path 2 (workstation hands publish off to CI) activates
  // on this file existing + containing npm publish/NODE_AUTH_TOKEN, and looks
  // the run up via `gh run list --workflow=Release`.
  it('CI and Release workflows exist with the shape release.sh hands off to', () => {
    const release = fs.readFileSync(
      path.join(ROOT, '.github', 'workflows', 'release.yml'),
      'utf-8',
    );
    expect(release).toMatch(/^name: Release$/m);
    expect(release).toContain('NODE_AUTH_TOKEN');
    expect(release).toContain('npm publish');

    const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf-8');
    expect(ci).toContain('pull_request');
    expect(ci).toContain('tsc --noEmit');
  });
});
