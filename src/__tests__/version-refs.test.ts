import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import {
  VERSION_REFS,
  applyVersionRefs,
  computeTargets,
  // @ts-expect-error sync-version-refs.mjs is plain JS with no type declarations
} from '../../scripts/sync-version-refs.mjs';

const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts', 'sync-version-refs.mjs');

type Ref = { file: string; label: string; pattern: RegExp };
const refsFor = (file: string): Ref[] => VERSION_REFS.filter((r: Ref) => r.file === file);

const README = [
  '## Example Output',
  '',
  '```',
  'ctxlint v0.9.10',
  '',
  'Scanning /Users/you/my-app...',
  '```',
  '',
  '```yaml',
  'repos:',
  '  - repo: https://github.com/pre-commit/pre-commit-hooks',
  '    rev: v4.6.0',
  '  - repo: https://github.com/yawlabs/ctxlint',
  '    rev: v0.9.10',
  '    hooks:',
  '      - id: ctxlint',
  '```',
  '',
].join('\n');

const HOOKS = [
  '- id: ctxlint',
  '  entry: npx @yawlabs/ctxlint@0.24.1 --strict',
  '  language: node',
  '',
].join('\n');

describe('sync-version-refs', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('checked-in pins match package.json (--check)', () => {
    // Fails `npm test` when a pin drifts or a README edit breaks a pattern --
    // long before release.sh step 4 would hit it. The stdout assertion is what
    // tells a passing check from a script whose main() never ran (also exit 0).
    const stdout = execFileSync(process.execPath, [SCRIPT, '--check'], {
      cwd: ROOT,
      encoding: 'utf-8',
    });
    expect(stdout).toContain('Pinned version refs match package.json');
  });

  it('rewrites the README rev and banner, and nothing else', () => {
    const { next, missing } = applyVersionRefs(README, refsFor('README.md'), '1.2.3');
    expect(missing).toEqual([]);
    expect(next).toBe(
      README.replace('ctxlint v0.9.10', 'ctxlint v1.2.3').replace(
        'ctxlint\n    rev: v0.9.10',
        'ctxlint\n    rev: v1.2.3',
      ),
    );
    // The other hook's rev is not ctxlint's to rewrite.
    expect(next).toContain('rev: v4.6.0');
  });

  it('rewrites the .pre-commit-hooks.yaml npx pin', () => {
    const { next, missing } = applyVersionRefs(HOOKS, refsFor('.pre-commit-hooks.yaml'), '1.2.3');
    expect(missing).toEqual([]);
    expect(next).toBe(HOOKS.replace('@0.24.1', '@1.2.3'));
  });

  it('keeps CRLF line endings intact', () => {
    const crlf = README.replace(/\n/g, '\r\n');
    const { next, missing } = applyVersionRefs(crlf, refsFor('README.md'), '1.2.3');
    expect(missing).toEqual([]);
    expect(next).toContain('\r\nctxlint v1.2.3\r\n');
    expect(next).toContain('ctxlint\r\n    rev: v1.2.3\r\n');
  });

  it('reports each ref that matches nothing', () => {
    const noRev = README.replace('rev: v0.9.10', 'rev: 0.9.10');
    const noBanner = README.replace('ctxlint v0.9.10', 'ctxlint 0.9.10');
    const [rev, banner] = refsFor('README.md');
    expect(applyVersionRefs(noRev, refsFor('README.md'), '1.2.3').missing).toEqual([rev.label]);
    expect(applyVersionRefs(noBanner, refsFor('README.md'), '1.2.3').missing).toEqual([
      banner.label,
    ]);
    // A lone `rev:` with no ctxlint repo line above it is not the ctxlint pin.
    const otherRepo = README.replace('yawlabs/ctxlint', 'yawlabs/other');
    expect(applyVersionRefs(otherRepo, refsFor('README.md'), '1.2.3').missing).toEqual([rev.label]);
  });

  it('is idempotent at the target version', () => {
    const once = applyVersionRefs(README, refsFor('README.md'), '1.2.3').next;
    const twice = applyVersionRefs(once, refsFor('README.md'), '1.2.3');
    expect(twice).toEqual({ next: once, missing: [] });
  });

  function mkTmp(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-version-refs-'));
    tmpDirs.push(dir);
    return dir;
  }

  /**
   * A scratch repo holding a copy of the script. It resolves the files it edits
   * (and package.json, for --check) relative to its own location, exactly as
   * release.sh invokes it from the repo root.
   */
  function scratchRepo(readme: string, hooks: string, pkgVersion = '0.0.0'): string {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, 'README.md'), readme);
    fs.writeFileSync(path.join(dir, '.pre-commit-hooks.yaml'), hooks);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: pkgVersion }));
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'sync-version-refs.mjs'));
    return dir;
  }

  function runCli(root: string, args: string[]) {
    const script = path.join(root, 'scripts', 'sync-version-refs.mjs');
    try {
      const stdout = execFileSync(process.execPath, [script, ...args], {
        cwd: root,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      return { status: 0, stdout, stderr: '' };
    } catch (err: any) {
      return {
        status: err.status as number,
        stdout: String(err.stdout),
        stderr: String(err.stderr),
      };
    }
  }

  const read = (dir: string, file: string) => fs.readFileSync(path.join(dir, file), 'utf-8');

  it('computeTargets reads every file a ref names', () => {
    const dir = scratchRepo(README, HOOKS);
    const targets = computeTargets('1.2.3', dir);
    expect(targets.map((t: { file: string }) => t.file).sort()).toEqual([
      '.pre-commit-hooks.yaml',
      'README.md',
    ]);
    for (const t of targets) {
      expect(t.missing).toEqual([]);
      expect(t.next).not.toBe(t.current);
    }
  });

  it('CLI writes nothing when any pattern is missing', () => {
    const dir = scratchRepo(README.replace('ctxlint v0.9.10', 'ctxlint 0.9.10'), HOOKS);
    const { status, stderr } = runCli(dir, ['1.2.3']);
    expect(status).toBe(1);
    expect(stderr).toContain('README.md: Example Output banner');
    // All-or-nothing: the hooks file, whose pattern DID match, is untouched.
    expect(read(dir, '.pre-commit-hooks.yaml')).toBe(HOOKS);
  });

  it('CLI rewrites a scratch repo and rejects a malformed version', () => {
    const dir = scratchRepo(README, HOOKS);
    expect(runCli(dir, ['v1.2.3']).status).toBe(1);
    expect(read(dir, 'README.md')).toBe(README);

    expect(runCli(dir, ['1.2.3'])).toMatchObject({ status: 0 });
    expect(read(dir, 'README.md')).toContain('    rev: v1.2.3\n');
    expect(read(dir, '.pre-commit-hooks.yaml')).toContain('npx @yawlabs/ctxlint@1.2.3 --strict');
  });

  it('--check fails on a drifted pin without writing, and passes once it is synced', () => {
    // README pins 0.9.10 (in sync with package.json); the hooks file pins 0.24.1.
    const dir = scratchRepo(README, HOOKS, '0.9.10');
    const drifted = runCli(dir, ['--check']);
    expect(drifted.status).toBe(1);
    expect(drifted.stderr).toContain('do not match package.json (0.9.10)');
    expect(drifted.stderr).toContain('  .pre-commit-hooks.yaml');
    expect(drifted.stderr).not.toContain('  README.md');
    expect(read(dir, '.pre-commit-hooks.yaml')).toBe(HOOKS);

    fs.writeFileSync(path.join(dir, '.pre-commit-hooks.yaml'), HOOKS.replace('0.24.1', '0.9.10'));
    const synced = runCli(dir, ['--check']);
    expect(synced).toMatchObject({ status: 0 });
    expect(synced.stdout).toContain('Pinned version refs match package.json (0.9.10)');
  });

  it('CLI runs when invoked through a symlinked or junctioned checkout', () => {
    // node resolves the entry module's import.meta.url through the link but
    // leaves argv[1] as typed; a plain string compare would skip main() and
    // exit 0 having synced nothing. A junction on Windows needs no privilege.
    const dir = scratchRepo(README, HOOKS);
    const link = path.join(mkTmp(), 'linked-checkout');
    fs.symlinkSync(dir, link, process.platform === 'win32' ? 'junction' : 'dir');

    const { status, stdout } = runCli(link, ['1.2.3']);
    expect(status).toBe(0);
    expect(stdout).toContain('synced README.md to 1.2.3');
    expect(read(dir, '.pre-commit-hooks.yaml')).toContain('npx @yawlabs/ctxlint@1.2.3 --strict');
  });
});
