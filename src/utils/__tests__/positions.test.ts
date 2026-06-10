import { describe, it, expect } from 'vitest';
import { offsetToPosition } from '../positions.js';

describe('offsetToPosition', () => {
  it('returns 1,1 for offset 0', () => {
    expect(offsetToPosition('hello', 0)).toEqual({ line: 1, column: 1 });
  });

  it('returns 1,1 for empty content', () => {
    expect(offsetToPosition('', 0)).toEqual({ line: 1, column: 1 });
    expect(offsetToPosition('', 5)).toEqual({ line: 1, column: 1 });
  });

  it('maps a mid-line offset to a 1-based column', () => {
    expect(offsetToPosition('hello', 3)).toEqual({ line: 1, column: 4 });
  });

  it('starts a new line at column 1 after a \\n', () => {
    expect(offsetToPosition('ab\ncd', 3)).toEqual({ line: 2, column: 1 });
    expect(offsetToPosition('ab\ncd', 4)).toEqual({ line: 2, column: 2 });
  });

  it('positions an offset pointing AT the \\n as the last column of its line', () => {
    expect(offsetToPosition('ab\ncd', 2)).toEqual({ line: 1, column: 3 });
  });

  it('clamps offsets past content.length to the position after the last char', () => {
    expect(offsetToPosition('ab', 99)).toEqual({ line: 1, column: 3 });
    expect(offsetToPosition('a\nb', 99)).toEqual({ line: 2, column: 2 });
  });

  it('counts the \\r of a CRLF pair toward the column; only \\n breaks lines', () => {
    // Offset of 'b' in 'a\r\nb' -- the \n resets the column, so CRLF and LF
    // content agree on positions AFTER the line break.
    expect(offsetToPosition('a\r\nb', 3)).toEqual({ line: 2, column: 1 });
    // An offset pointing at the \n itself sees the \r occupying a column.
    expect(offsetToPosition('a\r\nb', 2)).toEqual({ line: 1, column: 3 });
  });

  it('handles multiple consecutive newlines', () => {
    expect(offsetToPosition('a\n\n\nb', 4)).toEqual({ line: 4, column: 1 });
  });

  it('treats a negative offset as 0', () => {
    expect(offsetToPosition('abc', -5)).toEqual({ line: 1, column: 1 });
  });
});
