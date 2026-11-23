import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkStaleness } from '../staleness.js';
import type { ParsedContextFile } from '../../types.js';

// Mock git utilities
// (Real-git coverage of the same check lives in staleness.git.test.ts.)
vi.mock('../../../utils/git.js', () => ({
  isGitRepo: vi.fn(),
  isShallowRepo: vi.fn(),
  getFileLastCommit: vi.fn(),
  getCommitActivity: vi.fn(),
}));

import {
  isGitRepo,
  isShallowRepo,
  getFileLastCommit,
  getCommitActivity,
  type CommitActivity,
} from '../../../utils/git.js';

const mockedIsGitRepo = vi.mocked(isGitRepo);
const mockedIsShallowRepo = vi.mocked(isShallowRepo);
const mockedGetFileLastCommit = vi.mocked(getFileLastCommit);
const mockedGetCommitActivity = vi.mocked(getCommitActivity);

const DOC_HASH = 'abc1234abc1234abc1234abc1234abc1234abc12';

function commitAt(date: Date) {
  return { hash: DOC_HASH, date };
}

/** Per-path counts; distinctCommits defaults to their sum (no shared commits). */
function activity(
  requested: string[],
  counts: Record<string, number> = {},
  distinct?: number,
): CommitActivity {
  const perPath = new Map<string, number>();
  let sum = 0;
  for (const p of requested) {
    perPath.set(p, counts[p] ?? 0);
    sum += counts[p] ?? 0;
  }
  return { perPath, distinctCommits: distinct ?? sum };
}

function makeParsedFile(overrides?: Partial<ParsedContextFile>): ParsedContextFile {
  return {
    filePath: '/project/CLAUDE.md',
    relativePath: 'CLAUDE.md',
    isSymlink: false,
    totalTokens: 100,
    totalLines: 10,
    content: '',
    sections: [],
    references: {
      paths: [
        { value: 'src/index.ts', line: 3, column: 1 },
        { value: 'src/utils/helper.ts', line: 5, column: 1 },
      ],
      commands: [],
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockedIsShallowRepo.mockResolvedValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('checkStaleness', () => {
  it('returns no issues for non-git repos', async () => {
    mockedIsGitRepo.mockResolvedValue(false);
    const issues = await checkStaleness(makeParsedFile(), '/project');
    expect(issues).toHaveLength(0);
  });

  it('returns no issues in a shallow clone without consulting history', async () => {
    mockedIsGitRepo.mockResolvedValue(true);
    mockedIsShallowRepo.mockResolvedValue(true);
    mockedGetFileLastCommit.mockResolvedValue(commitAt(new Date(Date.now() - 45 * 86400000)));
    const issues = await checkStaleness(makeParsedFile(), '/project');
    expect(issues).toHaveLength(0);
    expect(mockedGetFileLastCommit).not.toHaveBeenCalled();
  });

  it('reports distinct commits (not the per-path sum) in the detail', async () => {
    mockedIsGitRepo.mockResolvedValue(true);
    mockedGetFileLastCommit.mockResolvedValue(commitAt(new Date(Date.now() - 45 * 86400000)));
    mockedGetCommitActivity.mockImplementation(async (_root, paths) =>
      activity(paths, { 'src/index.ts': 1, 'src/utils/helper.ts': 1 }, 1),
    );
    const issues = await checkStaleness(makeParsedFile(), '/project');
    expect(issues[0].detail).toBe('1 total commit to referenced paths since last update.');
  });

  it('returns no issues when file last modified date is unknown', async () => {
    mockedIsGitRepo.mockResolvedValue(true);
    mockedGetFileLastCommit.mockResolvedValue(null);
    const issues = await checkStaleness(makeParsedFile(), '/project');
    expect(issues).toHaveLength(0);
  });

  it('returns no issues when file was recently updated (< 14 days)', async () => {
    mockedIsGitRepo.mockResolvedValue(true);
    mockedGetFileLastCommit.mockResolvedValue(
      commitAt(new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)),
    );
    const issues = await checkStaleness(makeParsedFile(), '/project');
    expect(issues).toHaveLength(0);
  });

  it('returns no issues when referenced paths have no commits since', async () => {
    mockedIsGitRepo.mockResolvedValue(true);
    mockedGetFileLastCommit.mockResolvedValue(
      commitAt(new Date(Date.now() - 20 * 24 * 60 * 60 * 1000)),
    );
    mockedGetCommitActivity.mockImplementation(async (_root, paths) => activity(paths));
    const issues = await checkStaleness(makeParsedFile(), '/project');
    expect(issues).toHaveLength(0);
  });

  it('returns info severity for 14-30 day old file with changed paths', async () => {
    mockedIsGitRepo.mockResolvedValue(true);
    mockedGetFileLastCommit.mockResolvedValue(
      commitAt(new Date(Date.now() - 20 * 24 * 60 * 60 * 1000)),
    );
    mockedGetCommitActivity.mockImplementation(async (_root, paths) =>
      activity(paths, { 'src/index.ts': 3 }),
    );
    const issues = await checkStaleness(makeParsedFile(), '/project');
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('info');
    expect(issues[0].check).toBe('staleness');
    expect(issues[0].message).toContain('20 days ago');
  });

  it('returns warning severity for 30+ day old file with changed paths', async () => {
    mockedIsGitRepo.mockResolvedValue(true);
    mockedGetFileLastCommit.mockResolvedValue(
      commitAt(new Date(Date.now() - 45 * 24 * 60 * 60 * 1000)),
    );
    mockedGetCommitActivity.mockImplementation(async (_root, paths) =>
      activity(paths, { 'src/index.ts': 8 }),
    );
    const issues = await checkStaleness(makeParsedFile(), '/project');
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].message).toContain('45 days ago');
  });

  it('reports the most active path in the message', async () => {
    mockedIsGitRepo.mockResolvedValue(true);
    mockedGetFileLastCommit.mockResolvedValue(
      commitAt(new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)),
    );
    mockedGetCommitActivity.mockImplementation(async (_root, paths) =>
      activity(paths, { 'src/index.ts': 2, 'src/utils/helper.ts': 10 }),
    );
    const issues = await checkStaleness(makeParsedFile(), '/project');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('src/utils/helper.ts');
    expect(issues[0].message).toContain('10 commits');
  });

  it('handles file with no path references', async () => {
    mockedIsGitRepo.mockResolvedValue(true);
    mockedGetFileLastCommit.mockResolvedValue(
      commitAt(new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)),
    );
    const file = makeParsedFile({ references: { paths: [], commands: [] } });
    const issues = await checkStaleness(file, '/project');
    expect(issues).toHaveLength(0);
  });

  it('handles invalid date gracefully', async () => {
    mockedIsGitRepo.mockResolvedValue(true);
    mockedGetFileLastCommit.mockResolvedValue(commitAt(new Date('invalid')));
    const issues = await checkStaleness(makeParsedFile(), '/project');
    expect(issues).toHaveLength(0);
  });

  // getCommitsSinceBatch matches exact paths / dir prefixes only (no glob
  // support), so staleness must convert glob refs before the batch call --
  // otherwise a file whose only refs are globs can never go stale.
  it('converts a glob ref to its static directory prefix for the batch call', async () => {
    mockedIsGitRepo.mockResolvedValue(true);
    mockedGetFileLastCommit.mockResolvedValue(
      commitAt(new Date(Date.now() - 45 * 24 * 60 * 60 * 1000)),
    );
    mockedGetCommitActivity.mockImplementation(async (_root, paths) =>
      activity(paths, { 'src/': 4 }),
    );
    const file = makeParsedFile({
      references: { paths: [{ value: 'src/**/*.ts', line: 3, column: 1 }], commands: [] },
    });
    const issues = await checkStaleness(file, '/project');

    expect(mockedGetCommitActivity).toHaveBeenCalledWith('/project', ['src/'], {
      commit: DOC_HASH,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    // The message must cite the glob the user wrote, not the synthesized
    // `src/` counting key (a string that appears nowhere in the doc).
    expect(issues[0].message).toContain('src/**/*.ts');
  });

  it('names the original glob in the message when several globs collapse to one prefix', async () => {
    mockedIsGitRepo.mockResolvedValue(true);
    mockedGetFileLastCommit.mockResolvedValue(
      commitAt(new Date(Date.now() - 45 * 24 * 60 * 60 * 1000)),
    );
    mockedGetCommitActivity.mockImplementation(async (_root, paths) =>
      activity(paths, { 'src/': 7 }),
    );
    const file = makeParsedFile({
      references: {
        paths: [
          { value: 'src/**/*.ts', line: 3, column: 1 },
          { value: 'src/**/*.test.ts', line: 4, column: 1 },
        ],
        commands: [],
      },
    });
    const issues = await checkStaleness(file, '/project');

    // Both globs share the `src/` counting key; the first one encountered
    // labels the message.
    expect(mockedGetCommitActivity).toHaveBeenCalledWith('/project', ['src/'], {
      commit: DOC_HASH,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('src/**/*.ts has 7 commits since');
  });

  // A glob whose only static segment is `.` (./**, ./**/*.ts) would
  // synthesize the key `./`, which git's root-relative output never matches
  // -- the silent zero the glob-prefix branch exists to fix. It carries no
  // directory information, so it is skipped like a prefix-less `**`.
  it('skips a ./-prefixed glob with no further static segment', async () => {
    mockedIsGitRepo.mockResolvedValue(true);
    mockedGetFileLastCommit.mockResolvedValue(
      commitAt(new Date(Date.now() - 45 * 24 * 60 * 60 * 1000)),
    );
    const file = makeParsedFile({
      references: {
        paths: [
          { value: './**/*.ts', line: 3, column: 1 },
          { value: './**', line: 4, column: 1 },
        ],
        commands: [],
      },
    });
    const issues = await checkStaleness(file, '/project');

    expect(mockedGetCommitActivity).not.toHaveBeenCalled();
    expect(issues).toHaveLength(0);
  });

  it('drops the leading ./ from a ./-prefixed glob with a real static prefix', async () => {
    mockedIsGitRepo.mockResolvedValue(true);
    mockedGetFileLastCommit.mockResolvedValue(
      commitAt(new Date(Date.now() - 45 * 24 * 60 * 60 * 1000)),
    );
    mockedGetCommitActivity.mockImplementation(async (_root, paths) =>
      activity(paths, { 'src/': 4 }),
    );
    const file = makeParsedFile({
      references: { paths: [{ value: './src/**/*.ts', line: 3, column: 1 }], commands: [] },
    });
    const issues = await checkStaleness(file, '/project');

    // Counting key is the bare `src/` (not `./src/`); the message still
    // cites the ref as written.
    expect(mockedGetCommitActivity).toHaveBeenCalledWith('/project', ['src/'], {
      commit: DOC_HASH,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('./src/**/*.ts');
  });

  it('skips a glob with no static directory prefix', async () => {
    mockedIsGitRepo.mockResolvedValue(true);
    mockedGetFileLastCommit.mockResolvedValue(
      commitAt(new Date(Date.now() - 45 * 24 * 60 * 60 * 1000)),
    );
    const file = makeParsedFile({
      references: { paths: [{ value: '*.md', line: 3, column: 1 }], commands: [] },
    });
    const issues = await checkStaleness(file, '/project');

    // The only ref produced nothing to correlate against, so the batch call
    // is never made and no staleness issue can fire.
    expect(mockedGetCommitActivity).not.toHaveBeenCalled();
    expect(issues).toHaveLength(0);
  });

  it('mixes glob-derived dir prefixes with plain refs (deduped)', async () => {
    mockedIsGitRepo.mockResolvedValue(true);
    mockedGetFileLastCommit.mockResolvedValue(
      commitAt(new Date(Date.now() - 45 * 24 * 60 * 60 * 1000)),
    );
    mockedGetCommitActivity.mockImplementation(async (_root, paths) => activity(paths));
    const file = makeParsedFile({
      references: {
        paths: [
          { value: 'src/*.ts', line: 3, column: 1 },
          { value: 'src/lib/*.ts', line: 4, column: 1 },
          { value: 'src/lib/*.test.ts', line: 5, column: 1 },
          { value: 'docs/readme.md', line: 6, column: 1 },
        ],
        commands: [],
      },
    });
    await checkStaleness(file, '/project');

    const callPaths = mockedGetCommitActivity.mock.calls[0][1];
    expect([...callPaths].sort()).toEqual(['docs/readme.md', 'src/', 'src/lib/']);
  });
});
