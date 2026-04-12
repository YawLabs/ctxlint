import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolve } from 'node:path';
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

  it('expands ~/ refs against $HOME before existence check', async () => {
    const originalHome = process.env.HOME;
    const originalUser = process.env.USERPROFILE;
    const fakeHome = resolve('/home/jeff');
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    const expandedTarget = resolve(fakeHome, '.claude/CLAUDE.md');
    // existsSync returns true only for the expanded path; false otherwise.
    mockExistsSync.mockImplementation((p) => p === expandedTarget);
    try {
      const ctx = makeCtx([makeMemory(['~/.claude/CLAUDE.md'])]);
      const issues = await checkStaleMemory(ctx);
      expect(issues).toHaveLength(0);
    } finally {
      process.env.HOME = originalHome;
      process.env.USERPROFILE = originalUser;
    }
  });

  it('flags ~/ refs that do not exist after expansion', async () => {
    const originalHome = process.env.HOME;
    process.env.HOME = resolve('/home/jeff');
    mockExistsSync.mockReturnValue(false);
    try {
      const ctx = makeCtx([makeMemory(['~/.claude/nonexistent.md'])]);
      const issues = await checkStaleMemory(ctx);
      expect(issues).toHaveLength(1);
      expect(issues[0].message).toContain('~/.claude/nonexistent.md');
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it('resolves mixed absolute + ~/ + relative refs correctly', async () => {
    const originalHome = process.env.HOME;
    const fakeHome = resolve('/home/jeff');
    process.env.HOME = fakeHome;
    const expandedHome = resolve(fakeHome, '.claude/CLAUDE.md');
    const absolutePath = resolve('/abs/real.ts');
    mockExistsSync.mockImplementation((p) => p === expandedHome || p === absolutePath);
    try {
      const ctx = makeCtx([
        makeMemory(['~/.claude/CLAUDE.md', absolutePath, 'relative/missing.ts']),
      ]);
      const issues = await checkStaleMemory(ctx);
      expect(issues).toHaveLength(1);
      // Only the relative missing path should be flagged
      expect(issues[0].message).toContain('relative/missing.ts');
      expect(issues[0].message).not.toContain('~/.claude');
      expect(issues[0].message).not.toContain('/abs/real.ts');
    } finally {
      process.env.HOME = originalHome;
    }
  });
});
