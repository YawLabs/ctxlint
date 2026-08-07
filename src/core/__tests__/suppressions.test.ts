import { describe, expect, it } from 'vitest';
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
