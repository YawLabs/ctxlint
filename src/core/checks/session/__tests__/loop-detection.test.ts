import { describe, it, expect } from 'vitest';
import { checkLoopDetection } from '../loop-detection.js';
import type { SessionContext, HistoryEntry } from '../../../types.js';

function makeEntry(
  display: string,
  timestamp: number,
  project = '/project/foo',
  sessionId = 'test-session',
): HistoryEntry {
  return {
    display,
    timestamp,
    project,
    sessionId,
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
    expect(issues[0].ruleId).toBe('session-loop-detection/consecutive-repeat');
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
    expect(issues[0].ruleId).toBe('session-loop-detection/cyclic-pattern');
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
    expect(issues[0].ruleId).toBe('session-loop-detection/cyclic-pattern');
  });

  it('reports a consecutive run and an interleaved cycle without double-counting the run', async () => {
    // [A,A,A, B,A,B,A,B]: the A,A,A run is a consecutive-repeat (span 0-2);
    // the trailing B,A,B,A,B is a B->A cycle that sits after the run. The run
    // must be reported once (not also re-counted inside an A,B cycle that
    // reaches back into it), and the post-run cycle must still fire.
    const entries = [
      makeEntry('cmd A', 1),
      makeEntry('cmd A', 2),
      makeEntry('cmd A', 3),
      makeEntry('cmd B', 4),
      makeEntry('cmd A', 5),
      makeEntry('cmd B', 6),
      makeEntry('cmd A', 7),
      makeEntry('cmd B', 8),
    ];

    const issues = await checkLoopDetection(makeCtx(entries));
    const consecutive = issues.filter(
      (i) => i.ruleId === 'session-loop-detection/consecutive-repeat',
    );
    const cyclic = issues.filter((i) => i.ruleId === 'session-loop-detection/cyclic-pattern');

    // The A,A,A run is reported exactly once by the consecutive check.
    expect(consecutive).toHaveLength(1);
    expect(consecutive[0].message).toContain('3 times');

    // The trailing B<->A loop still fires. Every surviving cyclic finding is
    // about that post-run loop (mentions both commands); none re-reports the
    // consecutive A-run — the [A,B] cycle that overlapped span 0-2 is gated out.
    expect(cyclic.length).toBeGreaterThanOrEqual(1);
    for (const issue of cyclic) {
      expect(issue.message).toContain('cmd A');
      expect(issue.message).toContain('cmd B');
    }
  });

  it('does not attribute project-less entries to the current project', async () => {
    // Codex CLI occasionally writes neither `project` nor `cwd`; the scanner
    // keeps those entries with project ''. path.resolve('') is the linter's
    // cwd, so without an explicit guard every project-less entry would match
    // whenever ctxlint lints the current directory (the dominant usage).
    const entries = [
      makeEntry('npm test', 1, ''),
      makeEntry('npm test', 2, ''),
      makeEntry('npm test', 3, ''),
    ];

    const issues = await checkLoopDetection(makeCtx(entries, process.cwd()));
    expect(issues).toHaveLength(0);
  });

  it('does not flag the same command repeated across separate sessions', async () => {
    // Routine reuse: a one-shot `claude "/release"` run on three different
    // days is three sessions, not a loop.
    const entries = [
      makeEntry('/release', 1, '/project/foo', 's1'),
      makeEntry('/release', 2, '/project/foo', 's2'),
      makeEntry('/release', 3, '/project/foo', 's3'),
    ];

    const issues = await checkLoopDetection(makeCtx(entries));
    expect(issues).toHaveLength(0);
  });

  it('does not synthesize a cycle from two interleaved sessions', async () => {
    // Session s1 runs A,A and session s2 runs B,B, interleaved in time.
    // Pooled they'd read A,B,A,B -- a phantom cycle neither session executed.
    const entries = [
      makeEntry('cmd A', 1, '/project/foo', 's1'),
      makeEntry('cmd B', 2, '/project/foo', 's2'),
      makeEntry('cmd A', 3, '/project/foo', 's1'),
      makeEntry('cmd B', 4, '/project/foo', 's2'),
    ];

    const issues = await checkLoopDetection(makeCtx(entries));
    expect(issues).toHaveLength(0);
  });

  it('still detects a loop inside one session when another session interleaves', async () => {
    const entries = [
      makeEntry('npm test', 1, '/project/foo', 's1'),
      makeEntry('git status', 2, '/project/foo', 's2'),
      makeEntry('npm test', 3, '/project/foo', 's1'),
      makeEntry('git log', 4, '/project/foo', 's2'),
      makeEntry('npm test', 5, '/project/foo', 's1'),
    ];

    const issues = await checkLoopDetection(makeCtx(entries));
    expect(issues).toHaveLength(1);
    expect(issues[0].ruleId).toBe('session-loop-detection/consecutive-repeat');
    expect(issues[0].message).toContain('npm test');
  });

  it('breaks a sessionId-less sequence at large time gaps', async () => {
    // Providers that omit sessionId pool into one '' pseudo-session; a 30+
    // minute gap between repeats means separate working stints, not a loop.
    const HOUR = 60 * 60 * 1000;
    const entries = [
      makeEntry('/release', 1 * HOUR, '/project/foo', ''),
      makeEntry('/release', 25 * HOUR, '/project/foo', ''),
      makeEntry('/release', 49 * HOUR, '/project/foo', ''),
    ];

    const issues = await checkLoopDetection(makeCtx(entries));
    expect(issues).toHaveLength(0);
  });

  it('still detects a contiguous loop in a sessionId-less sequence', async () => {
    const entries = [
      makeEntry('npm test', 1_000, '/project/foo', ''),
      makeEntry('npm test', 2_000, '/project/foo', ''),
      makeEntry('npm test', 3_000, '/project/foo', ''),
    ];

    const issues = await checkLoopDetection(makeCtx(entries));
    expect(issues).toHaveLength(1);
    expect(issues[0].ruleId).toBe('session-loop-detection/consecutive-repeat');
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
