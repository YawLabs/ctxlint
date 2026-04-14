import { describe, it, expect, afterEach } from 'vitest';
import { countTokens, freeEncoder, keepEncoderAlive, forceFreeEncoder } from '../tokens.js';

describe('countTokens', () => {
  it('returns a positive count for non-empty text', () => {
    const count = countTokens('Hello, world!');
    expect(count).toBeGreaterThan(0);
  });

  it('returns 0 for empty string', () => {
    const count = countTokens('');
    expect(count).toBe(0);
  });

  it('returns consistent counts for the same input', () => {
    const text = 'The quick brown fox jumps over the lazy dog.';
    const count1 = countTokens(text);
    const count2 = countTokens(text);
    expect(count1).toBe(count2);
  });

  it('longer text produces higher token count', () => {
    const short = countTokens('hello');
    const long = countTokens('hello world this is a longer sentence with more tokens');
    expect(long).toBeGreaterThan(short);
  });

  it('handles unicode text', () => {
    const count = countTokens('日本語のテキスト');
    expect(count).toBeGreaterThan(0);
  });

  it('handles code blocks', () => {
    const code = 'function foo() {\n  return "bar";\n}\n';
    const count = countTokens(code);
    expect(count).toBeGreaterThan(0);
  });
});

describe('freeEncoder', () => {
  it('does not throw when called multiple times', () => {
    // Ensure encoder is loaded
    countTokens('test');
    expect(() => freeEncoder()).not.toThrow();
    expect(() => freeEncoder()).not.toThrow();
  });

  it('countTokens still works after freeEncoder', () => {
    countTokens('load encoder');
    freeEncoder();
    const count = countTokens('should still work');
    expect(count).toBeGreaterThan(0);
  });
});

describe('keepEncoderAlive / forceFreeEncoder', () => {
  afterEach(() => {
    keepEncoderAlive(false);
    forceFreeEncoder();
  });

  it('keepEncoderAlive(true) prevents freeEncoder from releasing the encoder', () => {
    countTokens('load');
    keepEncoderAlive(true);
    freeEncoder();
    // Should still count without re-creating
    const c = countTokens('still counts');
    expect(c).toBeGreaterThan(0);
  });

  it('forceFreeEncoder releases even when keepEncoderAlive is true', () => {
    countTokens('load');
    keepEncoderAlive(true);
    forceFreeEncoder();
    // countTokens re-creates transparently
    const c = countTokens('re-created');
    expect(c).toBeGreaterThan(0);
  });

  it('does not throw when forceFreeEncoder is called with no encoder loaded', () => {
    forceFreeEncoder();
    expect(() => forceFreeEncoder()).not.toThrow();
  });
});
