import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { VERSION } from '../version.js';

const CLI = path.resolve(__dirname, '../../dist/index.js');
const FIXTURES = path.resolve(__dirname, '../../fixtures');
const PKG = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8'));

function run(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      encoding: 'utf-8',
      // 60s to match vitest.config.ts's Windows testTimeout. This inner
      // ceiling was left at 15s when that was raised, so a real `node`
      // spawn on a contended Windows box was killed at 15s and surfaced
      // as ETIMEDOUT / exitCode 1 -- a load artifact indistinguishable
      // from a genuine failure. The outer testTimeout still catches a
      // true hang.
      timeout: 60000,
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

  // dist/index.js is a self-executing CLI dispatcher: it reads process.argv
  // at module top level and runs the linter (or MCP server) unconditionally,
  // exporting nothing. A "main" or "." export would make
  // `import '@yawlabs/ctxlint'` lint the host's argv/cwd and process.exit()
  // the importer. This is a CLI-only package -- bin is the public surface,
  // and a bare import must fail to RESOLVE (loud) rather than execute.
  it('does not expose an importable "." entry (CLI-only package)', () => {
    expect(PKG.main).toBeUndefined();
    expect(PKG.types).toBeUndefined();
    expect(PKG.exports['.']).toBeUndefined();
    expect(PKG.exports['./package.json']).toBe('./package.json');
    // bin points at the oam runtime launcher, not straight at the CLI. The
    // launcher prefers oam (https://oamjs.org) and falls back to running
    // dist/index.js in its own process, so the public surface is unchanged --
    // but it MUST stay a bin entry rather than becoming an export, which is
    // what the assertions above pin. Both files ship: see the "files" check.
    expect(PKG.bin.ctxlint).toBe('bin/ctxlint.mjs');
    expect(PKG.files).toContain('bin/ctxlint.mjs');
    expect(PKG.files).toContain('dist/index.js');
  });

  it('bare-specifier import fails to resolve instead of executing the CLI', () => {
    const req = createRequire(__filename);
    // Positive control: self-reference resolution is active (the "exports"
    // field enables it), so the failure below is the missing "." entry, not
    // a missing-node_modules artifact.
    expect(() => req.resolve('@yawlabs/ctxlint/package.json')).not.toThrow();

    let code: string | undefined;
    try {
      req.resolve('@yawlabs/ctxlint');
    } catch (err: any) {
      code = err.code;
    }
    expect(code).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED');
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

  // NOT bundled: tokens.ts loads tiktoken through createRequire, which esbuild
  // leaves as a runtime lookup, and the published tarball ships no
  // node_modules. So an installed ctxlint counts tokens with the chars/4
  // fallback in utils/tokens.ts, not cl100k. Keeping it a devDependency is the
  // deliberate trade (a 5.5 MB wasm encoder for an estimate), but the
  // parenthetical that used to sit here claimed the opposite.
  it('tiktoken is a dev dependency (the published bundle estimates instead)', () => {
    expect(PKG.devDependencies?.tiktoken).toBeDefined();
    expect(PKG.dependencies?.tiktoken).toBeUndefined();
  });

  // Canary for the REPO_ROOT hazard documented at catalog-meta.ts. That module
  // resolves the repo root two levels up from its own file, which is correct
  // for <repo>/src/core/ and WRONG for the published <pkg>/dist/index.js --
  // there it lands on the parent of the installed package. It is safe today
  // only because nothing in the runtime graph imports it, so esbuild drops it.
  //
  // Wiring a catalog reader into the CLI (a `ctxlint rules` subcommand, an
  // --explain flag) would pull it in and break silently: no build error, just
  // a read one directory too high. Asserting on the literals rather than the
  // symbol names because build.mjs sets minify:false, so a bundled string
  // survives verbatim while an identifier could in principle be renamed.
  it('catalog readers stay out of the shipped bundle', () => {
    const bundle = fs.readFileSync(CLI, 'utf-8');
    for (const literal of [
      'schemas/ctxlint-catalog.schema.json',
      'agent-session-lint-rules.json',
      'context-lint-rules.json',
    ]) {
      expect(bundle).not.toContain(literal);
    }
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

  // Org policy (GitHub Actions removed 2026-07): ctxlint runs no CI. release.sh
  // is the sole pipeline. Guard against a workflow being reintroduced without
  // revisiting the local-only release flow (release.sh step 6 would then try to
  // hand the publish back off to CI).
  it('has no GitHub Actions workflows (release.sh is the sole pipeline)', () => {
    const workflowsDir = path.join(ROOT, '.github', 'workflows');
    const present = fs.existsSync(workflowsDir)
      ? fs.readdirSync(workflowsDir).filter((f) => /\.ya?ml$/.test(f))
      : [];
    expect(present).toEqual([]);
  });

  // Nothing-lost guarantee for the removed ci.yml / release.yml: every gate
  // those workflows ran (lint, `tsc --noEmit`, build, the test suite) plus the
  // npm publish must live in release.sh, which now runs on the workstation.
  // The type-check especially -- it was a distinct workflow step release.sh
  // previously lacked, and its loss would be silent (tsc doesn't run under
  // vitest).
  it('release.sh carries every gate the removed workflows ran, and publishes locally', () => {
    const releaseSh = fs.readFileSync(path.join(ROOT, 'release.sh'), 'utf-8');
    expect(releaseSh).toMatch(/pnpm run lint/);
    expect(releaseSh).toMatch(/npx tsc --noEmit/);
    expect(releaseSh).toMatch(/pnpm run build/);
    expect(releaseSh).toMatch(/pnpm run test:run/);
    // The workstation publish path specifically -- a plain `npm publish --access
    // public` NOT followed by --provenance. Guards against the local branch
    // being removed while the (now dead) CI `--provenance` line lingers.
    expect(releaseSh).toMatch(/npm publish --access public(?! --provenance)/);
  });
});

describe('CLI error paths', () => {
  // A path that does not exist used to print "No context files found." and exit
  // 0 -- byte-identical to a genuinely empty project. A typo'd path in a CI step
  // or pre-commit hook therefore reported success forever.
  it('a nonexistent project path errors with exit 2, not a silent success', () => {
    const missing = path.join(os.tmpdir(), 'ctxlint-definitely-not-a-real-directory-xyz');
    const { stderr, exitCode } = run([missing]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('is not an existing directory');
  });

  // The control that gives the test above its meaning: an EXISTING empty
  // directory must still be the quiet exit-0 case, so the two are now
  // distinguishable rather than both reading as success.
  it('an existing but empty directory is still a clean exit 0', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-empty-'));
    try {
      const { stdout, exitCode } = run([empty]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('No context files found');
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  // A malformed auto-discovered .ctxlintrc threw past the action handler and
  // printed a raw Node stack trace with internal dist frames. The explicit
  // `--config` path already had the clean console.error + exit 2; this asserts
  // the discovered path now fails identically.
  it('a malformed .ctxlintrc exits 2 with a clean message and no stack trace', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-badcfg-'));
    try {
      fs.writeFileSync(path.join(dir, '.ctxlintrc'), '{ this is not json');
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# P\n');
      const { stderr, exitCode } = run([dir]);
      expect(exitCode).toBe(2);
      expect(stderr).toContain('Invalid JSON in');
      // The actual regression: no thrown-exception presentation.
      expect(stderr).not.toContain('dist/index.js:');
      expect(stderr).not.toMatch(/^\s+at /m);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
