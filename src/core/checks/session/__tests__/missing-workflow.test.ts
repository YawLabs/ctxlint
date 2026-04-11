import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkMissingWorkflow } from '../missing-workflow.js';
import type { SessionContext, SiblingRepo } from '../../../types.js';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(),
}));

import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';

const mockExistsSync = vi.mocked(existsSync);
const mockReaddir = vi.mocked(readdir);

function makeSibling(name: string, basePath = '/repos'): SiblingRepo {
  return { path: `${basePath}/${name}`, name };
}

function makeCtx(siblings: SiblingRepo[], currentProject = '/repos/current'): SessionContext {
  return { history: [], memories: [], siblings, currentProject, providers: ['claude-code'] };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('checkMissingWorkflow', () => {
  it('skips when current project has no .github directory', async () => {
    mockExistsSync.mockReturnValue(false);

    const ctx = makeCtx([makeSibling('foo')]);
    const issues = await checkMissingWorkflow(ctx);
    expect(issues).toHaveLength(0);
  });

  it('returns no issues when all siblings have the same workflows', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddir.mockResolvedValue(['ci.yml', 'release.yml'] as unknown as Awaited<
      ReturnType<typeof readdir>
    >);

    const ctx = makeCtx([makeSibling('foo'), makeSibling('bar')]);
    const issues = await checkMissingWorkflow(ctx);
    expect(issues).toHaveLength(0);
  });

  it('flags workflow missing from current project when 2+ siblings have it', async () => {
    mockExistsSync.mockReturnValue(true);

    mockReaddir.mockImplementation(async (dir) => {
      const d = String(dir).replace(/\\/g, '/');
      if (d.includes('/repos/current/'))
        return ['ci.yml'] as unknown as Awaited<ReturnType<typeof readdir>>;
      // siblings have deploy.yml that current doesn't
      return ['ci.yml', 'deploy.yml'] as unknown as Awaited<ReturnType<typeof readdir>>;
    });

    const ctx = makeCtx([makeSibling('foo'), makeSibling('bar')]);
    const issues = await checkMissingWorkflow(ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0].check).toBe('session-missing-workflow');
    expect(issues[0].message).toContain('deploy.yml');
    expect(issues[0].severity).toBe('warning');
  });

  it('does not flag workflow only one sibling has', async () => {
    mockExistsSync.mockReturnValue(true);

    mockReaddir.mockImplementation(async (dir) => {
      const d = String(dir).replace(/\\/g, '/');
      if (d.includes('/repos/current/'))
        return ['ci.yml'] as unknown as Awaited<ReturnType<typeof readdir>>;
      if (d.includes('/repos/foo/'))
        return ['ci.yml', 'deploy.yml'] as unknown as Awaited<ReturnType<typeof readdir>>;
      return ['ci.yml'] as unknown as Awaited<ReturnType<typeof readdir>>;
    });

    const ctx = makeCtx([makeSibling('foo'), makeSibling('bar')]);
    const issues = await checkMissingWorkflow(ctx);
    expect(issues).toHaveLength(0);
  });

  it('returns no issues with no siblings', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddir.mockResolvedValue(['ci.yml'] as unknown as Awaited<ReturnType<typeof readdir>>);

    const ctx = makeCtx([]);
    const issues = await checkMissingWorkflow(ctx);
    expect(issues).toHaveLength(0);
  });
});
