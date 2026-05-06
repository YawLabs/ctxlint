import { describe, it, expect } from 'vitest';
import { jaccardSimilarity } from '../similarity.js';

describe('jaccardSimilarity', () => {
  it('returns 1.0 for identical non-trivial content', () => {
    const text = 'first meaningful line\nsecond meaningful line\nthird meaningful line';
    expect(jaccardSimilarity(text, text)).toBe(1);
  });

  it('returns 0.0 for fully disjoint content', () => {
    const a = 'alpha line one is here\nbravo line two is here\ncharlie line three here';
    const b = 'delta line one is here\necho line two is here\nfoxtrot line three here';
    expect(jaccardSimilarity(a, b)).toBe(0);
  });

  it('computes partial overlap as |A intersect B| / |A union B|', () => {
    // 2 shared lines, 2 unique to each side -> 2 / (2+2+2) = 2/6 = 1/3
    const a = 'shared line one here\nshared line two here\nunique to a number one\nunique to a two';
    const b = 'shared line one here\nshared line two here\nunique to b number one\nunique to b two';
    const overlap = jaccardSimilarity(a, b);
    expect(overlap).toBeCloseTo(2 / 6, 6);
  });

  it('returns 0 for empty inputs by default', () => {
    expect(jaccardSimilarity('', '')).toBe(0);
    expect(jaccardSimilarity('hello world here', '')).toBe(0);
    expect(jaccardSimilarity('', 'hello world here')).toBe(0);
  });

  it('returns 1 for two empty inputs when bothEmptyIsIdentical is true', () => {
    expect(jaccardSimilarity('', '', { bothEmptyIsIdentical: true })).toBe(1);
  });

  it('still returns 0 for one empty side even with bothEmptyIsIdentical', () => {
    expect(jaccardSimilarity('hello world here', '', { bothEmptyIsIdentical: true })).toBe(0);
    expect(jaccardSimilarity('', 'hello world here', { bothEmptyIsIdentical: true })).toBe(0);
  });

  it('filters lines at the minTokenLen threshold (default 5)', () => {
    // Short lines (<= 5 chars) get filtered. With default threshold, only
    // the longer shared line counts. Shared: "long shared line here". Both
    // sides have it -> identity over the surviving set.
    const a = 'ab\ncd\nlong shared line here';
    const b = 'xy\nzw\nlong shared line here';
    expect(jaccardSimilarity(a, b)).toBe(1);
  });

  it('honors a custom minTokenLen', () => {
    // With minTokenLen 10, "short one" (9 chars) is filtered; only the
    // longer line survives on each side, fully shared -> 1.0.
    const a = 'short one\nthis is a much longer shared line';
    const b = 'short two\nthis is a much longer shared line';
    expect(jaccardSimilarity(a, b, { minTokenLen: 10 })).toBe(1);
  });

  it('handles minTokenLen of 0 (no filtering, just empty-string drop)', () => {
    // Lines must have length > 0, so blank lines drop but everything else stays.
    const a = 'a\nb\nc';
    const b = 'a\nb\nd';
    // Sets {a,b,c} and {a,b,d} -> intersect 2, union 4 -> 0.5
    expect(jaccardSimilarity(a, b, { minTokenLen: 0 })).toBeCloseTo(0.5, 6);
  });

  it('handles minTokenLen of 1 (strips single chars)', () => {
    // Lines with length > 1 only. "ab" survives, "a" does not.
    const a = 'a\nab\nabc';
    const b = 'x\nab\nabc';
    // Sets {ab,abc} and {ab,abc} -> identical -> 1.0
    expect(jaccardSimilarity(a, b, { minTokenLen: 1 })).toBe(1);
  });

  it('handles a very large minTokenLen by filtering everything out', () => {
    const a = 'short\nlines\nonly here';
    const b = 'short\nlines\nonly here';
    // Nothing survives the threshold -> both sides empty -> 0 by default.
    expect(jaccardSimilarity(a, b, { minTokenLen: 10000 })).toBe(0);
  });

  it('trims whitespace before comparing', () => {
    const a = '  shared line one here  \n   shared line two here   ';
    const b = 'shared line one here\nshared line two here';
    expect(jaccardSimilarity(a, b)).toBe(1);
  });

  it('deduplicates lines on each side (set semantics)', () => {
    // A has the same line three times; B has it once. Both sets are {x} ->
    // identical -> 1.0, regardless of duplicate counts.
    const a = 'duplicated line here\nduplicated line here\nduplicated line here';
    const b = 'duplicated line here';
    expect(jaccardSimilarity(a, b)).toBe(1);
  });

  it('returns a value in [0, 1] for arbitrary text', () => {
    const a = 'one fish two fish\nred fish blue fish\ngreen eggs and ham';
    const b = 'red fish blue fish\nsam i am\ngreen eggs and ham';
    const v = jaccardSimilarity(a, b);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  });
});
