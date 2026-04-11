import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkDivergedFile } from '../diverged-file.js';
import type { SessionContext, SiblingRepo } from '../../../types.js';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const mockReadFile = vi.mocked(readFile);
const mockExistsSync = vi.mocked(existsSync);

function makeSibling(name: string, basePath = '/repos'): SiblingRepo {
  return { path: `${basePath}/${name}`, name };
}

function makeCtx(siblings: SiblingRepo[], currentProject = '/repos/current'): SessionContext {
  return { history: [], memories: [], siblings, currentProject, providers: ['claude-code'] };
}

beforeEach(() => {
  vi.resetAllMocks();
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

    mockReadFile.mockImplementation(async (p) => {
      const ps = String(p).replace(/\\/g, '/');
      if (ps.includes('/repos/current/')) return currentContent;
      if (ps.includes('/repos/foo/')) return sibContent;
      return '';
    });

    const ctx = makeCtx([makeSibling('foo')]);
    const issues = await checkDivergedFile(ctx);
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0].check).toBe('session-diverged-file');
    expect(issues[0].severity).toBe('warning');
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
});
