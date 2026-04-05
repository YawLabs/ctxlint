import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

const CLI = path.resolve(__dirname, '../../../dist/index.js');
const FIXTURES = path.resolve(__dirname, '../../../fixtures');

function run(fixture: string, args: string[] = []): { stdout: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [CLI, path.join(FIXTURES, fixture), ...args], {
      encoding: 'utf-8',
      timeout: 15000,
    });
    return { stdout, exitCode: 0 };
  } catch (err: any) {
    return { stdout: err.stdout || '', exitCode: err.status ?? 1 };
  }
}

describe('CLI integration', () => {
  it('exits 0 for healthy project', () => {
    const { exitCode, stdout } = run('healthy-project');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('CLAUDE.md');
  });

  it('exits 0 for broken paths without --strict', () => {
    const { exitCode } = run('broken-paths');
    expect(exitCode).toBe(0);
  });

  it('exits 1 for broken paths with --strict', () => {
    const { exitCode } = run('broken-paths', ['--strict']);
    expect(exitCode).toBe(1);
  });

  it('outputs valid JSON with --format json', () => {
    const { stdout } = run('healthy-project', ['--format', 'json']);
    const parsed = JSON.parse(stdout);
    expect(parsed.version).toBe('0.1.0');
    expect(parsed.files).toBeInstanceOf(Array);
  });

  it('shows token report with --tokens', () => {
    const { stdout } = run('healthy-project', ['--tokens']);
    expect(stdout).toContain('Token Usage Report');
    expect(stdout).toContain('CLAUDE.md');
  });

  it('finds errors in broken-paths fixture', () => {
    const { stdout } = run('broken-paths', ['--format', 'json']);
    const parsed = JSON.parse(stdout);
    expect(parsed.summary.errors).toBeGreaterThan(0);
    const pathIssues = parsed.files[0].issues.filter((i: any) => i.check === 'paths');
    expect(pathIssues.length).toBeGreaterThan(0);
  });

  it('finds command errors in wrong-commands fixture', () => {
    const { stdout } = run('wrong-commands', ['--format', 'json']);
    const parsed = JSON.parse(stdout);
    const cmdIssues = parsed.files[0].issues.filter((i: any) => i.check === 'commands');
    expect(cmdIssues.length).toBeGreaterThan(0);
  });

  it('finds redundancy in redundant-content fixture', () => {
    const { stdout } = run('redundant-content', ['--format', 'json']);
    const parsed = JSON.parse(stdout);
    const redIssues = parsed.files[0].issues.filter((i: any) => i.check === 'redundancy');
    expect(redIssues.length).toBeGreaterThan(0);
  });

  it('respects --checks filter', () => {
    const { stdout } = run('broken-paths', ['--format', 'json', '--checks', 'tokens']);
    const parsed = JSON.parse(stdout);
    const allChecks = parsed.files.flatMap((f: any) => f.issues.map((i: any) => i.check));
    expect(allChecks.every((c: string) => c === 'tokens')).toBe(true);
  });

  it('respects --ignore filter', () => {
    const { stdout } = run('broken-paths', ['--format', 'json', '--ignore', 'paths']);
    const parsed = JSON.parse(stdout);
    const pathIssues = parsed.files.flatMap((f: any) =>
      f.issues.filter((i: any) => i.check === 'paths'),
    );
    expect(pathIssues.length).toBe(0);
  });

  it('handles directory with no context files', () => {
    const { stdout, exitCode } = run('healthy-project/src');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('No context files found');
  });

  it('finds multiple context files', () => {
    const { stdout } = run('multiple-files', ['--format', 'json']);
    const parsed = JSON.parse(stdout);
    expect(parsed.files.length).toBeGreaterThanOrEqual(3);
  });
});
