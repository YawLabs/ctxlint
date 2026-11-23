import { describe, it, expect, vi } from 'vitest';
import {
  checkTokens,
  checkAggregateTokens,
  resolveTokenThresholds,
  DEFAULT_TOKEN_THRESHOLDS,
} from '../tokens.js';
import { makeParsedFile } from './token-fixtures.js';

describe('custom token thresholds', () => {
  it('uses custom info threshold', async () => {
    const thresholds = resolveTokenThresholds({ info: 100 });
    const issues = await checkTokens(makeParsedFile(150), '/test', thresholds);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('info');
  });

  it('uses custom warning threshold', async () => {
    const thresholds = resolveTokenThresholds({ info: 100, warning: 200 });
    const issues = await checkTokens(makeParsedFile(250), '/test', thresholds);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
  });

  it('uses custom error threshold', async () => {
    const thresholds = resolveTokenThresholds({ info: 100, warning: 300, error: 500 });
    const issues = await checkTokens(makeParsedFile(600), '/test', thresholds);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
  });

  it('uses custom aggregate threshold', () => {
    const thresholds = resolveTokenThresholds({ aggregate: 200 });
    const issue = checkAggregateTokens(
      [
        { path: 'a.md', tokens: 150 },
        { path: 'b.md', tokens: 150 },
      ],
      thresholds,
    );
    expect(issue).not.toBeNull();
    expect(issue!.severity).toBe('warning');
  });

  it('omitted thresholds argument uses defaults', async () => {
    // With the default info=1000, 50 tokens should produce no issues. This
    // exercises the parameter default (no thresholds arg passed at all).
    const issues = await checkTokens(makeParsedFile(50), '/test');
    expect(issues).toHaveLength(0);
  });

  it('partial override preserves other defaults', async () => {
    const thresholds = resolveTokenThresholds({ info: 10 });
    // error threshold should still be 8000 (default)
    const issues = await checkTokens(makeParsedFile(7000), '/test', thresholds);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning'); // hits 3000 warning, not 8000 error
  });

  it('rejects invalid threshold order (info >= warning) and falls back to defaults', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // info >= warning is invalid — resolveTokenThresholds returns defaults
      // and logs a warning on stderr.
      const thresholds = resolveTokenThresholds({ info: 5000, warning: 2000 });
      expect(errSpy).toHaveBeenCalled();
      const msg = errSpy.mock.calls.map((args) => args.join(' ')).join('\n');
      expect(msg).toContain('token thresholds should satisfy');
      // The returned object is the default set.
      expect(thresholds).toBe(DEFAULT_TOKEN_THRESHOLDS);
      // Defaults (info=1000, warning=3000) should still be in effect.
      const issues = await checkTokens(makeParsedFile(4000), '/test', thresholds);
      expect(issues[0].severity).toBe('warning');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('rejects invalid threshold order (warning >= error) and falls back to defaults', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const thresholds = resolveTokenThresholds({ warning: 8000, error: 5000 });
      expect(errSpy).toHaveBeenCalled();
      expect(thresholds).toBe(DEFAULT_TOKEN_THRESHOLDS);
      const issues = await checkTokens(makeParsedFile(9000), '/test', thresholds);
      // Defaults (error=8000) should apply — 9000 hits error.
      expect(issues[0].severity).toBe('error');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('resolveTokenThresholds with no overrides returns the canonical default object', () => {
    expect(resolveTokenThresholds()).toBe(DEFAULT_TOKEN_THRESHOLDS);
    expect(resolveTokenThresholds(undefined)).toBe(DEFAULT_TOKEN_THRESHOLDS);
  });

  it('uses a custom per-file boundary inclusively', async () => {
    const thresholds = resolveTokenThresholds({ info: 100, warning: 200, error: 300 });
    expect(await checkTokens(makeParsedFile(99), '/test', thresholds)).toHaveLength(0);
    expect((await checkTokens(makeParsedFile(100), '/test', thresholds))[0].ruleId).toBe(
      'tokens/info',
    );
    expect((await checkTokens(makeParsedFile(199), '/test', thresholds))[0].ruleId).toBe(
      'tokens/info',
    );
    expect((await checkTokens(makeParsedFile(200), '/test', thresholds))[0].ruleId).toBe(
      'tokens/large',
    );
    expect((await checkTokens(makeParsedFile(299), '/test', thresholds))[0].ruleId).toBe(
      'tokens/large',
    );
    expect((await checkTokens(makeParsedFile(300), '/test', thresholds))[0].ruleId).toBe(
      'tokens/excessive',
    );
  });
});

describe('per-key threshold validation', () => {
  function capture(fn: () => void): string {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      fn();
      return errSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    } finally {
      errSpy.mockRestore();
    }
  }

  it.each([
    ['a string', '2000'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['null', null],
    ['a negative number', -5],
  ])('rejects %s for one key with a key-specific message and keeps the rest', (_label, bad) => {
    let thresholds = DEFAULT_TOKEN_THRESHOLDS;
    const msg = capture(() => {
      thresholds = resolveTokenThresholds({
        info: 100,
        warning: bad as unknown as number,
      });
    });
    expect(msg).toContain('"warning" must be a finite non-negative number');
    expect(msg).not.toContain('should satisfy');
    // The good key survives; only the bad key reverts to its default.
    expect(thresholds.info).toBe(100);
    expect(thresholds.warning).toBe(DEFAULT_TOKEN_THRESHOLDS.warning);
  });

  it.each(['aggregate', 'tierBreakdown', 'tierAggregate'] as const)(
    'validates the %s key too',
    (key) => {
      let thresholds = DEFAULT_TOKEN_THRESHOLDS;
      const msg = capture(() => {
        thresholds = resolveTokenThresholds({ [key]: 'big' as unknown as number });
      });
      expect(msg).toContain(`"${key}" must be a finite non-negative number`);
      expect(thresholds[key]).toBe(DEFAULT_TOKEN_THRESHOLDS[key]);
    },
  );

  it('accepts zero as a valid threshold', () => {
    const msg = capture(() => {
      expect(resolveTokenThresholds({ aggregate: 0 }).aggregate).toBe(0);
    });
    expect(msg).toBe('');
  });

  it('treats an explicitly undefined key as not supplied', () => {
    const msg = capture(() => {
      expect(resolveTokenThresholds({ info: undefined }).info).toBe(DEFAULT_TOKEN_THRESHOLDS.info);
    });
    expect(msg).toBe('');
  });
});
