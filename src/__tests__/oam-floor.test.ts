import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Ported from @yawlabs/aws-mcp's src/oam-floor.test.ts. The subject lives in
// scripts/, which tsconfig does not include, so it is run as a subprocess, the
// way release.sh runs it.
const REPO_ROOT = path.resolve(__dirname, '../..');
const CHECKER = path.join(REPO_ROOT, 'scripts', 'check-oam-floor.mjs');

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

/** A synthetic repo carrying only the files the checker reads. */
function fixture(files: { launcher?: string; readme?: string; launcherTest?: string }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-floor-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', '__tests__'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'bin', 'ctxlint.mjs'),
    files.launcher ?? 'const OAM_MIN = [0, 18, 0];\n',
  );
  if (files.readme !== undefined) fs.writeFileSync(path.join(root, 'README.md'), files.readme);
  fs.writeFileSync(
    path.join(root, 'src', '__tests__', 'launcher.test.ts'),
    files.launcherTest ?? '    expect(floor).toEqual([0, 18, 0]);\n',
  );
  return root;
}

/** Offline on purpose: these cases are about drift, and the network half is not
 *  theirs to exercise (nor should a unit test depend on GitHub being reachable). */
function runChecker(root: string): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, [CHECKER, '--offline', '--root', root], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('the oam floor is consistent across this repo', () => {
  // The half of the staleness check that needs no network, so it runs on every
  // test run -- which is what makes it gate a release, because release.sh runs
  // the suite.
  it('the real repo agrees with itself', () => {
    const r = runChecker(REPO_ROOT);
    expect(r.code, `check-oam-floor reported drift in this repo:\n${r.out}`).toBe(0);
    expect(r.out).toMatch(/no drift/);
  });
});

describe('check-oam-floor catches drift', () => {
  // A checker with no test that it FAILS is worse than none: the first run of
  // aws-mcp's had a regex containing literal backspace bytes, so it matched
  // nothing and reported a clean repo.

  it('flags a launcher comment still claiming the previous floor', () => {
    const root = fixture({
      launcher:
        'const OAM_MIN = [0, 18, 0];\n// It never runs the CLI on an oam older than 0.15.2.\n',
    });
    const r = runChecker(root);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/DRIFT/);
    expect(r.out, 'the message must name the file and line').toMatch(/bin\/ctxlint\.mjs:2/);
    expect(r.out, 'and the version it found').toMatch(/0\.15\.2/);
  });

  it('flags a launcher test still pinning the previous floor', () => {
    const root = fixture({ launcherTest: '    expect(floor).toEqual([0, 15, 2]);\n' });
    const r = runChecker(root);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/pins the floor at 0\.15\.2, but OAM_MIN is 0\.18\.0/);
  });

  it('flags the floor pin being gone', () => {
    // Removing the pin is drift too: the suite then asserts nothing about the floor.
    const root = fixture({ launcherTest: '    // the floor assertion was deleted\n' });
    const r = runChecker(root);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/no longer pins the floor/);
  });

  it('does NOT flag a line naming a host version beside the floor', () => {
    // The launcher's own diagnostic is "this process is oam 0.9.0, older than
    // 0.18.0" -- two versions with different roles, both correct.
    const root = fixture({
      launcherTest:
        '    expect(floor).toEqual([0, 18, 0]);\n' +
        '      /this process is oam 0\\.9\\.0, older than 0\\.18\\.0, and no newer oam was found/,\n',
    });
    const r = runChecker(root);
    expect(r.code, r.out).toBe(0);
  });

  it('flags a stale claim on a line that also names the current floor', () => {
    const root = fixture({
      readme:
        '| `CTXLINT_RUNTIME` | on oam if that is 0.18.0 or newer. An oam host older than 0.15.2 never runs it. |\n',
    });
    const r = runChecker(root);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/README\.md:1 +says 0\.15\.2/);
  });

  it('does NOT flag versions of other dependencies', () => {
    const root = fixture({
      readme: 'Requires Node 20.0.0 or newer. simple-git older than 4.0.1 is advised against.\n',
    });
    const r = runChecker(root);
    expect(r.code, r.out).toBe(0);
  });

  it('does NOT flag the pre-0.9.0 stdio boundary or a line about the past', () => {
    const root = fixture({
      launcher:
        'const OAM_MIN = [0, 18, 0];\n' +
        '// an oam older than 0.9.0 fails to hand over the fds on inherit\n' +
        '// the launcher bound to 0.9.0 despite a newer oam on PATH\n',
    });
    const r = runChecker(root);
    expect(r.code, r.out).toBe(0);
  });

  it('fails loudly when OAM_MIN cannot be found at all', () => {
    const root = fixture({ launcher: '// somebody renamed the constant\n' });
    const r = runChecker(root);
    expect(r.code, r.out).not.toBe(0);
    expect(r.out).toMatch(/OAM_MIN/);
  });
});
