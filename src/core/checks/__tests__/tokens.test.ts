import { describe, it, expect } from 'vitest';
import { checkTokens, checkAggregateTokens, DEFAULT_TOKEN_THRESHOLDS } from '../tokens.js';
import { makeParsedFile } from './token-fixtures.js';

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

  // Each tier is inclusive at its threshold (`>=`) and silent one token below.
  it.each([
    [DEFAULT_TOKEN_THRESHOLDS.info - 1, null],
    [DEFAULT_TOKEN_THRESHOLDS.info, 'tokens/info'],
    [DEFAULT_TOKEN_THRESHOLDS.warning - 1, 'tokens/info'],
    [DEFAULT_TOKEN_THRESHOLDS.warning, 'tokens/large'],
    [DEFAULT_TOKEN_THRESHOLDS.error - 1, 'tokens/large'],
    [DEFAULT_TOKEN_THRESHOLDS.error, 'tokens/excessive'],
  ])('per-file boundary: %i tokens -> %s', async (tokens, ruleId) => {
    const issues = await checkTokens(makeParsedFile(tokens), '/test');
    expect(issues.map((i) => i.ruleId)).toEqual(ruleId ? [ruleId] : []);
  });

  it('formats counts with a fixed en-US grouping regardless of host locale', async () => {
    const issues = await checkTokens(makeParsedFile(12345), '/test');
    expect(issues[0].message).toContain('12,345 tokens');
  });

  it('does not cite an unsourced research claim in the warning suggestion', async () => {
    const issues = await checkTokens(makeParsedFile(3500), '/test');
    expect(issues[0].suggestion).not.toMatch(/research/i);
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

  it('warns when combined tokens land exactly on the threshold', () => {
    const issue = checkAggregateTokens([
      { path: 'CLAUDE.md', tokens: 2500 },
      { path: 'AGENTS.md', tokens: 2500 },
    ]);
    expect(issue).not.toBeNull();
    expect(issue!.severity).toBe('warning');
  });

  it('stays silent one token under the threshold', () => {
    const issue = checkAggregateTokens([
      { path: 'CLAUDE.md', tokens: 2500 },
      { path: 'AGENTS.md', tokens: 2499 },
    ]);
    expect(issue).toBeNull();
  });

  it('counts a symlink to another counted file once', () => {
    // AGENTS.md -> CLAUDE.md is one file's content loaded under two names; the
    // aggregate must not double it (3000 + 3000 would cross 5000).
    const issue = checkAggregateTokens([
      { path: 'CLAUDE.md', tokens: 3000 },
      { path: 'AGENTS.md', tokens: 3000, isSymlink: true, symlinkTarget: 'CLAUDE.md' },
    ]);
    expect(issue).toBeNull();
  });

  it('resolves a symlink target relative to the link directory', () => {
    const issue = checkAggregateTokens([
      { path: 'CLAUDE.md', tokens: 3000 },
      {
        path: '.github/copilot-instructions.md',
        tokens: 3000,
        isSymlink: true,
        symlinkTarget: '../CLAUDE.md',
      },
      { path: 'docs/AGENTS.md', tokens: 1000 },
    ]);
    // 3000 + 1000 -- the symlink is dropped, so the total stays under 5000.
    expect(issue).toBeNull();
  });

  it('still counts a symlink whose target is not in the counted set', () => {
    const issue = checkAggregateTokens([
      { path: 'CLAUDE.md', tokens: 3000 },
      { path: 'AGENTS.md', tokens: 3000, isSymlink: true, symlinkTarget: 'docs/elsewhere.md' },
    ]);
    expect(issue).not.toBeNull();
    expect(issue!.message).toContain('6,000 tokens');
  });
});
