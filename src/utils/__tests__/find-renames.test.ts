import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import simpleGit from 'simple-git';
import { findRenames, parseRenameLog, resetGit, type RenameInfo } from '../git.js';

// The exact flags findRenames hands to `git log`. We capture the live output
// of THIS command (without the trailing `-- <path>` pathspec) to feed the
// real parsing engine a realistic, git-produced fixture rather than a
// hand-typed string. Keeping the flags in lockstep with the production call
// is what makes the parser tests an integration test at the git boundary.
const RENAME_LOG_ARGS = [
  '-c',
  'core.quotepath=false',
  'log',
  '--diff-filter=R',
  '--find-renames',
  '--name-status',
  '--format=%H %aI',
  '-50',
];

let tmpDir: string;
let realTmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-rename-'));
  // Resolve symlinks so the path we hand to git matches what git emits back.
  realTmpDir = fs.realpathSync(tmpDir);
  const git = simpleGit(realTmpDir);
  await git.raw(['init', '-b', 'main']);
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('user.name', 'Test');
  // Pin autocrlf off so the rename-detection similarity score isn't perturbed
  // by line-ending rewrites on the Windows runner.
  await git.addConfig('core.autocrlf', 'false');
  resetGit();
}, 30000);

afterEach(async () => {
  resetGit();
  // Windows holds .git/index handles briefly after the last git subprocess
  // exits; retry the cleanup a few times (mirrors git.test.ts).
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

// ---------------------------------------------------------------------------
// Gap 1: findRenames against a REAL `git mv`, at the real git boundary.
//
// findRenames scans an UN-scoped `--diff-filter=R` rename log (a path-scoped
// log finds nothing once the old name has been renamed away, and `--follow`
// only tracks a path that still exists at HEAD) and matches the entry whose
// SOURCE path is the queried ref. So for the OLD path (the caller pattern from
// paths.ts) it returns the rename; the NEW path is not a rename SOURCE, so it
// stays null.
// ---------------------------------------------------------------------------
describe('findRenames (real git mv, unscoped rename match)', { timeout: 30000 }, () => {
  it('finds the rename for the OLD (now-missing) path -- the caller pattern from paths.ts', async () => {
    await commit('add', [{ rel: 'src/old.ts', body: 'a\nb\nc\nd\ne\n' }]);
    const git = simpleGit(realTmpDir);
    await git.mv('src/old.ts', 'src/new.ts');
    await git.commit('rename old -> new');

    // paths.ts:81 passes ref.value, which is the path the doc references --
    // i.e. the OLD path that no longer exists on disk.
    const result = await findRenames(realTmpDir, 'src/old.ts');
    expect(result).not.toBeNull();
    const r = result as RenameInfo;
    expect(r.oldPath).toBe('src/old.ts');
    expect(r.newPath).toBe('src/new.ts');
    expect(r.commitHash).toMatch(/^[a-f0-9]{7}$/);
    expect(r.daysAgo).toBe(0);
  });

  it('returns null for the NEW path (it is not the SOURCE of any rename)', async () => {
    await commit('add', [{ rel: 'src/old.ts', body: 'a\nb\nc\nd\ne\n' }]);
    const git = simpleGit(realTmpDir);
    await git.mv('src/old.ts', 'src/new.ts');
    await git.commit('rename old -> new');

    const result = await findRenames(realTmpDir, 'src/new.ts');
    expect(result).toBeNull();
  });

  it('returns null when the file was never renamed', async () => {
    await commit('add', [{ rel: 'src/stable.ts', body: 'export const a = 1;\n' }]);
    const result = await findRenames(realTmpDir, 'src/stable.ts');
    expect(result).toBeNull();
  });

  it('returns null on a non-git directory (raw throws, caught -> null)', async () => {
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-norepo-'));
    try {
      resetGit();
      const result = await findRenames(nonRepo, 'whatever.ts');
      expect(result).toBeNull();
    } finally {
      fs.rmSync(nonRepo, { recursive: true, force: true });
      resetGit();
    }
  });

  // The detection engine itself DOES work on the un-scoped log. We prove the
  // engine end-to-end by capturing the live output of the same `git log`
  // command findRenames builds (minus the pathspec) and running the real
  // parser over it. This is the "findRenames detects a real git mv and returns
  // oldPath/newPath/commitHash/daysAgo" assertion from the gap, exercised at
  // the git boundary against output the un-pathspec'd query genuinely returns.
  it('the parsing engine returns full RenameInfo for a real git mv (un-scoped log)', async () => {
    await commit('add', [{ rel: 'src/old.ts', body: 'a\nb\nc\nd\ne\n' }]);
    const git = simpleGit(realTmpDir);
    await git.mv('src/old.ts', 'src/new.ts');
    await git.commit('rename old -> new');

    const raw = await simpleGit(realTmpDir).raw(RENAME_LOG_ARGS);
    const info = parseRenameLog(raw);

    expect(info).not.toBeNull();
    const r = info as RenameInfo;
    expect(r.oldPath).toBe('src/old.ts');
    expect(r.newPath).toBe('src/new.ts');
    // 7-char short hash matching git's own short form.
    expect(r.commitHash).toMatch(/^[a-f0-9]{7}$/);
    const head = (await simpleGit(realTmpDir).revparse(['HEAD'])).trim();
    expect(head.startsWith(r.commitHash)).toBe(true);
    // Rename committed just now -> 0 whole days ago.
    expect(r.daysAgo).toBe(0);
  });

  it('finds a rename of a non-ASCII filename (raw UTF-8 paths, not quotePath octal escapes)', async () => {
    // Without `-c core.quotepath=false` git emits
    // R100\t"src/f\303\266\303\266.txt"\t"src/b\303\244r.txt" and neither
    // the exact match nor the basename fallback ever unquotes it.
    await commit('add unicode', [{ rel: 'src/föö.txt', body: 'a\nb\nc\nd\ne\n' }]);
    const git = simpleGit(realTmpDir);
    await git.mv('src/föö.txt', 'src/bär.txt');
    await git.commit('rename unicode');

    const result = await findRenames(realTmpDir, 'src/föö.txt');
    expect(result).not.toBeNull();
    const r = result as RenameInfo;
    expect(r.oldPath).toBe('src/föö.txt');
    expect(r.newPath).toBe('src/bär.txt');
  });

  // git log --name-status emits repo-ROOT-relative paths no matter where it
  // runs from, so findRenames must relativize its target into that
  // coordinate space; these pin the caller shapes that used to silently
  // return null (projectRoot below the repo root, absolute targets) and the
  // bare-filename fallback that relativization must not drop.
  it('finds a rename when projectRoot is a subdirectory of the git repo', async () => {
    await commit('add', [{ rel: 'pkg/src/old.ts', body: 'a\nb\nc\nd\ne\n' }]);
    const git = simpleGit(realTmpDir);
    await git.mv('pkg/src/old.ts', 'pkg/src/new.ts');
    await git.commit('rename old -> new');

    resetGit();
    const result = await findRenames(path.join(realTmpDir, 'pkg'), 'src/old.ts');
    expect(result).toMatchObject({
      oldPath: 'pkg/src/old.ts',
      newPath: 'pkg/src/new.ts',
    });
  });

  it('finds a rename for an absolute target inside the root (the validate_path input shape)', async () => {
    await commit('add', [{ rel: 'src/old.ts', body: 'a\nb\nc\nd\ne\n' }]);
    const git = simpleGit(realTmpDir);
    await git.mv('src/old.ts', 'src/new.ts');
    await git.commit('rename old -> new');

    const absolute = path.join(realTmpDir, 'src', 'old.ts');
    const result = await findRenames(realTmpDir, absolute);
    expect(result).toMatchObject({ oldPath: 'src/old.ts', newPath: 'src/new.ts' });
  });

  it('keeps the bare-filename basename fallback through findRenames', async () => {
    await commit('add', [{ rel: 'src/lib/old.ts', body: 'a\nb\nc\nd\ne\n' }]);
    const git = simpleGit(realTmpDir);
    await git.mv('src/lib/old.ts', 'src/lib/new.ts');
    await git.commit('rename old -> new');

    const result = await findRenames(realTmpDir, 'old.ts');
    expect(result).toMatchObject({ oldPath: 'src/lib/old.ts', newPath: 'src/lib/new.ts' });
  });

  it('keeps the bare-filename fallback when projectRoot is a repo subdirectory', async () => {
    // Relativization turns the bare `old.ts` into the pathed `pkg/old.ts`,
    // which matches nothing exactly; the retry with the caller's bare form
    // must still rescue it via the basename fallback.
    await commit('add', [{ rel: 'pkg/src/lib/old.ts', body: 'a\nb\nc\nd\ne\n' }]);
    const git = simpleGit(realTmpDir);
    await git.mv('pkg/src/lib/old.ts', 'pkg/src/lib/new.ts');
    await git.commit('rename old -> new');

    resetGit();
    const result = await findRenames(path.join(realTmpDir, 'pkg'), 'old.ts');
    expect(result).toMatchObject({
      oldPath: 'pkg/src/lib/old.ts',
      newPath: 'pkg/src/lib/new.ts',
    });
  });

  it('detects a rename with content modification (sub-100 similarity score)', async () => {
    // Enough lines that an edit in the same commit keeps similarity above
    // git's 50% rename-detection threshold while dropping it below 100.
    const body = `${Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n')}\n`;
    await commit('add', [{ rel: 'src/old.ts', body }]);
    const git = simpleGit(realTmpDir);
    await git.mv('src/old.ts', 'src/new.ts');
    fs.writeFileSync(path.join(realTmpDir, 'src/new.ts'), body.replace('line 9', 'line nine'));
    await git.add('src/new.ts');
    await git.commit('rename + edit');

    // Prove the fixture actually produced a sub-100 R row at the git
    // boundary (otherwise this would silently re-test the R100 path).
    const raw = await simpleGit(realTmpDir).raw(RENAME_LOG_ARGS);
    const scoreMatch = raw.match(/^R(\d+)\t/m);
    expect(scoreMatch).not.toBeNull();
    expect(Number(scoreMatch?.[1])).toBeGreaterThanOrEqual(50);
    expect(Number(scoreMatch?.[1])).toBeLessThan(100);

    const result = await findRenames(realTmpDir, 'src/old.ts');
    expect(result).toMatchObject({ oldPath: 'src/old.ts', newPath: 'src/new.ts' });
  });
});

// ---------------------------------------------------------------------------
// Gap 2: parseRenameLog parsing branches.
//
// These exercise the parser directly on raw-shaped strings. The single-rename
// fixtures use byte-shapes captured from live git output (see the probe in the
// integration test above): a 40-hex hash + ISO date + tz header, a blank line,
// then `R<score>\told\tnew`.
// ---------------------------------------------------------------------------
describe('parseRenameLog', () => {
  const HASH = '6912509b9e7c65de2352cb01564c2e6ed31cb6a5';

  it('returns null for empty / whitespace-only input', () => {
    expect(parseRenameLog('')).toBeNull();
    expect(parseRenameLog('   \n  \n')).toBeNull();
  });

  it('parses a single rename block into the first matching RenameInfo', () => {
    const raw = `${HASH} 2026-06-02T18:54:28-07:00\n\nR100\tsrc/old.ts\tsrc/new.ts\n`;
    const info = parseRenameLog(raw);
    expect(info).toEqual({
      oldPath: 'src/old.ts',
      newPath: 'src/new.ts',
      commitHash: '6912509', // first 7 of HASH
      daysAgo: expect.any(Number),
    });
    // Date in the header is in the past -> non-negative whole days.
    expect((info as RenameInfo).daysAgo).toBeGreaterThanOrEqual(0);
  });

  it('returns the FIRST R-entry when a single commit contains multiple renames', () => {
    // A real "git mv a a2 && git mv b b2 && commit" lands two R rows under one
    // header. The function returns on the first R row it can parse; the
    // commit-header tracking comment in parseRenameLog documents that
    // currentHash must survive past the first R row -- this asserts the first
    // row wins and carries the right hash.
    const raw =
      `${HASH} 2026-06-02T18:54:28-07:00\n\n` +
      `R100\tsrc/a.ts\tsrc/a2.ts\n` +
      `R100\tsrc/b.ts\tsrc/b2.ts\n`;
    const info = parseRenameLog(raw);
    expect(info).toMatchObject({
      oldPath: 'src/a.ts',
      newPath: 'src/a2.ts',
      commitHash: '6912509',
    });
  });

  it('keeps the correct commit hash on the SECOND R row when the first R row is malformed', () => {
    // Regression guard for parseRenameLog's header tracking: the header hash
    // must persist across R rows. A malformed (sub-3-part) first R row is
    // skipped; the second, valid R row must still report the header's hash,
    // not "unknown".
    const raw =
      `${HASH} 2026-06-02T18:54:28-07:00\n\n` +
      `Rbroken\n` + // malformed: split('\t') -> length 1, guarded out
      `R100\tsrc/b.ts\tsrc/b2.ts\n`;
    const info = parseRenameLog(raw);
    expect(info).toMatchObject({
      oldPath: 'src/b.ts',
      newPath: 'src/b2.ts',
      commitHash: '6912509',
    });
  });

  it('uses daysAgo = 0 when an R row appears before any commit header (currentDateStr undefined)', () => {
    // No header line precedes the R row, so currentDateStr stays undefined and
    // the daysAgo ternary in parseRenameLog takes the `: 0` fallback.
    // commitHash falls back to the literal "unknown" for the same reason.
    const raw = `R100\tsrc/old.ts\tsrc/new.ts\n`;
    const info = parseRenameLog(raw);
    expect(info).toEqual({
      oldPath: 'src/old.ts',
      newPath: 'src/new.ts',
      commitHash: 'unknown',
      daysAgo: 0,
    });
  });

  it('computes daysAgo from the header date when present', () => {
    // Header dated 10 days before "now"; floor of the whole-day delta is 10.
    // Mirror git's %aI shape: seconds precision, numeric offset, no millis.
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const iso = tenDaysAgo.toISOString().replace(/\.\d+Z$/, '+00:00');
    const raw = `${HASH} ${iso}\n\nR100\tsrc/old.ts\tsrc/new.ts\n`;
    const info = parseRenameLog(raw);
    expect((info as RenameInfo).daysAgo).toBe(10);
  });

  it('still parses the older space-separated %ai header shape', () => {
    // The header regex accepts `[T ]` after the date so a parser fed %ai
    // output (the pre-%aI format) keeps working.
    const raw = `${HASH} 2026-06-02 18:54:28 -0700\n\nR100\tsrc/old.ts\tsrc/new.ts\n`;
    const info = parseRenameLog(raw);
    expect(info).toMatchObject({ commitHash: '6912509' });
    expect(Number.isFinite((info as RenameInfo).daysAgo)).toBe(true);
    expect((info as RenameInfo).daysAgo).toBeGreaterThanOrEqual(0);
  });

  it('skips a malformed R line (fewer than 3 tab-parts) and returns null when no valid R follows', () => {
    const raw = `${HASH} 2026-06-02T18:54:28-07:00\n\n` + `R100\tsrc/only-one-path.ts\n`; // 2 parts -> length < 3 -> guarded out
    expect(parseRenameLog(raw)).toBeNull();
  });

  it('ignores lines that are neither a commit header nor an R row', () => {
    const raw =
      `${HASH} 2026-06-02T18:54:28-07:00\n\n` +
      `M\tsrc/modified.ts\n` + // not a rename
      `A\tsrc/added.ts\n` +
      `R100\tsrc/old.ts\tsrc/new.ts\n`;
    const info = parseRenameLog(raw);
    expect(info).toMatchObject({ oldPath: 'src/old.ts', newPath: 'src/new.ts' });
  });

  it('does not misdetect a non-rename line of "hex + whitespace + non-date" as a commit header', () => {
    // `deadbee somefile.ts` starts with 7 hex chars + a space but is NOT the
    // shipped `%H %ai` header shape (no year-leading ISO date). The loose
    // `/^([a-f0-9]{7,40})\s+(.+)$/` regex matched it, overwriting currentHash
    // with `deadbee` and currentDateStr with `somefile.ts` (then NaN daysAgo).
    // The tightened regex must skip it so the real header's hash + date win.
    const raw =
      `${HASH} 2026-06-02T18:54:28-07:00\n\n` +
      `deadbee somefile.ts\n` + // hex + space + non-date -> must NOT be a header
      `R100\tsrc/old.ts\tsrc/new.ts\n`;
    const info = parseRenameLog(raw);
    expect(info).toMatchObject({
      oldPath: 'src/old.ts',
      newPath: 'src/new.ts',
      commitHash: '6912509', // header hash survived, not "deadbee"
    });
    // daysAgo is a finite whole number computed from the real header date,
    // never NaN (which it would be if `somefile.ts` had become currentDateStr).
    expect(Number.isFinite((info as RenameInfo).daysAgo)).toBe(true);
  });

  // targetPath matching: findRenames scans an unscoped log and asks the parser
  // to return the rename whose SOURCE path equals the queried ref.
  it('with a targetPath, returns the rename whose old path matches (not just the first)', () => {
    const raw =
      `${HASH} 2026-06-02T18:54:28-07:00\n\n` +
      `R100\tsrc/a.ts\tsrc/a2.ts\n` +
      `R100\tsrc/b.ts\tsrc/b2.ts\n`;
    expect(parseRenameLog(raw, 'src/b.ts')).toMatchObject({
      oldPath: 'src/b.ts',
      newPath: 'src/b2.ts',
    });
  });

  it('normalizes ./ and backslashes when matching the targetPath', () => {
    const raw = `${HASH} 2026-06-02T18:54:28-07:00\n\nR100\tsrc/old.ts\tsrc/new.ts\n`;
    expect(parseRenameLog(raw, './src/old.ts')).toMatchObject({ newPath: 'src/new.ts' });
    expect(parseRenameLog(raw, 'src\\old.ts')).toMatchObject({ newPath: 'src/new.ts' });
  });

  it('falls back to a basename match when no source path matches exactly', () => {
    const raw = `${HASH} 2026-06-02T18:54:28-07:00\n\nR100\tsrc/lib/old.ts\tsrc/lib/new.ts\n`;
    // doc referenced a bare filename; repo tracks a nested path
    expect(parseRenameLog(raw, 'old.ts')).toMatchObject({ newPath: 'src/lib/new.ts' });
  });

  it('returns null with a targetPath that matches no rename source or basename', () => {
    const raw = `${HASH} 2026-06-02T18:54:28-07:00\n\nR100\tsrc/old.ts\tsrc/new.ts\n`;
    expect(parseRenameLog(raw, 'src/unrelated.ts')).toBeNull();
  });

  // The basename fallback feeds an autofix (paths.ts turns newPath into a
  // fix the fixer writes into the user's doc), so the next three pin its
  // conservative contract: bare-filename targets only, unique source only.
  it('returns null for an ambiguous bare-filename target (two renames with different sources share the basename)', () => {
    const raw =
      `${HASH} 2026-06-02T18:54:28-07:00\n\n` +
      `R100\tpackages/web/index.md\tpackages/site/index.md\n` +
      `R100\tdocs/setup/index.md\tdocs/install/index.md\n`;
    expect(parseRenameLog(raw, 'index.md')).toBeNull();
  });

  it('keeps the newest row when the SAME source matches multiple fallback rows', () => {
    // A file renamed away, recreated, and renamed away again produces two R
    // rows with the same source; the first row in the log (newest commit)
    // is the rename the doc's stale ref points at.
    const raw =
      `${HASH} 2026-06-02T18:54:28-07:00\n\n` +
      `R100\tsrc/lib/old.ts\tsrc/lib/newer.ts\n` +
      `R100\tsrc/lib/old.ts\tsrc/lib/earlier.ts\n`;
    expect(parseRenameLog(raw, 'old.ts')).toMatchObject({ newPath: 'src/lib/newer.ts' });
  });

  // Windows filesystems are case-insensitive: a dir-case-mismatched doc ref
  // (SRC/old.ts for git's src/old.ts) resolves on disk, counts commits in
  // staleness (normalizePath folds), and must match the rename source too --
  // the comparison folds on win32 while RenameInfo keeps git's raw casing.
  it.runIf(process.platform === 'win32')(
    'matches a dir-case-mismatched target on win32, returning git raw casing',
    () => {
      const raw = `${HASH} 2026-06-02T18:54:28-07:00\n\nR100\tsrc/old.ts\tsrc/new.ts\n`;
      expect(parseRenameLog(raw, 'SRC/old.ts')).toMatchObject({
        oldPath: 'src/old.ts',
        newPath: 'src/new.ts',
      });
    },
  );

  it.runIf(process.platform !== 'win32')(
    'does not fold case on POSIX (case-sensitive filesystems; folding would invent matches)',
    () => {
      const raw = `${HASH} 2026-06-02T18:54:28-07:00\n\nR100\tsrc/old.ts\tsrc/new.ts\n`;
      expect(parseRenameLog(raw, 'SRC/old.ts')).toBeNull();
    },
  );

  it('does not basename-fall-back for a pathed target that matches no source exactly', () => {
    // `docs/index.md` referencing a never-renamed file must not match an
    // unrelated `packages/web/index.md` rename. Same for a `../` ref, which
    // can never exact-match git's repo-relative output.
    const raw =
      `${HASH} 2026-06-02T18:54:28-07:00\n\n` +
      `R100\tpackages/web/index.md\tpackages/site/index.md\n`;
    expect(parseRenameLog(raw, 'docs/index.md')).toBeNull();
    expect(parseRenameLog(raw, '../packages/web/index.md')).toBeNull();
  });
});
