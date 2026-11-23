import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error scripts/lib is plain JS with no type declarations
import { atLeast, compareVersions, parseVersion } from '../../scripts/lib/semver.mjs';
// @ts-expect-error scripts/lib is plain JS with no type declarations
import { isMainModule } from '../../scripts/lib/main-module.mjs';

// The shared helpers in scripts/lib. The launcher's own copies are held to
// these in launcher.test.ts; the floor checkers are covered through their
// CLIs in oam-floor.test.ts and yaw-mcp-floor.test.ts.
const ROOT = path.resolve(__dirname, '../..');

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('scripts/lib/semver.mjs', () => {
  it('parses X.Y.Z only from the start of the text', () => {
    expect(parseVersion('v0.20.2')).toEqual([0, 20, 2]);
    expect(parseVersion(' 1.2.3-rc.1\n')).toEqual([1, 2, 3]);
    expect(parseVersion('oam 0.20.2')).toBeNull();
    expect(parseVersion('')).toBeNull();
  });

  it('compares numerically, not as text', () => {
    expect(compareVersions([0, 100, 0], [0, 21, 0])).toBe(1);
    expect(compareVersions([0, 20, 2], [0, 20, 2])).toBe(0);
    expect(compareVersions([0, 9, 9], [1, 0, 0])).toBe(-1);
    expect(atLeast([0, 20, 2], [0, 20, 2])).toBe(true);
    expect(atLeast([0, 20, 1], [0, 20, 2])).toBe(false);
    expect(atLeast(null, [0, 0, 0])).toBe(false);
  });
});

describe('scripts/lib/main-module.mjs', () => {
  it('answers true through a junction or symlink, and false for another file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-main-module-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'a.mjs');
    fs.writeFileSync(file, '');
    const link = path.join(dir, 'linked');
    fs.symlinkSync(dir, link, process.platform === 'win32' ? 'junction' : 'dir');
    const url = pathToFileURL(fs.realpathSync(file)).href;
    expect(isMainModule(path.join(link, 'a.mjs'), url)).toBe(true);
    expect(isMainModule(path.join(dir, 'b.mjs'), url)).toBe(false);
    expect(isMainModule(undefined, url)).toBe(false);
  });

  // generate-catalog-prose.mjs compared argv[1] with its own path as raw
  // strings, so run through a junctioned checkout its main() never ran and
  // `--check` exited 0 having checked nothing.
  it('makes generate-catalog-prose --check run through a junctioned checkout', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-junction-'));
    tmpDirs.push(dir);
    const link = path.join(dir, 'checkout');
    fs.symlinkSync(ROOT, link, process.platform === 'win32' ? 'junction' : 'dir');
    const stdout = execFileSync(
      process.execPath,
      [path.join(link, 'scripts', 'generate-catalog-prose.mjs'), '--check'],
      { cwd: link, encoding: 'utf8' },
    );
    expect(stdout).toContain('Catalog-derived prose is in sync.');
  });
});
