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
    // The mode that fails `npm test` when a pin drifts or a README edit breaks
    // a pattern -- long before release.sh step 4 would hit it.
    expect(() =>
      execFileSync(process.execPath, [SCRIPT, '--check'], { cwd: ROOT, stdio: 'pipe' }),
    ).not.toThrow();
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

  function scratchRepo(readme: string, hooks: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-version-refs-'));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'README.md'), readme);
    fs.writeFileSync(path.join(dir, '.pre-commit-hooks.yaml'), hooks);
    return dir;
  }

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
    // Runs a copy of the script from a scratch root: it resolves the files it
    // edits relative to its own location, exactly as release.sh invokes it.
    const dir = scratchRepo(README.replace('ctxlint v0.9.10', 'ctxlint 0.9.10'), HOOKS);
    fs.mkdirSync(path.join(dir, 'scripts'));
    const script = path.join(dir, 'scripts', 'sync-version-refs.mjs');
    fs.copyFileSync(SCRIPT, script);

    let status = 0;
    let stderr = '';
    try {
      execFileSync(process.execPath, [script, '1.2.3'], { cwd: dir, stdio: 'pipe' });
    } catch (err: any) {
      status = err.status;
      stderr = String(err.stderr);
    }
    expect(status).toBe(1);
    expect(stderr).toContain('README.md: Example Output banner');
    // All-or-nothing: the hooks file, whose pattern DID match, is untouched.
    expect(fs.readFileSync(path.join(dir, '.pre-commit-hooks.yaml'), 'utf-8')).toBe(HOOKS);
  });

  it('CLI rewrites a scratch repo and rejects a malformed version', () => {
    const dir = scratchRepo(README, HOOKS);
    fs.mkdirSync(path.join(dir, 'scripts'));
    const script = path.join(dir, 'scripts', 'sync-version-refs.mjs');
    fs.copyFileSync(SCRIPT, script);

    expect(() =>
      execFileSync(process.execPath, [script, 'v1.2.3'], { cwd: dir, stdio: 'pipe' }),
    ).toThrow();
    expect(fs.readFileSync(path.join(dir, 'README.md'), 'utf-8')).toBe(README);

    execFileSync(process.execPath, [script, '1.2.3'], { cwd: dir, stdio: 'pipe' });
    expect(fs.readFileSync(path.join(dir, 'README.md'), 'utf-8')).toContain('    rev: v1.2.3\n');
    expect(fs.readFileSync(path.join(dir, '.pre-commit-hooks.yaml'), 'utf-8')).toContain(
      'npx @yawlabs/ctxlint@1.2.3 --strict',
    );
  });
});
