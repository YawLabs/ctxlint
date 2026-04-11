import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkStaleMemory } from '../stale-memory.js';
import type { SessionContext, MemoryEntry } from '../../../types.js';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

vi.mock('../../../session-parser.js', () => ({
  projectDirMatchesPath: vi.fn(),
}));

import { existsSync } from 'node:fs';
import { projectDirMatchesPath } from '../../../session-parser.js';

const mockExistsSync = vi.mocked(existsSync);
const mockProjectDirMatchesPath = vi.mocked(projectDirMatchesPath);

function makeMemory(
  referencedPaths: string[],
  projectDir = 'C--Users-jeff-repos-current',
  name = 'test-memory',
): MemoryEntry {
  return {
    filePath: `/home/jeff/.claude/projects/${projectDir}/memory/${name}.md`,
    projectDir,
    name,
    content: 'some memory content',
    referencedPaths,
  };
}

function makeCtx(memories: MemoryEntry[], currentProject = '/repos/current'): SessionContext {
  return { history: [], memories, siblings: [], currentProject, providers: ['claude-code'] };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockProjectDirMatchesPath.mockReturnValue(true);
});

describe('checkStaleMemory', () => {
  it('returns no issues when all referenced paths exist', async () => {
    mockExistsSync.mockReturnValue(true);

    const ctx = makeCtx([makeMemory(['src/index.ts', 'package.json'])]);
    const issues = await checkStaleMemory(ctx);
    expect(issues).toHaveLength(0);
  });

  it('flags memory with broken path references', async () => {
    mockExistsSync.mockReturnValue(false);

    const ctx = makeCtx([makeMemory(['src/deleted-file.ts'])]);
    const issues = await checkStaleMemory(ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0].check).toBe('session-stale-memory');
    expect(issues[0].severity).toBe('info');
    expect(issues[0].message).toContain('deleted-file.ts');
  });

  it('reports count of broken paths', async () => {
    mockExistsSync.mockReturnValue(false);

    const ctx = makeCtx([makeMemory(['src/a.ts', 'src/b.ts', 'src/c.ts'])]);
    const issues = await checkStaleMemory(ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('3 path(s)');
  });

  it('skips memories from other projects', async () => {
    mockProjectDirMatchesPath.mockReturnValue(false);
    mockExistsSync.mockReturnValue(false);

    const ctx = makeCtx([makeMemory(['src/deleted.ts'], 'C--other-project')]);
    const issues = await checkStaleMemory(ctx);
    expect(issues).toHaveLength(0);
  });

  it('returns no issues when memory has no referenced paths', async () => {
    const ctx = makeCtx([makeMemory([])]);
    const issues = await checkStaleMemory(ctx);
    expect(issues).toHaveLength(0);
  });

  it('returns no issues with no memories', async () => {
    const ctx = makeCtx([]);
    const issues = await checkStaleMemory(ctx);
    expect(issues).toHaveLength(0);
  });
});
