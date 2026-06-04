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
  'log',
  '--diff-filter=R',
  '--find-renames',
  '--name-status',
  '--format=%H %ai',
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
    const raw = `${HASH} 2026-06-02 18:54:28 -0700\n\nR100\tsrc/old.ts\tsrc/new.ts\n`;
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
    // header. The function returns on the first R row it can parse; the comment
    // at git.ts:213-216 documents that currentHash must survive past the first
    // R row -- this asserts the first row wins and carries the right hash.
    const raw =
      `${HASH} 2026-06-02 18:54:28 -0700\n\n` +
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
    // Regression guard for git.ts:213-216: the header hash must persist across
    // R rows. A malformed (sub-3-part) first R row is skipped; the second,
    // valid R row must still report the header's hash, not "unknown".
    const raw =
      `${HASH} 2026-06-02 18:54:28 -0700\n\n` +
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
    // the branch at git.ts:231-233 takes the `: 0` fallback. commitHash falls
    // back to the literal "unknown" for the same reason.
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
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const iso = tenDaysAgo.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' +0000');
    const raw = `${HASH} ${iso}\n\nR100\tsrc/old.ts\tsrc/new.ts\n`;
    const info = parseRenameLog(raw);
    expect((info as RenameInfo).daysAgo).toBe(10);
  });

  it('skips a malformed R line (fewer than 3 tab-parts) and returns null when no valid R follows', () => {
    const raw =
      `${HASH} 2026-06-02 18:54:28 -0700\n\n` +
      `R100\tsrc/only-one-path.ts\n`; // 2 parts -> length < 3 -> guarded out
    expect(parseRenameLog(raw)).toBeNull();
  });

  it('ignores lines that are neither a commit header nor an R row', () => {
    const raw =
      `${HASH} 2026-06-02 18:54:28 -0700\n\n` +
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
      `${HASH} 2026-06-02 18:54:28 -0700\n\n` +
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
      `${HASH} 2026-06-02 18:54:28 -0700\n\n` +
      `R100\tsrc/a.ts\tsrc/a2.ts\n` +
      `R100\tsrc/b.ts\tsrc/b2.ts\n`;
    expect(parseRenameLog(raw, 'src/b.ts')).toMatchObject({
      oldPath: 'src/b.ts',
      newPath: 'src/b2.ts',
    });
  });

  it('normalizes ./ and backslashes when matching the targetPath', () => {
    const raw = `${HASH} 2026-06-02 18:54:28 -0700\n\nR100\tsrc/old.ts\tsrc/new.ts\n`;
    expect(parseRenameLog(raw, './src/old.ts')).toMatchObject({ newPath: 'src/new.ts' });
    expect(parseRenameLog(raw, 'src\\old.ts')).toMatchObject({ newPath: 'src/new.ts' });
  });

  it('falls back to a basename match when no source path matches exactly', () => {
    const raw = `${HASH} 2026-06-02 18:54:28 -0700\n\nR100\tsrc/lib/old.ts\tsrc/lib/new.ts\n`;
    // doc referenced a bare filename; repo tracks a nested path
    expect(parseRenameLog(raw, 'old.ts')).toMatchObject({ newPath: 'src/lib/new.ts' });
  });

  it('returns null with a targetPath that matches no rename source or basename', () => {
    const raw = `${HASH} 2026-06-02 18:54:28 -0700\n\nR100\tsrc/old.ts\tsrc/new.ts\n`;
    expect(parseRenameLog(raw, 'src/unrelated.ts')).toBeNull();
  });
});
