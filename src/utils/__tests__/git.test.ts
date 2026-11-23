import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { simpleGit } from 'simple-git';
import {
  getCommitActivity,
  getCommitsSinceBatch,
  getFileLastCommit,
  isGitRepo,
  isShallowRepo,
  memoProbe,
  resetGit,
} from '../git.js';

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

describe('getCommitActivity', { timeout: 60000 }, () => {
  it('counts refs when projectRoot is a SUBDIRECTORY of the repo', async () => {
    // git log prints repo-root-relative paths unless --relative is passed;
    // the refs are projectRoot-relative, so without it nothing ever matched.
    const before = new Date(Date.now() - 60 * 1000);
    await commit('add', [{ rel: 'pkg/src/foo.ts', body: 'a' }]);
    await commit('touch', [{ rel: 'pkg/src/foo.ts', body: 'b' }]);
    resetGit();
    const pkg = path.join(realTmpDir, 'pkg');
    const counts = await getCommitsSinceBatch(pkg, ['src/foo.ts'], before);
    expect(counts.get('src/foo.ts')).toBe(2);
  });

  it('does not count changes outside a subdirectory projectRoot', async () => {
    const before = new Date(Date.now() - 60 * 1000);
    await commit('add', [
      { rel: 'pkg/README.md', body: 'a' },
      { rel: 'src/foo.ts', body: 'a' },
    ]);
    resetGit();
    // `src/foo.ts` exists only at the REPO root, not under pkg/.
    const counts = await getCommitsSinceBatch(path.join(realTmpDir, 'pkg'), ['src/foo.ts'], before);
    expect(counts.get('src/foo.ts')).toBe(0);
  });

  it('with { commit }, counts only commits strictly after it', async () => {
    await commit('doc + src together', [
      { rel: 'CLAUDE.md', body: 'doc' },
      { rel: 'src/foo.ts', body: 'a' },
    ]);
    const docHash = (await simpleGit(realTmpDir).revparse(['HEAD'])).trim();
    let activity = await getCommitActivity(realTmpDir, ['src/foo.ts'], { commit: docHash });
    expect(activity.perPath.get('src/foo.ts')).toBe(0);
    expect(activity.distinctCommits).toBe(0);

    await commit('touch', [{ rel: 'src/foo.ts', body: 'b' }]);
    activity = await getCommitActivity(realTmpDir, ['src/foo.ts'], { commit: docHash });
    expect(activity.perPath.get('src/foo.ts')).toBe(1);
  });

  it('reports distinct commits: one commit touching three refs counts once', async () => {
    await commit('base', [{ rel: 'CLAUDE.md', body: 'doc' }]);
    const base = (await simpleGit(realTmpDir).revparse(['HEAD'])).trim();
    await commit('touch three', [
      { rel: 'a.ts', body: '1' },
      { rel: 'b.ts', body: '1' },
      { rel: 'c.ts', body: '1' },
    ]);
    const activity = await getCommitActivity(realTmpDir, ['a.ts', 'b.ts', 'c.ts'], {
      commit: base,
    });
    expect([...activity.perPath.values()]).toEqual([1, 1, 1]);
    expect(activity.distinctCommits).toBe(1);
  });

  it('counts an absolute in-root path whose name merely starts with ".."', async () => {
    // `..notes.md` is inside the root; a bare startsWith('..') test treated
    // its path.relative form as an escape and dropped it.
    const before = new Date(Date.now() - 60 * 1000);
    await commit('add', [{ rel: '..notes.md', body: 'a' }]);
    const counts = await getCommitsSinceBatch(
      realTmpDir,
      [path.join(realTmpDir, '..notes.md')],
      before,
    );
    expect(counts.get(path.join(realTmpDir, '..notes.md'))).toBe(1);
  });
});

describe('repo probes', { timeout: 60000 }, () => {
  it('isGitRepo is true inside a repo and false outside, memoised per root', async () => {
    expect(await isGitRepo(realTmpDir)).toBe(true);
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-nogit-'));
    try {
      expect(await isGitRepo(plain)).toBe(false);
      // Same promise for the same root until resetGit().
      expect(isGitRepo(realTmpDir)).toBe(isGitRepo(realTmpDir));
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  it('caches a "not a git repository" answer but not a failed probe', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-nogit-'));
    const later = path.join(plain, 'later');
    try {
      // git's own "not a git repository" is a stable answer: memoised.
      const first = isGitRepo(plain);
      expect(await first).toBe(false);
      expect(isGitRepo(plain)).toBe(first);
      // A probe that fails for any other reason (here: the directory does not
      // exist yet, so simple-git refuses before git runs) reads as false but
      // is not cached -- the next call probes again.
      expect(await isGitRepo(later)).toBe(false);
      expect(await isShallowRepo(later)).toBe(false);
      fs.mkdirSync(later);
      await simpleGit(later).raw(['init', '-b', 'main']);
      expect(await isGitRepo(later)).toBe(true);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  it('memoProbe drops a transient probe failure so the next caller retries', async () => {
    const memo = new Map<string, Promise<boolean>>();
    let calls = 0;
    const flaky = async (): Promise<boolean> => {
      calls++;
      if (calls === 1) throw Object.assign(new Error('spawn git EAGAIN'), { code: 'EAGAIN' });
      return true;
    };
    expect(await memoProbe(memo, '/root', flaky)).toBe(false);
    expect(memo.has('/root')).toBe(false);
    expect(await memoProbe(memo, '/root', flaky)).toBe(true);
    expect(calls).toBe(2);
    // The success is memoised.
    expect(await memoProbe(memo, '/root', flaky)).toBe(true);
    expect(calls).toBe(2);
  });

  it('memoProbe keeps a definite "not a git repository" answer', async () => {
    const memo = new Map<string, Promise<boolean>>();
    let calls = 0;
    const notRepo = async (): Promise<boolean> => {
      calls++;
      throw new Error('fatal: not a git repository (or any of the parent directories): .git');
    };
    const first = memoProbe(memo, '/plain', notRepo);
    expect(await first).toBe(false);
    expect(memoProbe(memo, '/plain', notRepo)).toBe(first);
    expect(calls).toBe(1);
  });

  it('isShallowRepo distinguishes a full repo from a depth-1 clone', async () => {
    await commit('one', [{ rel: 'a.txt', body: '1' }]);
    await commit('two', [{ rel: 'a.txt', body: '2' }]);
    expect(await isShallowRepo(realTmpDir)).toBe(false);
    const cloneParent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-shallow-')));
    const clone = path.join(cloneParent, 'c');
    try {
      const url =
        'file://' + (process.platform === 'win32' ? '/' : '') + realTmpDir.replace(/\\/g, '/');
      await simpleGit(cloneParent).raw(['clone', '--depth', '1', url, 'c']);
      expect(await isShallowRepo(clone)).toBe(true);
    } finally {
      fs.rmSync(cloneParent, { recursive: true, force: true });
    }
  });

  it('getFileLastCommit returns the full hash and author date of the last touching commit', async () => {
    await commit('one', [{ rel: 'CLAUDE.md', body: '1' }]);
    const head = (await simpleGit(realTmpDir).revparse(['HEAD'])).trim();
    await commit('two', [{ rel: 'other.txt', body: '2' }]);
    const last = await getFileLastCommit(realTmpDir, 'CLAUDE.md');
    expect(last?.hash).toBe(head);
    expect(Number.isNaN(last!.date.getTime())).toBe(false);
    expect(await getFileLastCommit(realTmpDir, 'never.md')).toBeNull();
  });
});
