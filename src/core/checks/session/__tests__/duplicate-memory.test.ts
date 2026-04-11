import { describe, it, expect } from 'vitest';
import { checkDuplicateMemory } from '../duplicate-memory.js';
import type { SessionContext, MemoryEntry } from '../../../types.js';

function makeMemory(content: string, projectDir: string, name = 'test-memory'): MemoryEntry {
  return {
    filePath: `/home/jeff/.claude/projects/${projectDir}/memory/${name}.md`,
    projectDir,
    name,
    content,
    referencedPaths: [],
  };
}

function makeCtx(memories: MemoryEntry[]): SessionContext {
  return {
    history: [],
    memories,
    siblings: [],
    currentProject: '/repos/current',
    providers: ['claude-code'],
  };
}

describe('checkDuplicateMemory', () => {
  it('returns no issues with no memories', async () => {
    const issues = await checkDuplicateMemory(makeCtx([]));
    expect(issues).toHaveLength(0);
  });

  it('returns no issues when memories are from the same project', async () => {
    const content =
      'This is a fairly long memory content that has enough characters to pass the 50 char minimum threshold for comparison.';
    const ctx = makeCtx([
      makeMemory(content, 'project-a', 'mem1'),
      makeMemory(content, 'project-a', 'mem2'),
    ]);
    const issues = await checkDuplicateMemory(ctx);
    expect(issues).toHaveLength(0);
  });

  it('flags near-duplicate memories across different projects', async () => {
    const sharedContent = [
      'This project uses TypeScript for everything',
      'Always run pnpm test before committing',
      'The main entry point is src/index.ts',
      'Use vitest for testing with describe/it/expect',
      'Format with prettier before pushing',
    ].join('\n');

    const ctx = makeCtx([
      makeMemory(sharedContent, 'project-a', 'conventions'),
      makeMemory(sharedContent, 'project-b', 'conventions'),
    ]);
    const issues = await checkDuplicateMemory(ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0].check).toBe('session-duplicate-memory');
    expect(issues[0].severity).toBe('info');
    expect(issues[0].message).toContain('overlap');
  });

  it('does not flag memories with low overlap', async () => {
    const contentA = [
      'This project is a React frontend application',
      'It uses Next.js for server-side rendering',
      'Tailwind CSS for styling components',
      'Deploy to Vercel for production hosting',
      'Use pnpm as the package manager',
    ].join('\n');
    const contentB = [
      'This project is a Go backend service',
      'It uses gRPC for inter-service communication',
      'PostgreSQL for the main database layer',
      'Deploy to Kubernetes via Helm charts',
      'Use make for build automation tasks',
    ].join('\n');

    const ctx = makeCtx([makeMemory(contentA, 'project-a'), makeMemory(contentB, 'project-b')]);
    const issues = await checkDuplicateMemory(ctx);
    expect(issues).toHaveLength(0);
  });

  it('skips memories with content shorter than 50 characters', async () => {
    const ctx = makeCtx([makeMemory('short', 'project-a'), makeMemory('short', 'project-b')]);
    const issues = await checkDuplicateMemory(ctx);
    expect(issues).toHaveLength(0);
  });

  it('does not report the same pair twice', async () => {
    const content = [
      'Shared convention line one is here',
      'Shared convention line two is here',
      'Shared convention line three here',
      'Shared convention line four here',
    ].join('\n');

    const ctx = makeCtx([
      makeMemory(content, 'project-a', 'mem'),
      makeMemory(content, 'project-b', 'mem'),
    ]);
    const issues = await checkDuplicateMemory(ctx);
    expect(issues).toHaveLength(1);
  });
});
