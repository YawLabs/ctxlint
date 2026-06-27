import { vi, describe, it, expect, beforeEach } from 'vitest';

// Mock simple-git so we can assert the exact args getCommitsSinceBatch hands to
// `git log`. The real-git integration suite (git.test.ts) proves the COUNTS are
// correct across path shapes; this file proves the server-side `--` pathspec
// filter is actually applied, and that repo-escaping / glob refs are excluded
// from it (a raw `-- ../escape.ts` would error and zero the whole batch).
const { rawMock } = vi.hoisted(() => ({ rawMock: vi.fn() }));

vi.mock('simple-git', () => ({
  default: vi.fn(() => ({ raw: rawMock })),
}));

import { getCommitsSinceBatch, resetGit } from '../git.js';

const PROJECT = process.platform === 'win32' ? 'C:\\proj' : '/proj';
// On win32 the helper prefixes pathspecs with :(icase) magic; strip it so the
// assertions read identically on every platform.
const despec = (s: string) => s.replace(/^:\(icase\)/, '');

function pathspecArgs(): string[] {
  const args = rawMock.mock.calls[0][0] as string[];
  const sep = args.indexOf('--');
  return sep === -1 ? [] : args.slice(sep + 1).map(despec);
}

beforeEach(() => {
  rawMock.mockReset();
  rawMock.mockResolvedValue('');
  resetGit();
});

describe('getCommitsSinceBatch server-side pathspec filter', () => {
  it('passes requested paths as -- positional pathspec args to git log', async () => {
    await getCommitsSinceBatch(PROJECT, ['src/foo.ts', 'docs/bar.md'], new Date(0));
    expect(rawMock).toHaveBeenCalledOnce();
    const args = rawMock.mock.calls[0][0] as string[];
    expect(args.indexOf('--')).toBeGreaterThan(-1);
    expect(pathspecArgs()).toEqual(['src/foo.ts', 'docs/bar.md']);
  });

  it('excludes a repo-escaping ../ ref from the pathspec', async () => {
    await getCommitsSinceBatch(PROJECT, ['src/foo.ts', '../shared/x.ts'], new Date(0));
    expect(pathspecArgs()).toEqual(['src/foo.ts']);
  });

  it('excludes a glob ref from the pathspec (matched literally in-process instead)', async () => {
    await getCommitsSinceBatch(PROJECT, ['src/foo.ts', 'src/*.ts'], new Date(0));
    expect(pathspecArgs()).toEqual(['src/foo.ts']);
  });

  it('omits the -- separator entirely when no path is server-filterable', async () => {
    await getCommitsSinceBatch(PROJECT, ['../escape.ts', 'src/*.ts'], new Date(0));
    expect(rawMock).toHaveBeenCalledOnce();
    expect((rawMock.mock.calls[0][0] as string[]).includes('--')).toBe(false);
  });

  it('does not invoke git for an empty paths array', async () => {
    const out = await getCommitsSinceBatch(PROJECT, [], new Date(0));
    expect(out.size).toBe(0);
    expect(rawMock).not.toHaveBeenCalled();
  });

  it('returns zero counts and does not throw when git.raw rejects', async () => {
    rawMock.mockReset();
    rawMock.mockRejectedValueOnce(new Error('git failed'));
    const out = await getCommitsSinceBatch(PROJECT, ['src/foo.ts', 'docs/bar.md'], new Date(0));
    expect(out.get('src/foo.ts')).toBe(0);
    expect(out.get('docs/bar.md')).toBe(0);
  });

  it('excludes an absolute path outside the project root from the pathspec', async () => {
    const absOutside = process.platform === 'win32' ? 'C:\\other\\x.ts' : '/etc/passwd';
    await getCommitsSinceBatch(PROJECT, ['src/foo.ts', absOutside], new Date(0));
    expect(pathspecArgs()).toEqual(['src/foo.ts']);
  });
});
