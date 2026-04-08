import { describe, it, expect } from 'vitest';
import { checkLoopDetection } from '../loop-detection.js';
import type { SessionContext, HistoryEntry } from '../../../types.js';

function makeEntry(display: string, timestamp: number, project = '/project/foo'): HistoryEntry {
  return {
    display,
    timestamp,
    project,
    sessionId: 'test-session',
    provider: 'claude-code',
  };
}

function makeCtx(entries: HistoryEntry[], currentProject = '/project/foo'): SessionContext {
  return {
    history: entries,
    memories: [],
    siblings: [],
    currentProject,
    providers: ['claude-code'],
  };
}

describe('checkLoopDetection', () => {
  it('detects 3 consecutive identical commands', async () => {
    const entries = [makeEntry('npm test', 1), makeEntry('npm test', 2), makeEntry('npm test', 3)];

    const issues = await checkLoopDetection(makeCtx(entries));
    expect(issues.length).toBe(1);
    expect(issues[0].check).toBe('session-loop-detection');
    expect(issues[0].ruleId).toBe('session/consecutive-repeat');
    expect(issues[0].message).toContain('npm test');
    expect(issues[0].message).toContain('3 times');
  });

  it('does not flag 2 consecutive identical commands', async () => {
    const entries = [makeEntry('npm test', 1), makeEntry('npm test', 2)];

    const issues = await checkLoopDetection(makeCtx(entries));
    expect(issues.length).toBe(0);
  });

  it('detects cyclic A,B,A,B pattern', async () => {
    const entries = [
      makeEntry('edit file.ts', 1),
      makeEntry('npm test', 2),
      makeEntry('edit file.ts', 3),
      makeEntry('npm test', 4),
    ];

    const issues = await checkLoopDetection(makeCtx(entries));
    expect(issues.length).toBe(1);
    expect(issues[0].ruleId).toBe('session/cyclic-pattern');
    expect(issues[0].message).toContain('2 times');
  });

  it('returns no issues for diverse commands', async () => {
    const entries = [
      makeEntry('npm test', 1),
      makeEntry('git status', 2),
      makeEntry('npm run build', 3),
      makeEntry('git add .', 4),
    ];

    const issues = await checkLoopDetection(makeCtx(entries));
    expect(issues.length).toBe(0);
  });

  it('returns no issues for empty history', async () => {
    const issues = await checkLoopDetection(makeCtx([]));
    expect(issues.length).toBe(0);
  });

  it('ignores entries from different projects', async () => {
    const entries = [
      makeEntry('npm test', 1, '/project/foo'),
      makeEntry('npm test', 2, '/project/bar'),
      makeEntry('npm test', 3, '/project/baz'),
    ];

    const issues = await checkLoopDetection(makeCtx(entries, '/project/foo'));
    expect(issues.length).toBe(0);
  });

  it('detects longer consecutive repeats', async () => {
    const entries = [
      makeEntry('npm test', 1),
      makeEntry('npm test', 2),
      makeEntry('npm test', 3),
      makeEntry('npm test', 4),
      makeEntry('npm test', 5),
    ];

    const issues = await checkLoopDetection(makeCtx(entries));
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('5 times');
  });

  it('detects A,B,C,A,B,C cyclic pattern', async () => {
    const entries = [
      makeEntry('edit file.ts', 1),
      makeEntry('npm test', 2),
      makeEntry('git diff', 3),
      makeEntry('edit file.ts', 4),
      makeEntry('npm test', 5),
      makeEntry('git diff', 6),
    ];

    const issues = await checkLoopDetection(makeCtx(entries));
    expect(issues.length).toBe(1);
    expect(issues[0].ruleId).toBe('session/cyclic-pattern');
  });

  it('truncates long command names in messages', async () => {
    const longCmd = 'a'.repeat(100);
    const entries = [makeEntry(longCmd, 1), makeEntry(longCmd, 2), makeEntry(longCmd, 3)];

    const issues = await checkLoopDetection(makeCtx(entries));
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('...');
    expect(issues[0].message.length).toBeLessThan(200);
  });
});
