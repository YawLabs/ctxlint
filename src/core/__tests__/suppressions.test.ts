import { describe, expect, it, vi } from 'vitest';
import contextCatalog from '../../../context-lint-rules.json' with { type: 'json' };
import { SUPPRESSIBLE_RULE_IDS, collectSuppressions, isSuppressed } from '../suppressions.js';

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
  const byRule = collectSuppressions('<!-- ctxlint-ignore-next-line paths/not-found -->\nx\n');

  it('parses a rule ID containing a slash', () => {
    expect(byRule.get(2)).toEqual(new Set(['paths/not-found']));
  });

  it('a rule-ID directive suppresses only that rule', () => {
    expect(isSuppressed(byRule, { line: 2, check: 'paths', ruleId: 'paths/not-found' })).toBe(true);
    expect(
      isSuppressed(byRule, { line: 2, check: 'paths', ruleId: 'paths/directory-not-found' }),
    ).toBe(false);
  });

  it('a check-name directive matches the ruleId prefix too', () => {
    const s = collectSuppressions('<!-- ctxlint-ignore-line paths -->');
    expect(isSuppressed(s, { line: 1, check: 'paths', ruleId: 'paths/not-found' })).toBe(true);
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
      collectSuppressions('<!-- ctxlint-ignore-line paths/not-found -->\n<!-- note -->\n');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('unknown rule-ID targets', () => {
  it('warns on stderr when a slash-form target names no known rule ID', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      collectSuppressions(
        'a\n<!-- ctxlint-ignore-next-line paths/file-not-found -->\nx\n',
        'CLAUDE.md',
      );
      const messages = warn.mock.calls.map((args) => args.join(' ')).join('\n');
      expect(messages).toContain('CLAUDE.md:2');
      expect(messages).toContain('paths/file-not-found');
      expect(messages).toContain('unknown or a cross-file rule');
    } finally {
      warn.mockRestore();
    }
  });

  it('does not warn for known rule IDs or bare check names', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      collectSuppressions(
        [
          '<!-- ctxlint-ignore-line paths/not-found -->',
          '<!-- ctxlint-ignore-line paths/directory-not-found paths/glob-no-match -->',
          '<!-- ctxlint-ignore-line content-secrets/github-pat tokens/info -->',
          '<!-- ctxlint-ignore-line paths tokens -->',
        ].join('\n'),
      );
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('every rule ID the single-file checks emit is in the known set', () => {
    // A target naming a real rule must never draw the "unknown" warning.
    for (const id of [
      'paths/not-found',
      'paths/glob-no-match',
      'paths/directory-not-found',
      'commands/script-not-found',
      'staleness/stale',
      'tokens/excessive',
      'tier-tokens/section-breakdown',
      'redundancy/tech-mention',
      'frontmatter/missing-field',
      'content-secrets/private-key-header',
    ]) {
      expect(SUPPRESSIBLE_RULE_IDS.has(id)).toBe(true);
    }
    expect(SUPPRESSIBLE_RULE_IDS.has('paths/file-not-found')).toBe(false);
  });

  // Rules emitted outside runSingleFileChecks (audit.ts), where directives
  // are never consulted.
  const CROSS_FILE_RULE_IDS = new Set([
    'tokens/aggregate',
    'tier-tokens/aggregate',
    'redundancy/duplicate-content',
    'contradictions/conflict',
    'ci/no-release-docs',
    'ci/undocumented-secret',
    'hook-coverage/dead-hook',
  ]);

  it('matches the context catalog: every entry is catalogued, every single-file rule is listed', () => {
    const catalogIds = contextCatalog.rules.map((r: { id: string }) => r.id);
    for (const id of SUPPRESSIBLE_RULE_IDS) expect(catalogIds).toContain(id);
    const expected = catalogIds.filter((id: string) => !CROSS_FILE_RULE_IDS.has(id)).sort();
    expect([...SUPPRESSIBLE_RULE_IDS].sort()).toEqual(expected);
  });

  it('warns for a cross-file rule ID, which an inline directive cannot suppress', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      collectSuppressions(
        '<!-- ctxlint-ignore-next-line ci-secrets/undocumented-secret tokens/aggregate -->\nx\n',
        'CLAUDE.md',
      );
      const messages = warn.mock.calls.map((args) => args.join(' ')).join('\n');
      expect(messages).toContain('"ci-secrets/undocumented-secret"');
      expect(messages).toContain('"tokens/aggregate"');
      expect(messages).toContain('cannot be suppressed inline');
    } finally {
      warn.mockRestore();
    }
  });

  it('still records the unknown target (warning only, no behaviour change)', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const s = collectSuppressions('<!-- ctxlint-ignore-next-line paths/nope -->\nx\n');
      expect(s.get(2)).toEqual(new Set(['paths/nope']));
    } finally {
      warn.mockRestore();
    }
  });
});
