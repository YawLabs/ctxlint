import { describe, it, expect, vi } from 'vitest';
import {
  checkTokens,
  checkAggregateTokens,
  resolveTokenThresholds,
  DEFAULT_TOKEN_THRESHOLDS,
} from '../tokens.js';
import type { ParsedContextFile } from '../../types.js';

function makeParsedFile(tokens: number): ParsedContextFile {
  return {
    filePath: '/test/CLAUDE.md',
    relativePath: 'CLAUDE.md',
    isSymlink: false,
    totalTokens: tokens,
    totalLines: 10,
    content: '',
    sections: [],
    references: { paths: [], commands: [] },
  };
}

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
});
