import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkMissingWorkflow } from '../missing-workflow.js';
import type { SessionContext, SiblingRepo } from '../../../types.js';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(),
}));

// The current project's GitHub owner comes from its git remote; stub it so
// each case states the owner it means instead of spawning git.
vi.mock('../../../sibling-org.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../sibling-org.js')>()),
  currentGitOrg: vi.fn(async () => undefined),
}));

import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { currentGitOrg } from '../../../sibling-org.js';

const mockExistsSync = vi.mocked(existsSync);
const mockReaddir = vi.mocked(readdir);
const mockCurrentGitOrg = vi.mocked(currentGitOrg);

function makeSibling(name: string, basePath = '/repos'): SiblingRepo {
  return { path: `${basePath}/${name}`, name };
}

function makeCtx(siblings: SiblingRepo[], currentProject = '/repos/current'): SessionContext {
  return { history: [], memories: [], siblings, currentProject, providers: ['claude-code'] };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockCurrentGitOrg.mockResolvedValue(undefined);
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

  it('counts only siblings under the same GitHub owner', async () => {
    mockExistsSync.mockReturnValue(true);
    mockCurrentGitOrg.mockResolvedValue('acme');
    mockReaddir.mockImplementation(async (dir) => {
      const d = String(dir).replace(/\\/g, '/');
      if (d.includes('/repos/current/'))
        return ['ci.yml'] as unknown as Awaited<ReturnType<typeof readdir>>;
      return ['ci.yml', 'deploy.yml'] as unknown as Awaited<ReturnType<typeof readdir>>;
    });

    // Two siblings have deploy.yml, but only one shares the owner: below the
    // two-sibling threshold once the unrelated repo is set aside.
    const ctx = makeCtx([
      { path: '/repos/mine', name: 'mine', gitOrg: 'acme' },
      { path: '/repos/theirs', name: 'theirs', gitOrg: 'someone-else' },
    ]);
    expect(await checkMissingWorkflow(ctx)).toHaveLength(0);
  });
});
