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

function makeCtx(memories: MemoryEntry[], currentProject = 'project-a'): SessionContext {
  // currentProject is compared against projectDir via projectDirMatchesPath,
  // which normalizes both via `encodeProjectDir`. For simple single-segment
  // names with no `:`, `/`, `\`, or `.`, the encoding is the identity, so
  // passing `'project-a'` as currentProject matches any memory whose
  // projectDir is `'project-a'` — which is what the tests below need to
  // exercise the "one side is current project" scoping rule.
  return {
    history: [],
    memories,
    siblings: [],
    currentProject,
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

  it('skips memories that fall under 50 characters once trimmed', async () => {
    // Raw length clears 50 only via surrounding blank lines; the trimmed core
    // is too short for meaningful overlap comparison and must be skipped
    // (spec 2.5 step 3: "after stripping whitespace").
    const padded = '\n'.repeat(10) + 'short convention memo' + '\n'.repeat(30);
    expect(padded.length).toBeGreaterThanOrEqual(50);
    expect(padded.trim().length).toBeLessThan(50);
    const ctx = makeCtx([makeMemory(padded, 'project-a'), makeMemory(padded, 'project-b')]);
    const issues = await checkDuplicateMemory(ctx);
    expect(issues).toHaveLength(0);
  });

  it('ignores duplicate pairs where neither side is the current project', async () => {
    const sharedContent = [
      'This project uses TypeScript for everything',
      'Always run pnpm test before committing',
      'The main entry point is src/index.ts',
      'Use vitest for testing with describe/it/expect',
      'Format with prettier before pushing',
    ].join('\n');

    // Both memories are in OTHER projects relative to current — should not fire.
    const ctx = makeCtx(
      [
        makeMemory(sharedContent, 'project-b', 'conventions'),
        makeMemory(sharedContent, 'project-c', 'conventions'),
      ],
      'project-a',
    );
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

describe('checkDuplicateMemory cost', () => {
  /** A memory whose `content` reads are counted. */
  function counted(projectDir: string, name: string, counter: { reads: number }): MemoryEntry {
    const m = makeMemory('', projectDir, name);
    const text = `${name} has a long enough body to clear the fifty-character minimum for comparison.\nsecond line of ${name}`;
    Object.defineProperty(m, 'content', {
      get: () => {
        counter.reads++;
        return text;
      },
    });
    return m;
  }

  it('touches no memory content when no memory belongs to the current project', async () => {
    // Only pairs with a current-project side are compared, so with none there
    // is nothing to tokenize -- and nothing should be read.
    const counter = { reads: 0 };
    const memories = Array.from({ length: 50 }, (_, i) => counted(`p${i}`, `m${i}`, counter));
    expect(await checkDuplicateMemory(makeCtx(memories))).toHaveLength(0);
    expect(counter.reads).toBe(0);
  });

  it('skips pairs whose line counts are too far apart to reach the overlap bar', async () => {
    // Jaccard >= 0.6 needs min/max line-set size >= 0.6, so a 10-line memory
    // can never duplicate a 1-line one. Both still clear the length floor.
    const long = Array.from(
      { length: 10 },
      (_, i) => `distinct line number ${i} of the long one`,
    ).join('\n');
    const short = 'distinct line number 0 of the long one, padded past fifty characters';
    const ctx = makeCtx([
      makeMemory(long, 'project-a', 'long'),
      makeMemory(short, 'project-b', 'short'),
    ]);
    expect(await checkDuplicateMemory(ctx)).toHaveLength(0);
  });
});

describe('checkDuplicateMemory -- project path containing an underscore', () => {
  it('recognises the folded dir Claude Code creates as the current project', async () => {
    const sharedContent = [
      'This project uses TypeScript for everything',
      'Always run pnpm test before committing',
      'The main entry point is src/index.ts',
    ].join('\n');
    const ctx = makeCtx(
      [
        makeMemory(sharedContent, 'C--Users-x-yaw-mcp-servers-ctxlint', 'conventions'),
        makeMemory(sharedContent, 'C--Users-x-yaw-other', 'conventions'),
      ],
      'C:/Users/x/yaw/mcp_servers/ctxlint',
    );
    const issues = await checkDuplicateMemory(ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0].check).toBe('session-duplicate-memory');
  });
});
