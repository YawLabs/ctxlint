import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkStaleness } from '../staleness.js';
import type { ParsedContextFile } from '../../types.js';

// Mock git utilities
vi.mock('../../../utils/git.js', () => ({
  isGitRepo: vi.fn(),
  getFileLastModified: vi.fn(),
  getCommitsSinceBatch: vi.fn(),
}));

import { isGitRepo, getFileLastModified, getCommitsSinceBatch } from '../../../utils/git.js';

const mockedIsGitRepo = vi.mocked(isGitRepo);
const mockedGetFileLastModified = vi.mocked(getFileLastModified);
const mockedGetCommitsSinceBatch = vi.mocked(getCommitsSinceBatch);

function batchMap(requested: string[], counts: Record<string, number> = {}): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of requested) m.set(p, counts[p] ?? 0);
  return m;
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

  it('returns no issues when file last modified date is unknown', async () => {
    mockedIsGitRepo.mockResolvedValue(true);
    mockedGetFileLastModified.mockResolvedValue(null);
    const issues = await checkStaleness(makeParsedFile(), '/project');
    expect(issues).toHaveLength(0);
  });

  it('returns no issues when file was recently updated (< 14 days)', async () => {
    mockedIsGitRepo.mockResolvedValue(true);
    mockedGetFileLastModified.mockResolvedValue(new Date(Date.now() - 5 * 24 * 60 * 60 * 1000));
    const issues = await checkStaleness(makeParsedFile(), '/project');
    expect(issues).toHaveLength(0);
  });

  it('returns no issues when referenced paths have no commits since', async () => {
    mockedIsGitRepo.mockResolvedValue(true);
    mockedGetFileLastModified.mockResolvedValue(new Date(Date.now() - 20 * 24 * 60 * 60 * 1000));
    mockedGetCommitsSinceBatch.mockImplementation(async (_root, paths) => batchMap(paths));
    const issues = await checkStaleness(makeParsedFile(), '/project');
    expect(issues).toHaveLength(0);
  });

  it('returns info severity for 14-30 day old file with changed paths', async () => {
    mockedIsGitRepo.mockResolvedValue(true);
    mockedGetFileLastModified.mockResolvedValue(new Date(Date.now() - 20 * 24 * 60 * 60 * 1000));
    mockedGetCommitsSinceBatch.mockImplementation(async (_root, paths) =>
      batchMap(paths, { 'src/index.ts': 3 }),
    );
    const issues = await checkStaleness(makeParsedFile(), '/project');
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('info');
    expect(issues[0].check).toBe('staleness');
    expect(issues[0].message).toContain('20 days ago');
  });

  it('returns warning severity for 30+ day old file with changed paths', async () => {
    mockedIsGitRepo.mockResolvedValue(true);
    mockedGetFileLastModified.mockResolvedValue(new Date(Date.now() - 45 * 24 * 60 * 60 * 1000));
    mockedGetCommitsSinceBatch.mockImplementation(async (_root, paths) =>
      batchMap(paths, { 'src/index.ts': 8 }),
    );
    const issues = await checkStaleness(makeParsedFile(), '/project');
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].message).toContain('45 days ago');
  });

  it('reports the most active path in the message', async () => {
    mockedIsGitRepo.mockResolvedValue(true);
    mockedGetFileLastModified.mockResolvedValue(new Date(Date.now() - 40 * 24 * 60 * 60 * 1000));
    mockedGetCommitsSinceBatch.mockImplementation(async (_root, paths) =>
      batchMap(paths, { 'src/index.ts': 2, 'src/utils/helper.ts': 10 }),
    );
    const issues = await checkStaleness(makeParsedFile(), '/project');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('src/utils/helper.ts');
    expect(issues[0].message).toContain('10 commits');
  });

  it('handles file with no path references', async () => {
    mockedIsGitRepo.mockResolvedValue(true);
    mockedGetFileLastModified.mockResolvedValue(new Date(Date.now() - 40 * 24 * 60 * 60 * 1000));
    const file = makeParsedFile({ references: { paths: [], commands: [] } });
    const issues = await checkStaleness(file, '/project');
    expect(issues).toHaveLength(0);
  });

  it('handles invalid date gracefully', async () => {
    mockedIsGitRepo.mockResolvedValue(true);
    mockedGetFileLastModified.mockResolvedValue(new Date('invalid'));
    const issues = await checkStaleness(makeParsedFile(), '/project');
    expect(issues).toHaveLength(0);
  });
});
