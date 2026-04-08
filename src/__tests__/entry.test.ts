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
  it('version matches VERSION constant', () => {
    expect(PKG.version).toBe(VERSION);
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
