import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { checkStaleMemory } from '../stale-memory.js';
import type { SessionContext, MemoryEntry } from '../../../types.js';

// The rest of node:fs stays real: the underscore case below loads the actual
// session-parser, which reads its web-segment fixture at import time.
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
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

// Saved once per case and restored in afterEach. Restoring with
// `process.env.HOME = original` would store the string "undefined" when HOME
// was unset, so an unset variable is deleted instead.
let savedHome: string | undefined;
let savedProfile: string | undefined;

/** Point home at `dir` the way the home helper reads it on every platform. */
function setHome(dir: string): void {
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
}

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedProfile;
});

beforeEach(() => {
  savedHome = process.env.HOME;
  savedProfile = process.env.USERPROFILE;
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

  it('populates affectedPaths with exactly the broken paths (not the existing ones)', async () => {
    // existsSync returns true for `src/real.ts`, false for the others.
    mockExistsSync.mockImplementation((p) => String(p).endsWith('real.ts'));
    const ctx = makeCtx([makeMemory(['src/real.ts', 'src/ghost.ts', 'src/also-missing.ts'])]);
    const issues = await checkStaleMemory(ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0].affectedPaths).toEqual(['src/ghost.ts', 'src/also-missing.ts']);
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
    const fakeHome = resolve('/home/jeff');
    setHome(fakeHome);
    const expandedTarget = resolve(fakeHome, '.claude/CLAUDE.md');
    // existsSync returns true only for the expanded path; false otherwise.
    mockExistsSync.mockImplementation((p) => p === expandedTarget);
    const ctx = makeCtx([makeMemory(['~/.claude/CLAUDE.md'])]);
    const issues = await checkStaleMemory(ctx);
    expect(issues).toHaveLength(0);
  });

  it('resolves ~/ refs via os.homedir() when neither HOME nor USERPROFILE is set', async () => {
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    const expandedTarget = resolve(homedir(), '.claude/CLAUDE.md');
    // existsSync returns true only for the homedir()-expanded path. Without the
    // fallback `home` would be null, the ref would be skipped, and no issue
    // would fire even though the path does not "exist" per the mock for any
    // other input.
    mockExistsSync.mockImplementation((p) => p !== expandedTarget);
    const ctx = makeCtx([makeMemory(['~/.claude/CLAUDE.md'])]);
    const issues = await checkStaleMemory(ctx);
    // The ref resolved (was not skipped) and was checked against existsSync,
    // which reports it missing -> one issue.
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('~/.claude/CLAUDE.md');
  });

  it('flags ~/ refs that do not exist after expansion', async () => {
    const fakeHome = resolve('/home/jeff');
    setHome(fakeHome);
    const expanded = resolve(fakeHome, '.claude/nonexistent.md');
    const checked: string[] = [];
    mockExistsSync.mockImplementation((p) => {
      checked.push(String(p));
      return false;
    });
    const ctx = makeCtx([makeMemory(['~/.claude/nonexistent.md'])]);
    const issues = await checkStaleMemory(ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('~/.claude/nonexistent.md');
    // Pinned: the path checked is the expansion under the redirected home.
    expect(checked).toEqual([expanded]);
  });

  it('flags only the missing paths when memory has a mix of existing and missing', async () => {
    // existsSync returns true for `src/real.ts`, false for `src/ghost.ts`.
    mockExistsSync.mockImplementation((p) => String(p).endsWith('real.ts'));
    const ctx = makeCtx([makeMemory(['src/real.ts', 'src/ghost.ts', 'src/also-missing.ts'])]);
    const issues = await checkStaleMemory(ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('ghost.ts');
    expect(issues[0].message).toContain('also-missing.ts');
    expect(issues[0].message).not.toContain('real.ts');
  });

  it('resolves mixed absolute + ~/ + relative refs correctly', async () => {
    const fakeHome = resolve('/home/jeff');
    setHome(fakeHome);
    const expandedHome = resolve(fakeHome, '.claude/CLAUDE.md');
    const absolutePath = resolve('/abs/real.ts');
    mockExistsSync.mockImplementation((p) => p === expandedHome || p === absolutePath);
    const ctx = makeCtx([makeMemory(['~/.claude/CLAUDE.md', absolutePath, 'relative/missing.ts'])]);
    const issues = await checkStaleMemory(ctx);
    expect(issues).toHaveLength(1);
    // Only the relative missing path should be flagged
    expect(issues[0].message).toContain('relative/missing.ts');
    expect(issues[0].message).not.toContain('~/.claude');
    expect(issues[0].message).not.toContain('/abs/real.ts');
  });
});

describe('checkStaleMemory -- project path containing an underscore', () => {
  it('scopes to the folded dir Claude Code creates (mcp_servers -> mcp-servers)', async () => {
    // Through the REAL matcher: the mock above would hide the encoding bug,
    // where an exact-encoding comparison never matched the folded dir name.
    const actual = await vi.importActual<typeof import('../../../session-parser.js')>(
      '../../../session-parser.js',
    );
    mockProjectDirMatchesPath.mockImplementation(actual.projectDirMatchesPath);
    mockExistsSync.mockReturnValue(false);

    const ctx = makeCtx(
      [makeMemory(['src/deleted-file.ts'], 'C--Users-x-yaw-mcp-servers-ctxlint')],
      'C:\\Users\\x\\yaw\\mcp_servers\\ctxlint',
    );
    const issues = await checkStaleMemory(ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('src/deleted-file.ts');
  });
});
