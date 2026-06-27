import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import simpleGit from 'simple-git';
import { getCommitsSinceBatch, resetGit } from '../git.js';

let tmpDir: string;
let realTmpDir: string;

async function commit(msg: string, files: Array<{ rel: string; body: string }>) {
  const git = simpleGit(realTmpDir);
  for (const f of files) {
    const abs = path.join(realTmpDir, f.rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.body);
    await git.add(f.rel.replace(/\\/g, '/'));
  }
  await git.commit(msg);
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-git-'));
  // Resolve symlinks so the path we hand to git matches what git emits back.
  realTmpDir = fs.realpathSync(tmpDir);
  const git = simpleGit(realTmpDir);
  // -b main pins the initial branch in one shot; avoids a follow-up checkout
  // that can race a slow `git init` on Windows.
  await git.raw(['init', '-b', 'main']);
  // Local identity so commit() doesn't fail on machines without a global one.
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('user.name', 'Test');
  resetGit();
}, 30000);

afterEach(async () => {
  resetGit();
  // Windows leaves file handles on .git/index momentarily after the last git
  // subprocess exits; rmSync's own maxRetries doesn't cover EBUSY here.
  // A short wait + force is enough.
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
}, 10000);

// Real-git tests against tmpdir repos -- on Windows the fork+exec for each
// git call is slow enough that the default 5000ms per-test budget gets thin.
describe('getCommitsSinceBatch path normalization', { timeout: 30000 }, () => {
  it('matches a plain relative path against git output', async () => {
    const before = new Date(Date.now() - 60 * 1000);
    await commit('add foo', [{ rel: 'src/foo.ts', body: 'export const a = 1;' }]);
    await commit('touch foo', [{ rel: 'src/foo.ts', body: 'export const a = 2;' }]);

    const counts = await getCommitsSinceBatch(realTmpDir, ['src/foo.ts'], before);
    expect(counts.get('src/foo.ts')).toBe(2);
  });

  it('matches a ./-prefixed relative path against git output', async () => {
    const before = new Date(Date.now() - 60 * 1000);
    await commit('add foo', [{ rel: 'src/foo.ts', body: 'export const a = 1;' }]);
    await commit('touch foo', [{ rel: 'src/foo.ts', body: 'export const a = 2;' }]);

    const counts = await getCommitsSinceBatch(realTmpDir, ['./src/foo.ts'], before);
    // Key in returned map must be EXACTLY what the caller passed in.
    expect(counts.has('./src/foo.ts')).toBe(true);
    expect(counts.get('./src/foo.ts')).toBe(2);
  });

  it('matches a Windows-shaped absolute path (drive letter + backslashes)', async () => {
    const before = new Date(Date.now() - 60 * 1000);
    await commit('add foo', [{ rel: 'src/foo.ts', body: 'export const a = 1;' }]);

    // Build a realistic absolute path INSIDE the project root. On Windows
    // this looks like `C:\Users\...\ctxlint-git-XYZ\src\foo.ts`; on
    // macOS/Linux like `/tmp/ctxlint-git-XYZ/src/foo.ts`. Either way the
    // normalizer should relativize against projectRoot and match git's
    // `src/foo.ts` output.
    const absolute = path.join(realTmpDir, 'src', 'foo.ts');
    const counts = await getCommitsSinceBatch(realTmpDir, [absolute], before);
    // The key in the returned map must be EXACTLY the caller's original string,
    // not the normalized form. (Used to be a bug: the post-loop remap only
    // un-did the backslash swap, never the drive strip, so this returned 0.)
    expect(counts.has(absolute)).toBe(true);
    expect(counts.get(absolute)).toBe(1);
  });

  it('does not match a ../ path that points outside the repo', async () => {
    const before = new Date(Date.now() - 60 * 1000);
    await commit('add foo', [{ rel: 'src/foo.ts', body: 'export const a = 1;' }]);

    const counts = await getCommitsSinceBatch(realTmpDir, ['../shared/x.ts'], before);
    // No crash, key preserved, count is 0 -- git never emits paths starting
    // with `..` from inside this repo, so the reference is unreachable.
    expect(counts.has('../shared/x.ts')).toBe(true);
    expect(counts.get('../shared/x.ts')).toBe(0);
  });

  it('returns the same count for every equivalent spelling of the same path', async () => {
    const before = new Date(Date.now() - 60 * 1000);
    await commit('add foo', [{ rel: 'src/foo.ts', body: 'export const a = 1;' }]);
    await commit('touch foo again', [{ rel: 'src/foo.ts', body: 'export const a = 3;' }]);

    const absoluteInRoot = path.join(realTmpDir, 'src', 'foo.ts');
    const inputs = ['src/foo.ts', './src/foo.ts', absoluteInRoot, 'src\\foo.ts'];
    const counts = await getCommitsSinceBatch(realTmpDir, inputs, before);

    for (const i of inputs) {
      expect(counts.has(i)).toBe(true);
      expect(counts.get(i)).toBe(2);
    }
  });

  it('preserves caller keys when multiple originals collapse to the same normalized path', async () => {
    const before = new Date(Date.now() - 60 * 1000);
    await commit('add foo', [{ rel: 'src/foo.ts', body: 'export const a = 1;' }]);

    const counts = await getCommitsSinceBatch(realTmpDir, ['src/foo.ts', './src/foo.ts'], before);
    expect(counts.get('src/foo.ts')).toBe(1);
    expect(counts.get('./src/foo.ts')).toBe(1);
  });

  it('counts commits against a directory reference (with trailing slash)', async () => {
    const before = new Date(Date.now() - 60 * 1000);
    await commit('a', [{ rel: 'src/components/a.ts', body: 'export const a = 1;' }]);
    await commit('b', [{ rel: 'src/components/b.ts', body: 'export const b = 1;' }]);

    const counts = await getCommitsSinceBatch(realTmpDir, ['src/components/'], before);
    expect(counts.get('src/components/')).toBe(2);
  });

  it('returns zero map for empty input without invoking git', async () => {
    const counts = await getCommitsSinceBatch(realTmpDir, [], new Date(0));
    expect(counts.size).toBe(0);
  });

  it('counts a non-ASCII filename under an ASCII directory ref', async () => {
    const before = new Date(Date.now() - 60 * 1000);
    // Under git's default core.quotePath=true the changed line comes back as
    // "src/f\303\266\303\266.txt" (quoted, octal-escaped) and the leading
    // quote char breaks the `src/` prefix match. The production call pins
    // core.quotepath=false, so the raw UTF-8 path must match.
    await commit('add unicode', [{ rel: 'src/föö.txt', body: 'hi' }]);

    const counts = await getCommitsSinceBatch(realTmpDir, ['src/'], before);
    expect(counts.get('src/')).toBe(1);
  });

  it('matches a non-ASCII path requested directly (the MCP validate_path shape)', async () => {
    const before = new Date(Date.now() - 60 * 1000);
    await commit('add unicode', [{ rel: 'src/föö.txt', body: 'hi' }]);
    await commit('touch unicode', [{ rel: 'src/föö.txt', body: 'hi again' }]);

    const counts = await getCommitsSinceBatch(realTmpDir, ['src/föö.txt'], before);
    expect(counts.has('src/föö.txt')).toBe(true);
    expect(counts.get('src/föö.txt')).toBe(2);
  });

  it('still counts a valid path when glob and escaping siblings are in the same batch', async () => {
    const before = new Date(Date.now() - 60 * 1000);
    await commit('add foo', [{ rel: 'src/foo.ts', body: 'export const a = 1;' }]);
    await commit('touch foo', [{ rel: 'src/foo.ts', body: 'export const a = 2;' }]);

    // The glob (`src/*.ts`) and the repo-escaping ref (`../escape.ts`) are both
    // dropped from the server-side `--` pathspec; a raw `-- ../escape.ts` would
    // make git error and zero the whole batch. The valid sibling must still get
    // its real count from the in-process pass.
    const counts = await getCommitsSinceBatch(
      realTmpDir,
      ['src/foo.ts', 'src/*.ts', '../escape.ts'],
      before,
    );
    expect(counts.get('src/foo.ts')).toBe(2);
    expect(counts.get('src/*.ts')).toBe(0);
    expect(counts.get('../escape.ts')).toBe(0);
  });

  it.runIf(process.platform === 'win32')(
    'matches a differently-cased ref on win32 (case-insensitive filesystem)',
    async () => {
      const before = new Date(Date.now() - 60 * 1000);
      await commit('add foo', [{ rel: 'src/foo.ts', body: 'export const a = 1;' }]);

      // `SRC/Foo.ts` resolves on a case-insensitive Windows filesystem while
      // git stores `src/foo.ts`; the normalizer case-folds both sides on
      // win32 so the ref still counts instead of silently returning 0.
      const counts = await getCommitsSinceBatch(realTmpDir, ['SRC/Foo.ts'], before);
      expect(counts.has('SRC/Foo.ts')).toBe(true);
      expect(counts.get('SRC/Foo.ts')).toBe(1);
    },
  );
});
