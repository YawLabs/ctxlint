import { describe, expect, it, vi } from 'vitest';
import { collectSuppressions, isSuppressed } from '../suppressions.js';

describe('collectSuppressions', () => {
  it('returns an empty map for content with no directives', () => {
    expect(collectSuppressions('# doc\nsome prose\n').size).toBe(0);
  });

  it('targets the NEXT line for ignore-next-line', () => {
    // Directive on line 1 -> suppresses line 2.
    const s = collectSuppressions('<!-- ctxlint-ignore-next-line -->\nsrc/missing\n');
    expect(s.has(2)).toBe(true);
    expect(s.has(1)).toBe(false);
  });

  it('targets the SAME line for ignore-line', () => {
    const s = collectSuppressions('src/missing <!-- ctxlint-ignore-line -->\n');
    expect(s.has(1)).toBe(true);
  });

  it('a bare directive suppresses all checks (null)', () => {
    const s = collectSuppressions('<!-- ctxlint-ignore-next-line -->\nx\n');
    expect(s.get(2)).toBeNull();
  });

  it('records named checks as a set', () => {
    const s = collectSuppressions('<!-- ctxlint-ignore-next-line paths tokens -->\nx\n');
    expect(s.get(2)).toEqual(new Set(['paths', 'tokens']));
  });

  it('a bare directive beats a targeted one on the same line', () => {
    // Broader intent wins, in either order.
    const a = collectSuppressions(
      '<!-- ctxlint-ignore-next-line paths --><!-- ctxlint-ignore-next-line -->\nx\n',
    );
    expect(a.get(2)).toBeNull();
    const b = collectSuppressions(
      '<!-- ctxlint-ignore-next-line --><!-- ctxlint-ignore-next-line paths -->\nx\n',
    );
    expect(b.get(2)).toBeNull();
  });

  it('ignores directive-like text that is not an HTML comment', () => {
    // Prose ABOUT the feature must not silence anything.
    const s = collectSuppressions('Use ctxlint-ignore-next-line to suppress a finding.\n');
    expect(s.size).toBe(0);
  });
});

describe('isSuppressed', () => {
  const all = collectSuppressions('<!-- ctxlint-ignore-next-line -->\nx\n');
  const onlyPaths = collectSuppressions('<!-- ctxlint-ignore-next-line paths -->\nx\n');

  it('is false when nothing is suppressed', () => {
    expect(isSuppressed(new Map(), { line: 2, check: 'paths' })).toBe(false);
  });

  it('a bare directive suppresses any check on that line', () => {
    expect(isSuppressed(all, { line: 2, check: 'paths' })).toBe(true);
    expect(isSuppressed(all, { line: 2, check: 'tokens' })).toBe(true);
  });

  it('a targeted directive suppresses ONLY the named check', () => {
    expect(isSuppressed(onlyPaths, { line: 2, check: 'paths' })).toBe(true);
    // Mis-targeting must not silence a different check -- otherwise a typo in
    // the check name would quietly disable more than the author intended.
    expect(isSuppressed(onlyPaths, { line: 2, check: 'tokens' })).toBe(false);
  });

  it('does not leak to neighbouring lines', () => {
    expect(isSuppressed(all, { line: 1, check: 'paths' })).toBe(false);
    expect(isSuppressed(all, { line: 3, check: 'paths' })).toBe(false);
  });
});

describe('rule-ID directives', () => {
  const byRule = collectSuppressions('<!-- ctxlint-ignore-next-line paths/file-not-found -->\nx\n');

  it('parses a rule ID containing a slash', () => {
    expect(byRule.get(2)).toEqual(new Set(['paths/file-not-found']));
  });

  it('a rule-ID directive suppresses only that rule', () => {
    expect(isSuppressed(byRule, { line: 2, check: 'paths', ruleId: 'paths/file-not-found' })).toBe(
      true,
    );
    expect(
      isSuppressed(byRule, { line: 2, check: 'paths', ruleId: 'paths/directory-not-found' }),
    ).toBe(false);
  });

  it('a check-name directive matches the ruleId prefix too', () => {
    const s = collectSuppressions('<!-- ctxlint-ignore-line paths -->');
    expect(isSuppressed(s, { line: 1, check: 'paths', ruleId: 'paths/file-not-found' })).toBe(true);
    // An issue whose `check` differs but whose ruleId prefix matches.
    expect(isSuppressed(s, { line: 1, check: 'other', ruleId: 'paths/x' })).toBe(true);
    expect(isSuppressed(s, { line: 1, check: 'tokens', ruleId: 'tokens/info' })).toBe(false);
  });
});

describe('directives in code', () => {
  it('ignores a directive inside a fenced example', () => {
    // Documenting the syntax in a fence must not suppress the line after it.
    const s = collectSuppressions(
      'Example:\n```md\n<!-- ctxlint-ignore-next-line -->\n```\nsrc/missing.ts\n',
    );
    expect(s.size).toBe(0);
  });

  it('ignores a directive quoted inside an inline code span', () => {
    const s = collectSuppressions('Write `<!-- ctxlint-ignore-line -->` to silence a line.\n');
    expect(s.size).toBe(0);
  });

  it('still honours a directive after a closed fence', () => {
    const s = collectSuppressions('```\ncode\n```\n<!-- ctxlint-ignore-next-line -->\nx\n');
    expect(s.get(5)).toBeNull();
  });
});

describe('malformed directives', () => {
  it('warns on stderr for a directive-shaped comment that does not parse', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const s = collectSuppressions(
        'a\n<!-- ctxlint-ignore-next-line paths, tokens -->\n<!-- ctxlint-disable -->\nx\n',
        'CLAUDE.md',
      );
      expect(s.size).toBe(0);
      const messages = warn.mock.calls.map((args) => args.join(' ')).join('\n');
      expect(messages).toContain('CLAUDE.md:2');
      expect(messages).toContain('CLAUDE.md:3');
      expect(messages).toContain('ctxlint-disable');
    } finally {
      warn.mockRestore();
    }
  });

  it('does not warn for well-formed directives or unrelated comments', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      collectSuppressions('<!-- ctxlint-ignore-line paths/file-not-found -->\n<!-- note -->\n');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
