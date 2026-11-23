import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { VERSION } from '../../version.js';

const CLI = path.resolve(__dirname, '../../../dist/index.js');
const FIXTURES = path.resolve(__dirname, '../../../fixtures');

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function run(fixture: string, args: string[] = [], env?: NodeJS.ProcessEnv): RunResult {
  return runDir(path.join(FIXTURES, fixture), args, env);
}

function runDir(dir: string, args: string[] = [], env?: NodeJS.ProcessEnv): RunResult {
  const r = spawnSync('node', [CLI, dir, ...args], {
    encoding: 'utf-8',
    env: env ?? process.env,
    // 60s to match vitest.config.ts's Windows testTimeout. This inner
    // ceiling was left at 15s when that was raised, so a real `node`
    // spawn on a contended Windows box was killed at 15s and surfaced
    // as ETIMEDOUT / exitCode 1 -- a load artifact indistinguishable
    // from a genuine failure. The outer testTimeout still catches a
    // true hang.
    timeout: 60000,
  });
  // A spawn failure or a timeout is a test failure, not "exit code 1": the
  // exit-code assertions below would otherwise pass on a CLI that never ran.
  if (r.error) throw r.error;
  if (r.status === null) throw new Error(`CLI killed by ${r.signal}`);
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status };
}

/**
 * The CLI ran to completion: no uncaught exception's stack trace on stderr.
 * An uncaught throw also exits 1, the same code --strict uses for findings.
 */
function expectNoCrash(r: RunResult): void {
  expect(r.stderr).not.toMatch(/^\s+at .+[(:]\d+/m);
  expect(r.stderr).not.toMatch(/\b(Type|Reference|Syntax|Range)Error\b/);
}

const issuesOf = (parsed: any, file: string) => {
  const f = parsed.files.find((x: any) => x.path === file);
  expect(f, `${file} in result`).toBeDefined();
  return f.issues as any[];
};

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
    const r = run('broken-paths', ['--strict']);
    expect(r.exitCode).toBe(1);
    expectNoCrash(r);
    // Exit 1 because of findings: the report was printed.
    expect(r.stdout).toContain('CLAUDE.md');
    expect(r.stdout).toMatch(/\d+ errors?/);
  });

  it('outputs valid JSON with --format json', () => {
    const { stdout } = run('healthy-project', ['--format', 'json']);
    const parsed = JSON.parse(stdout);
    expect(parsed.version).toBe(VERSION);
    expect(parsed.files).toBeInstanceOf(Array);
  });

  it('shows token report with --tokens', () => {
    const { stdout } = run('healthy-project', ['--tokens']);
    expect(stdout).toContain('Token Usage Report');
    expect(stdout).toContain('CLAUDE.md');
    expect(stdout).toContain('cl100k_base');
  });

  it('finds errors in broken-paths fixture', () => {
    const { stdout } = run('broken-paths', ['--format', 'json']);
    const parsed = JSON.parse(stdout);
    expect(parsed.summary.errors).toBeGreaterThan(0);
    const pathIssues = issuesOf(parsed, 'CLAUDE.md').filter((i: any) => i.check === 'paths');
    expect(pathIssues.length).toBeGreaterThan(0);
  });

  it('finds command errors in wrong-commands fixture', () => {
    const { stdout } = run('wrong-commands', ['--format', 'json']);
    const parsed = JSON.parse(stdout);
    const cmdIssues = issuesOf(parsed, 'AGENTS.md').filter((i: any) => i.check === 'commands');
    expect(cmdIssues.length).toBeGreaterThan(0);
  });

  it('finds redundancy in redundant-content fixture', () => {
    const { stdout } = run('redundant-content', ['--format', 'json']);
    const parsed = JSON.parse(stdout);
    const redIssues = issuesOf(parsed, 'CLAUDE.md').filter((i: any) => i.check === 'redundancy');
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

  it('outputs valid SARIF with --format sarif', () => {
    const { stdout } = run('broken-paths', ['--format', 'sarif']);
    const parsed = JSON.parse(stdout);
    expect(parsed.version).toBe('2.1.0');
    expect(parsed.$schema).toContain('sarif');
    expect(parsed.runs).toBeInstanceOf(Array);
    expect(parsed.runs[0].tool.driver.name).toBe('ctxlint');
    expect(parsed.runs[0].results.length).toBeGreaterThan(0);
  });

  it('--quiet suppresses output but still returns correct exit code', () => {
    const quiet = run('broken-paths', ['--strict', '--quiet']);
    expect(quiet.exitCode).toBe(1);
    expectNoCrash(quiet);
    expect(quiet.stdout).toBe('');
    // The non-quiet twin prints the report, so the empty stdout above is
    // --quiet's doing and not a CLI that died before printing.
    const loud = run('broken-paths', ['--strict']);
    expect(loud.exitCode).toBe(1);
    expect(loud.stdout.trim()).not.toBe('');
  });

  it('finds contradictions across files', () => {
    const { stdout } = run('contradictions', ['--format', 'json', '--checks', 'contradictions']);
    const parsed = JSON.parse(stdout);
    const contradictionIssues = parsed.files.flatMap((f: any) =>
      f.issues.filter((i: any) => i.check === 'contradictions'),
    );
    expect(contradictionIssues.length).toBeGreaterThan(0);
  });

  it('finds frontmatter issues', () => {
    const { stdout } = run('frontmatter', ['--format', 'json', '--checks', 'frontmatter']);
    const parsed = JSON.parse(stdout);
    const fmIssues = parsed.files.flatMap((f: any) =>
      f.issues.filter((i: any) => i.check === 'frontmatter'),
    );
    expect(fmIssues.length).toBeGreaterThan(0);
    // The Copilot fixture must stay a `*.instructions.md` file: under any other
    // name the frontmatter check ignores it and this finding silently vanishes.
    const copilot = parsed.files.find(
      (f: any) =>
        f.path.replace(/\\/g, '/') === '.github/instructions/missing-applyto.instructions.md',
    );
    expect(copilot).toBeDefined();
    expect(
      copilot.issues.some(
        (i: any) => i.ruleId === 'frontmatter/missing-field' && i.message.includes('applyTo'),
      ),
    ).toBe(true);
  });

  it('reports tier-tokens section breakdown on bloated CLAUDE.md', () => {
    const { stdout } = run('bloated-claude-md', ['--format', 'json', '--checks', 'tier-tokens']);
    const parsed = JSON.parse(stdout);
    const tierIssues = parsed.files.flatMap((f: any) =>
      f.issues.filter((i: any) => i.check === 'tier-tokens'),
    );
    const breakdown = tierIssues.find((i: any) => i.ruleId === 'tier-tokens/section-breakdown');
    expect(breakdown).toBeDefined();
    expect(breakdown.suggestion).toContain('Pre-commit checklist');
  });

  it('handles an empty project (no context files, no package.json) without crashing', () => {
    const { stdout, exitCode } = run('empty-project');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('No context files found');
  });

  it('returns well-formed JSON with empty files array for empty project', () => {
    const { stdout, exitCode } = run('empty-project', ['--format', 'json']);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.files).toEqual([]);
    expect(parsed.summary.errors).toBe(0);
    expect(parsed.summary.warnings).toBe(0);
  });

  it('exits 0 for empty project even with --strict (nothing to fail on)', () => {
    const { exitCode } = run('empty-project', ['--strict']);
    expect(exitCode).toBe(0);
  });

  it('handles empty project with --mcp flag without crashing', () => {
    const { exitCode } = run('empty-project', ['--mcp']);
    expect(exitCode).toBe(0);
  });

  it('handles empty project with --session-only without crashing', () => {
    // Isolated from the real ~/.claude, ~/.codex and CLAUDE_CONFIG_DIR: the
    // session audit reads all of them.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-int-home-'));
    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
        CODEX_HOME: path.join(home, '.codex'),
      };
      const r = run('empty-project', ['--session-only'], env);
      expect(r.exitCode).toBe(0);
      expectNoCrash(r);
      expect(r.stdout).toContain('Session audit scanned');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('flags a missing Gradle project and a missing Maven module in the JVM fixtures', () => {
    for (const [fixture, rule] of [
      ['gradle-project-refs', 'commands/gradle-project-not-found'],
      ['maven-module-refs', 'commands/maven-module-not-found'],
    ]) {
      const { stdout } = run(fixture, ['--format', 'json', '--checks', 'commands']);
      const parsed = JSON.parse(stdout);
      const ids = parsed.files.flatMap((f: any) => f.issues.map((i: any) => i.ruleId));
      expect(ids).toEqual([rule]);
    }
  });

  it('respects --depth flag', () => {
    // nested-context's only context file is sub/CLAUDE.md, one level down:
    // the default depth finds it, depth 0 (root directory only) does not.
    const paths = (args: string[]) =>
      JSON.parse(run('nested-context', ['--format', 'json', ...args]).stdout).files.map((f: any) =>
        f.path.replace(/\\/g, '/'),
      );
    expect(paths([])).toContain('sub/CLAUDE.md');
    expect(paths(['--depth', '0'])).not.toContain('sub/CLAUDE.md');
    expect(paths(['--depth', '1'])).toContain('sub/CLAUDE.md');
  });

  it('--format json does not leak a literal secret through an mcp-env syntax fix', () => {
    // A Cursor config whose values pair a literal key with a bare ${VAR}: the
    // literal must not reach the JSON output through the issue text or any
    // fix (each wrong-syntax fix now rewrites only its own ${VAR} ref).
    const URL_KEY = 'Qw9Er8Ty7Ui6Op5As4Df3Gh';
    const HEADER_KEY = 'Pq1Wo2Ei3Ru4Ty5Yu6Io7Pa8Sd9Fg0Hj';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-int-envfix-'));
    try {
      fs.mkdirSync(path.join(dir, '.cursor'));
      fs.writeFileSync(
        path.join(dir, '.cursor', 'mcp.json'),
        JSON.stringify(
          {
            mcpServers: {
              api: {
                url: `https://api.example.com/mcp?api_key=${URL_KEY}&ws=\${WORKSPACE}`,
                headers: { 'X-Api-Key': `${HEADER_KEY}\${SUFFIX}` },
              },
            },
          },
          null,
          2,
        ),
      );
      const r = runDir(dir, ['--mcp-only', '--format', 'json']);
      expectNoCrash(r);
      const parsed = JSON.parse(r.stdout);
      const fixes = parsed.files
        .flatMap((f: any) => f.issues)
        .filter((i: any) => i.ruleId === 'mcp-env/wrong-syntax' && i.fix);
      // The fixture does produce the leaky fixes...
      expect(fixes.length).toBe(2);
      // ...and neither literal reaches the output.
      expect(r.stdout).not.toContain(URL_KEY);
      expect(r.stdout).not.toContain(HEADER_KEY);
      expect(r.stdout).toContain('${env:WORKSPACE}');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
