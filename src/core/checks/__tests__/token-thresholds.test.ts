import { describe, it, expect, afterEach } from 'vitest';
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
    setTokenThresholds({ warning: 200 });
    const issues = await checkTokens(makeParsedFile(250), '/test');
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
  });

  it('uses custom error threshold', async () => {
    setTokenThresholds({ error: 500 });
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
});
