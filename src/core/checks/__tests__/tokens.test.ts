import { describe, it, expect } from 'vitest';
import { checkTokens, checkAggregateTokens } from '../tokens.js';
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

describe('checkTokens', () => {
  it('reports info for files over 1000 tokens', async () => {
    const issues = await checkTokens(makeParsedFile(1200), '/test');
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe('info');
  });

  it('reports warning for files over 3000 tokens', async () => {
    const issues = await checkTokens(makeParsedFile(3500), '/test');
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe('warning');
  });

  it('reports error for files over 8000 tokens', async () => {
    const issues = await checkTokens(makeParsedFile(9000), '/test');
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe('error');
  });

  it('reports nothing for small files', async () => {
    const issues = await checkTokens(makeParsedFile(500), '/test');
    expect(issues.length).toBe(0);
  });
});

describe('checkAggregateTokens', () => {
  it('warns when combined tokens exceed 5000', () => {
    const issue = checkAggregateTokens([
      { path: 'CLAUDE.md', tokens: 3000 },
      { path: 'AGENTS.md', tokens: 3000 },
    ]);
    expect(issue).not.toBeNull();
    expect(issue!.severity).toBe('warning');
  });

  it('returns null for single file', () => {
    const issue = checkAggregateTokens([{ path: 'CLAUDE.md', tokens: 6000 }]);
    expect(issue).toBeNull();
  });
});
