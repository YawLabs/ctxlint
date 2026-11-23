import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkDivergedFile, resetDivergedFileCache } from '../diverged-file.js';
import type { SessionContext, SiblingRepo } from '../../../types.js';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  stat: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

// The current project's GitHub owner comes from its git remote; stub it so
// each case states the owner it means instead of spawning git.
vi.mock('../../../sibling-org.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../sibling-org.js')>()),
  currentGitOrg: vi.fn(async () => undefined),
}));

import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { currentGitOrg } from '../../../sibling-org.js';

const mockReadFile = vi.mocked(readFile);
const mockStat = vi.mocked(stat);
const mockExistsSync = vi.mocked(existsSync);
const mockCurrentGitOrg = vi.mocked(currentGitOrg);

/**
 * Serve `content` for one canonical file and identical text for every other,
 * so a case's finding count is the number of files it meant to diverge --
 * a mock returning the same diverged text for all eight files would make
 * every canonical file fire at once and hide a count regression.
 */
function onlyFile(
  fileName: string,
  byRepo: Record<string, string>,
): (p: unknown) => Promise<string> {
  return async (p) => {
    const ps = String(p).replace(/\\/g, '/');
    if (!ps.endsWith(`/${fileName}`)) return 'identical line one\nidentical line two\n';
    for (const [repo, content] of Object.entries(byRepo)) {
      if (ps.includes(`/repos/${repo}/`)) return content;
    }
    return '';
  };
}

function makeSibling(name: string, basePath = '/repos'): SiblingRepo {
  return { path: `${basePath}/${name}`, name };
}

function makeCtx(siblings: SiblingRepo[], currentProject = '/repos/current'): SessionContext {
  return { history: [], memories: [], siblings, currentProject, providers: ['claude-code'] };
}

beforeEach(() => {
  vi.resetAllMocks();
  // Clear the module-scope (mtime,size)->lineSet cache so each test starts
  // with a clean slate. Without this, a stat result from one test would
  // satisfy the cache lookup in the next.
  resetDivergedFileCache();
  mockCurrentGitOrg.mockResolvedValue(undefined);
  // Default stat: files have stable mtime/size keyed by path so the cache
  // hits behave deterministically. Tests that want to simulate "file
  // changed" can override mockStat per-call.
  mockStat.mockImplementation(async (p) => {
    const ps = String(p);
    return {
      mtimeMs: 1000,
      size: ps.length,
    } as unknown as Awaited<ReturnType<typeof stat>>;
  });
});

describe('checkDivergedFile', () => {
  it('returns no issues when current project has no canonical files', async () => {
    mockExistsSync.mockReturnValue(false);

    const ctx = makeCtx([makeSibling('foo')]);
    const issues = await checkDivergedFile(ctx);
    expect(issues).toHaveLength(0);
  });

  it('returns no issues when sibling has no matching files', async () => {
    mockExistsSync.mockImplementation((p) => {
      const ps = String(p).replace(/\\/g, '/');
      return ps.includes('/repos/current/');
    });
    mockReadFile.mockResolvedValue('line 1\nline 2\nline 3\n');

    const ctx = makeCtx([makeSibling('foo')]);
    const issues = await checkDivergedFile(ctx);
    expect(issues).toHaveLength(0);
  });

  it('flags files with 20-90% overlap as diverged', async () => {
    // Both exist
    mockExistsSync.mockReturnValue(true);

    const currentContent =
      'line one is shared\nline two is shared\nline three is unique to current\nline four also unique\n';
    const sibContent =
      'line one is shared\nline two is shared\nline three differs in sib\nline four also differs\n';

    mockReadFile.mockImplementation(
      onlyFile('release.sh', { current: currentContent, foo: sibContent }),
    );

    const ctx = makeCtx([makeSibling('foo')]);
    const issues = await checkDivergedFile(ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('release.sh');
    expect(issues[0].check).toBe('session-diverged-file');
    expect(issues[0].severity).toBe('warning');
    // detail carries navigable absolute paths for both the current file and
    // the diverged sibling (message itself is basename-only).
    expect(issues[0].detail).toContain('File:');
    expect(issues[0].detail).toMatch(/repos[\\/]current[\\/]/);
    expect(issues[0].detail).toMatch(/repos[\\/]foo[\\/]/);
  });

  it('lists diverged siblings lowest-overlap first', async () => {
    mockExistsSync.mockReturnValue(true);

    // current vs hi: 3 shared of (4 + 5 - 3) unique lines = 50% overlap.
    // current vs lo: 2 shared of (4 + 6 - 2) unique lines = 25% overlap.
    const currentContent = [
      'shared alpha line',
      'shared beta line',
      'shared gamma line',
      'current only delta',
    ].join('\n');
    const hiContent = [
      'shared alpha line',
      'shared beta line',
      'shared gamma line',
      'hi only epsilon line',
      'hi only zeta line',
    ].join('\n');
    const loContent = [
      'shared alpha line',
      'shared beta line',
      'lo only one line',
      'lo only two line',
      'lo only three line',
      'lo only four line',
    ].join('\n');

    mockReadFile.mockImplementation(
      onlyFile('release.sh', { current: currentContent, hi: hiContent, lo: loContent }),
    );

    // The higher-overlap sibling iterates FIRST; the report must still lead
    // with the lowest-overlap (most-drifted) sibling.
    const ctx = makeCtx([makeSibling('hi'), makeSibling('lo')]);
    const issues = await checkDivergedFile(ctx);
    expect(issues).toHaveLength(1);
    const msg = issues[0].message;
    expect(msg).toContain('lo (25% overlap)');
    expect(msg).toContain('hi (50% overlap)');
    expect(msg.indexOf('lo (25% overlap)')).toBeLessThan(msg.indexOf('hi (50% overlap)'));
  });

  it('does not flag files with >90% overlap (close enough)', async () => {
    mockExistsSync.mockReturnValue(true);

    const content =
      'line one shared content here\nline two shared content here\nline three shared content here\nline four shared content here\nline five shared content here\n';

    mockReadFile.mockResolvedValue(content);

    const ctx = makeCtx([makeSibling('foo')]);
    const issues = await checkDivergedFile(ctx);
    expect(issues).toHaveLength(0);
  });

  it('does not flag files with <20% overlap (intentionally different)', async () => {
    mockExistsSync.mockReturnValue(true);

    const currentContent =
      'aaaa unique line one\nbbbb unique line two\ncccc unique line three\ndddd unique line four\neeee unique line five\n';
    const sibContent =
      'xxxx different line one\nyyyy different line two\nzzzz different line three\nwwww different line four\nvvvv different line five\n';

    mockReadFile.mockImplementation(async (p) => {
      const ps = String(p).replace(/\\/g, '/');
      if (ps.includes('/repos/current/')) return currentContent;
      return sibContent;
    });

    const ctx = makeCtx([makeSibling('foo')]);
    const issues = await checkDivergedFile(ctx);
    expect(issues).toHaveLength(0);
  });

  it('returns no issues with no siblings', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue('content here\n');

    const ctx = makeCtx([]);
    const issues = await checkDivergedFile(ctx);
    expect(issues).toHaveLength(0);
  });

  it('caches tokenized line-sets across audits keyed by (path, mtime, size)', async () => {
    // Two consecutive audits should hit the cache on the second pass — we
    // count readFile calls and assert the second audit makes none.
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue('shared line one\nshared line two\nshared line three\n');

    const ctx = makeCtx([makeSibling('foo')]);

    await checkDivergedFile(ctx);
    const firstPassReads = mockReadFile.mock.calls.length;
    expect(firstPassReads).toBeGreaterThan(0);

    await checkDivergedFile(ctx);
    expect(mockReadFile.mock.calls.length).toBe(firstPassReads);
  });

  it('evicts the oldest entry once the cache exceeds its cap', async () => {
    // Drive the LRU past its 256-entry cap by simulating many distinct
    // sibling paths. The first sibling read should fall out once enough
    // newer entries have been admitted, forcing a re-read on a subsequent
    // audit even though its mtime+size are unchanged.
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue('shared line one\nshared line two\nshared line three\n');

    // Build 270 unique siblings -- with 8 canonical files per pass, that's
    // 8 + 8*270 = 2168 paths the cache will see. The current-project file
    // is read once per canonical filename (8 reads); each sibling adds 8.
    // Exceeds the 256 cap by a comfortable margin.
    const manySiblings = Array.from({ length: 270 }, (_, i) => makeSibling(`s${i}`));
    const ctx = makeCtx(manySiblings);

    await checkDivergedFile(ctx);
    const baselineReads = mockReadFile.mock.calls.length;
    expect(baselineReads).toBeGreaterThan(0);

    // Re-running with just the FIRST sibling: its 8 canonical-file entries
    // were the oldest cache inserts and should have been evicted by the
    // 270 newer siblings, so we expect the cache to miss and re-read them
    // (plus the current project's own files, which were inserted earliest
    // of all and are also evicted). If the cache had no eviction, this
    // second call would issue zero readFile calls.
    const trimmedCtx = makeCtx([manySiblings[0]]);
    await checkDivergedFile(trimmedCtx);
    expect(mockReadFile.mock.calls.length).toBeGreaterThan(baselineReads);
  });

  it('invalidates the cache when mtime changes (file edited between audits)', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue('shared line one\nshared line two\nshared line three\n');

    const ctx = makeCtx([makeSibling('foo')]);

    await checkDivergedFile(ctx);
    const firstPassReads = mockReadFile.mock.calls.length;

    // Bump every file's mtime — cache entries are stale, every path must be
    // re-read and re-tokenized.
    mockStat.mockImplementation(async (p) => {
      const ps = String(p);
      return {
        mtimeMs: 9999,
        size: ps.length,
      } as unknown as Awaited<ReturnType<typeof stat>>;
    });

    await checkDivergedFile(ctx);
    expect(mockReadFile.mock.calls.length).toBeGreaterThan(firstPassReads);
  });

  const shared = ['shared alpha line', 'shared beta line', 'shared gamma line'];

  it('compares only against siblings under the same GitHub owner', async () => {
    mockExistsSync.mockReturnValue(true);
    mockCurrentGitOrg.mockResolvedValue('acme');
    const current = [...shared, 'current only delta'].join('\n');
    const drifted = [...shared, 'sib only epsilon line', 'sib only zeta line'].join('\n');
    mockReadFile.mockImplementation(
      onlyFile('release.sh', { current, mine: drifted, theirs: drifted }),
    );

    const ctx = makeCtx([
      { path: '/repos/mine', name: 'mine', gitOrg: 'acme' },
      { path: '/repos/theirs', name: 'theirs', gitOrg: 'someone-else' },
    ]);
    const issues = await checkDivergedFile(ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('mine');
    expect(issues[0].message).not.toContain('theirs');
  });

  it('holds boilerplate files (.gitignore, tsconfig.json) to a higher overlap bar', async () => {
    mockExistsSync.mockReturnValue(true);
    // 2 shared of 8 distinct lines = 25%: drift for release.sh, but two
    // unrelated repos' .gitignore files overlap that much by default.
    const current = [
      'node_modules line',
      'dist output line',
      'cur a line',
      'cur b line',
      'cur c line',
    ].join('\n');
    const sib = [
      'node_modules line',
      'dist output line',
      'sib a line',
      'sib b line',
      'sib c line',
    ].join('\n');
    mockReadFile.mockImplementation(onlyFile('.gitignore', { current, foo: sib }));
    expect(await checkDivergedFile(makeCtx([makeSibling('foo')]))).toHaveLength(0);

    resetDivergedFileCache();
    // 4 shared of 6 distinct lines = 67%: still flagged.
    const close = ['node_modules line', 'dist output line', 'coverage line', 'env file line'];
    mockReadFile.mockImplementation(
      onlyFile('.gitignore', {
        current: [...close, 'cur a line'].join('\n'),
        foo: [...close, 'sib a line'].join('\n'),
      }),
    );
    const issues = await checkDivergedFile(makeCtx([makeSibling('foo')]));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('.gitignore');
  });
});
