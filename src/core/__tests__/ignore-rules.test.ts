import { describe, it, expect } from 'vitest';
import {
  applyIgnoreRules,
  compileRules,
  extractPathsFromMessage,
  type IgnoreRule,
} from '../ignore-rules.js';
import type { LintIssue } from '../types.js';

function issue(partial: Partial<LintIssue> & Pick<LintIssue, 'check' | 'message'>): LintIssue {
  return {
    severity: 'info',
    line: 0,
    ...partial,
  };
}

describe('extractPathsFromMessage', () => {
  it('parses the session-stale-memory path-list segment', () => {
    const msg = 'Memory "feedback" references 3 path(s) that no longer exist: /a, /b, /c';
    expect(extractPathsFromMessage(msg)).toEqual(['/a', '/b', '/c']);
  });

  it('returns [] when no colon-space separator is present', () => {
    expect(extractPathsFromMessage('no separator here')).toEqual([]);
  });

  it('uses the LAST ": " so messages containing a colon in the prefix still parse', () => {
    // A future stale-memory message might be `Memory "foo: bar" references ... no longer exist: /x, /y`.
    // The path list should still come out clean.
    const msg = 'Memory "foo: bar" references 2 path(s) that no longer exist: /x, /y';
    expect(extractPathsFromMessage(msg)).toEqual(['/x', '/y']);
  });

  it('trims whitespace and drops empty entries', () => {
    expect(extractPathsFromMessage('msg: /a,  /b , ')).toEqual(['/a', '/b']);
  });
});

describe('compileRules', () => {
  it('compiles string patterns to RegExp', () => {
    const [r] = compileRules([{ check: 'session-stale-memory', match: 'foo', pathPattern: '/x' }]);
    expect(r.match).toBeInstanceOf(RegExp);
    expect(r.pathPattern).toBeInstanceOf(RegExp);
    expect(r.fired).toBe(false);
  });

  it('leaves match/pathPattern undefined when absent', () => {
    const [r] = compileRules([{ check: 'paths' }]);
    expect(r.match).toBeUndefined();
    expect(r.pathPattern).toBeUndefined();
  });

  // A typo'd pattern in .ctxlintrc.json used to surface as V8's bare
  // 'Invalid regular expression: /[/: ...' with no pointer back to the
  // offending ignoreRules entry. The compile error must name the rule index,
  // the field, and the pattern, and keep the underlying V8 reason.
  it('throws a contextual error naming rule index, field, and pattern for an invalid match regex', () => {
    expect(() => compileRules([{ check: 'paths', match: '[' }])).toThrowError(
      /Invalid regex in ignoreRules\[0\]\.match \("\["\): .*Invalid regular expression/,
    );
  });

  it('reports the correct index and field for an invalid pathPattern on a later rule', () => {
    expect(() =>
      compileRules([{ check: 'paths' }, { check: 'session-stale-memory', pathPattern: '(' }]),
    ).toThrowError(/Invalid regex in ignoreRules\[1\]\.pathPattern \("\("\)/);
  });
});

describe('applyIgnoreRules', () => {
  describe('field combinations', () => {
    it('check-only: drops all issues with that check', () => {
      const issues = [
        issue({ check: 'paths', message: 'foo' }),
        issue({ check: 'commands', message: 'bar' }),
        issue({ check: 'paths', message: 'baz' }),
      ];
      const rules: IgnoreRule[] = [{ check: 'paths' }];
      const result = applyIgnoreRules(issues, rules);
      expect(result.dropped).toBe(2);
      expect(result.kept).toHaveLength(1);
      expect(result.kept[0].check).toBe('commands');
    });

    it('check+match: drops only issues whose message matches', () => {
      const issues = [
        issue({ check: 'paths', message: 'release.yml not found' }),
        issue({ check: 'paths', message: 'src/foo.ts not found' }),
      ];
      const rules: IgnoreRule[] = [{ check: 'paths', match: 'release\\.yml' }];
      const result = applyIgnoreRules(issues, rules);
      expect(result.dropped).toBe(1);
      expect(result.kept).toHaveLength(1);
      expect(result.kept[0].message).toContain('foo.ts');
    });

    it('check+pathPattern: drops session-stale-memory when ALL paths match', () => {
      const issues = [
        issue({
          check: 'session-stale-memory',
          message:
            'Memory "a" references 2 path(s) that no longer exist: /yaw-review, /release-yaw',
        }),
        issue({
          check: 'session-stale-memory',
          message:
            'Memory "b" references 2 path(s) that no longer exist: /yaw-review, ~/.ssh/real_key',
        }),
      ];
      const rules: IgnoreRule[] = [
        { check: 'session-stale-memory', pathPattern: '^/[a-z][a-z0-9-]*$' },
      ];
      const result = applyIgnoreRules(issues, rules);
      // First issue: all paths match. Second issue: ~/.ssh/real_key does NOT
      // match the pattern, so the rule's "all paths must match" guard keeps it.
      expect(result.dropped).toBe(1);
      expect(result.kept).toHaveLength(1);
      expect(result.kept[0].message).toContain('real_key');
    });

    it('check+match+pathPattern: both must match', () => {
      const issues = [
        issue({
          check: 'session-stale-memory',
          message: 'Memory "foo" references 1 path(s) that no longer exist: /yaw-review',
        }),
        issue({
          check: 'session-stale-memory',
          message: 'Memory "bar" references 1 path(s) that no longer exist: /yaw-review',
        }),
      ];
      const rules: IgnoreRule[] = [
        { check: 'session-stale-memory', match: '"foo"', pathPattern: '^/[a-z-]+$' },
      ];
      const result = applyIgnoreRules(issues, rules);
      expect(result.dropped).toBe(1);
      expect(result.kept[0].message).toContain('"bar"');
    });

    it('pathPattern is ignored for non-stale-memory checks', () => {
      // The doc-specified guard: pathPattern only applies to session-stale-memory.
      // For other checks the rule should still match on check alone (since match
      // is absent), but pathPattern's presence causes it to fall through to
      // "continue" and the rule never fires.
      const issues = [issue({ check: 'paths', message: 'msg: /yaw-review' })];
      const rules: IgnoreRule[] = [{ check: 'paths', pathPattern: '^/[a-z-]+$' }];
      const result = applyIgnoreRules(issues, rules);
      expect(result.dropped).toBe(0);
      expect(result.kept).toHaveLength(1);
    });

    it('pathPattern with no parseable paths is a no-op', () => {
      const issues = [
        issue({ check: 'session-stale-memory', message: 'no colon-space here at all' }),
      ];
      const rules: IgnoreRule[] = [{ check: 'session-stale-memory', pathPattern: '.*' }];
      const result = applyIgnoreRules(issues, rules);
      expect(result.dropped).toBe(0);
      expect(result.kept).toHaveLength(1);
    });
  });

  describe('pathPattern prefers structured affectedPaths over message scraping', () => {
    it('uses affectedPaths when present (ignores the message text entirely)', () => {
      const issues = [
        issue({
          check: 'session-stale-memory',
          // Message deliberately lists a path that would NOT match the pattern;
          // if the rule scraped the message it would keep the issue.
          message: 'Memory "a" references 2 path(s) that no longer exist: ~/.ssh/real_key, /etc',
          affectedPaths: ['/yaw-review', '/release-yaw'],
        }),
      ];
      const rules: IgnoreRule[] = [
        { check: 'session-stale-memory', pathPattern: '^/[a-z][a-z0-9-]*$' },
      ];
      const result = applyIgnoreRules(issues, rules);
      // affectedPaths all match the pattern -> dropped, despite the message.
      expect(result.dropped).toBe(1);
      expect(result.kept).toHaveLength(0);
    });

    it('keeps the issue when an affectedPaths entry does not match (all-must-match)', () => {
      const issues = [
        issue({
          check: 'session-stale-memory',
          message:
            'Memory "b" references 2 path(s) that no longer exist: /yaw-review, /release-yaw',
          affectedPaths: ['/yaw-review', '~/.ssh/real_key'],
        }),
      ];
      const rules: IgnoreRule[] = [
        { check: 'session-stale-memory', pathPattern: '^/[a-z][a-z0-9-]*$' },
      ];
      const result = applyIgnoreRules(issues, rules);
      expect(result.dropped).toBe(0);
      expect(result.kept).toHaveLength(1);
    });

    it('falls back to message scraping when affectedPaths is absent', () => {
      const issues = [
        issue({
          check: 'session-stale-memory',
          message:
            'Memory "a" references 2 path(s) that no longer exist: /yaw-review, /release-yaw',
        }),
      ];
      const rules: IgnoreRule[] = [
        { check: 'session-stale-memory', pathPattern: '^/[a-z][a-z0-9-]*$' },
      ];
      const result = applyIgnoreRules(issues, rules);
      expect(result.dropped).toBe(1);
      expect(result.kept).toHaveLength(0);
    });
  });

  describe('precedence (first matching rule wins)', () => {
    it('the first matching rule is recorded as fired, later overlapping rules are not', () => {
      const issues = [issue({ check: 'paths', message: 'release.yml not found' })];
      const rules: IgnoreRule[] = [
        { check: 'paths', match: 'release', reason: 'first' },
        { check: 'paths', match: '\\.yml', reason: 'second (would also match)' },
      ];
      const result = applyIgnoreRules(issues, rules);
      expect(result.dropped).toBe(1);
      // Only the second rule should appear in unusedRules.
      expect(result.unusedRules).toHaveLength(1);
      expect(result.unusedRules[0].reason).toBe('second (would also match)');
    });
  });

  describe('drift report', () => {
    it('reports unusedRules for rules that never fired', () => {
      const issues = [issue({ check: 'paths', message: 'real bug' })];
      const rules: IgnoreRule[] = [
        { check: 'commands', reason: 'never matches' },
        { check: 'paths', match: 'will-not-match', reason: 'also never' },
      ];
      const result = applyIgnoreRules(issues, rules);
      expect(result.dropped).toBe(0);
      expect(result.unusedRules).toHaveLength(2);
      expect(result.unusedRules.map((r) => r.check)).toEqual(['commands', 'paths']);
    });

    it('unusedRules entries reproduce the original string patterns (not compiled regexes)', () => {
      const issues: LintIssue[] = [];
      const rules: IgnoreRule[] = [
        { check: 'paths', match: 'foo.*bar', pathPattern: '^/x', reason: 'r' },
      ];
      const result = applyIgnoreRules(issues, rules);
      expect(result.unusedRules[0].match).toBe('foo.*bar');
      expect(result.unusedRules[0].pathPattern).toBe('^/x');
      expect(result.unusedRules[0].reason).toBe('r');
    });

    it('reports rulesMissingReason for rules without a reason field', () => {
      const rules: IgnoreRule[] = [
        { check: 'paths', reason: 'documented' },
        { check: 'commands' },
        { check: 'staleness', match: 'x' },
      ];
      const result = applyIgnoreRules([], rules);
      expect(result.rulesMissingReason).toHaveLength(2);
      expect(result.rulesMissingReason.map((r) => r.check)).toEqual(['commands', 'staleness']);
    });

    it('empty inputs produce a zero-drop empty report', () => {
      const result = applyIgnoreRules([], []);
      expect(result).toEqual({
        kept: [],
        keepMask: [],
        dropped: 0,
        unusedRules: [],
        rulesMissingReason: [],
      });
    });
  });

  describe('keepMask', () => {
    it('returns a mask aligned 1:1 with input order (true = kept, false = dropped)', () => {
      const issues = [
        issue({ check: 'paths', message: 'a' }),
        issue({ check: 'commands', message: 'b' }),
        issue({ check: 'paths', message: 'c' }),
      ];
      const result = applyIgnoreRules(issues, [{ check: 'paths' }]);
      expect(result.keepMask).toEqual([false, true, false]);
      // The mask lets a caller partition the ORIGINAL array by index without
      // relying on object identity between `issues` and `kept`.
      const keptByIndex = issues.filter((_, i) => result.keepMask[i]);
      expect(keptByIndex).toEqual(result.kept);
    });

    it('keepMask is all-true when no rule matches', () => {
      const issues = [
        issue({ check: 'paths', message: 'x' }),
        issue({ check: 'tokens', message: 'y' }),
      ];
      const result = applyIgnoreRules(issues, [{ check: 'commands' }]);
      expect(result.keepMask).toEqual([true, true]);
    });

    it('distinguishes structurally-identical issues by position, not identity', () => {
      // Two findings with the SAME check/line/message but distinct objects.
      // An object-identity Set would treat them the same; the index-aligned
      // mask keeps them independent.
      const a = issue({ check: 'paths', message: 'dup', line: 5 });
      const b = issue({ check: 'paths', message: 'dup', line: 5 });
      const result = applyIgnoreRules([a, b], [{ check: 'paths', match: 'nope' }]);
      // Neither dropped (match doesn't fire); both kept, both true.
      expect(result.keepMask).toEqual([true, true]);
      expect(result.kept).toHaveLength(2);
    });
  });
});
