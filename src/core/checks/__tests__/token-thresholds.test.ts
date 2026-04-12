import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  checkTokens,
  checkAggregateTokens,
  setTokenThresholds,
  resetTokenThresholds,
} from '../tokens.js';
import type { ParsedContextFile } from '../../types.js';

afterEach(() => {
  resetTokenThresholds();
});

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
    setTokenThresholds({ info: 100 });
    const issues = await checkTokens(makeParsedFile(150), '/test');
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('info');
  });

  it('uses custom warning threshold', async () => {
    setTokenThresholds({ info: 100, warning: 200 });
    const issues = await checkTokens(makeParsedFile(250), '/test');
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
  });

  it('uses custom error threshold', async () => {
    setTokenThresholds({ info: 100, warning: 300, error: 500 });
    const issues = await checkTokens(makeParsedFile(600), '/test');
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
  });

  it('uses custom aggregate threshold', () => {
    setTokenThresholds({ aggregate: 200 });
    const issue = checkAggregateTokens([
      { path: 'a.md', tokens: 150 },
      { path: 'b.md', tokens: 150 },
    ]);
    expect(issue).not.toBeNull();
    expect(issue!.severity).toBe('warning');
  });

  it('resets to defaults', async () => {
    setTokenThresholds({ info: 1 });
    resetTokenThresholds();
    // With default threshold of 1000, 50 tokens should produce no issues
    const issues = await checkTokens(makeParsedFile(50), '/test');
    expect(issues).toHaveLength(0);
  });

  it('partial override preserves other defaults', async () => {
    setTokenThresholds({ info: 10 });
    // error threshold should still be 8000 (default)
    const issues = await checkTokens(makeParsedFile(7000), '/test');
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning'); // hits 3000 warning, not 8000 error
  });

  it('rejects invalid threshold order (info >= warning) and falls back to defaults', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // info >= warning is invalid — should warn and not apply.
      setTokenThresholds({ info: 5000, warning: 2000 });
      expect(errSpy).toHaveBeenCalled();
      const msg = errSpy.mock.calls.map((args) => args.join(' ')).join('\n');
      expect(msg).toContain('token thresholds should satisfy');
      // Defaults (info=1000, warning=3000) should still be in effect.
      const issues = await checkTokens(makeParsedFile(4000), '/test');
      expect(issues[0].severity).toBe('warning');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('rejects invalid threshold order (warning >= error) and falls back to defaults', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      setTokenThresholds({ warning: 8000, error: 5000 });
      expect(errSpy).toHaveBeenCalled();
      const issues = await checkTokens(makeParsedFile(9000), '/test');
      // Defaults (error=8000) should apply — 9000 hits error.
      expect(issues[0].severity).toBe('error');
    } finally {
      errSpy.mockRestore();
    }
  });
});
