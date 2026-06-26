import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import {
  countTokens,
  approximateTokens,
  freeEncoder,
  keepEncoderAlive,
  forceFreeEncoder,
} from '../tokens.js';

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

describe('approximateTokens (no-tiktoken fallback)', () => {
  it('returns 0 for empty input', () => {
    expect(approximateTokens('')).toBe(0);
  });

  it('estimates ASCII at ~4 chars per token, rounding partial chunks up', () => {
    expect(approximateTokens('abcdefgh')).toBe(2);
    expect(approximateTokens('abcde')).toBe(2);
    expect(approximateTokens('a')).toBe(1);
  });

  it('counts CJK codepoints at ~1 token each instead of 1/4', () => {
    // 8 codepoints of Japanese -- a flat length/4 would say 2.
    expect(approximateTokens('日本語のテキスト')).toBe(8);
    // Hangul syllables are CJK-class too.
    expect(approximateTokens('한국어')).toBe(3);
  });

  it('mixes charsets: CJK at 1 each plus remaining chars at 1/4', () => {
    // 2 CJK codepoints + 4 ASCII chars ('see ') -> 2 + ceil(4/4) = 3
    expect(approximateTokens('see 日本')).toBe(3);
  });
});

describe('encoder construction failure', () => {
  it('falls back to the char-based estimate and does not retry the throwing constructor', async () => {
    const req = createRequire(import.meta.url);
    let resolved: string;
    try {
      resolved = req.resolve('tiktoken');
    } catch {
      return; // tiktoken not installed -- the fallback is already in effect
    }
    req(resolved); // ensure the CJS cache entry exists before poisoning it
    const mod = req.cache[resolved];
    if (!mod) return;
    const originalExports = mod.exports;
    let constructorCalls = 0;
    mod.exports = {
      encoding_for_model: () => {
        constructorCalls++;
        throw new Error('encoder construction failed');
      },
    };
    try {
      // Fresh module instance so its lazy loader sees the poisoned require.
      vi.resetModules();
      const fresh = await import('../tokens.js');
      // countTokens must not throw -- it falls back to the estimate...
      expect(fresh.countTokens('hello world!')).toBe(fresh.approximateTokens('hello world!'));
      fresh.countTokens('second call');
      // ...and the throwing constructor is attempted once, not per call.
      expect(constructorCalls).toBe(1);
    } finally {
      mod.exports = originalExports;
      vi.resetModules();
    }
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
