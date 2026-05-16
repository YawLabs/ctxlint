import { vi, describe, it, expect, beforeEach } from 'vitest';

const { rawMock } = vi.hoisted(() => ({
  rawMock: vi.fn(),
}));

vi.mock('simple-git', () => ({
  default: vi.fn(() => ({ raw: rawMock })),
}));

import { getCommitsSinceBatch, resetGit } from '../git.js';

beforeEach(() => {
  rawMock.mockReset();
  (rawMock as ReturnType<typeof vi.fn>).mockResolvedValue('');
  resetGit();
});

describe('getCommitsSinceBatch', () => {
  it('passes requested paths as -- positional args to git log', async () => {
    await getCommitsSinceBatch('/proj', ['src/foo.ts', 'docs/bar.md'], new Date());

    expect(rawMock).toHaveBeenCalledOnce();
    const args = rawMock.mock.calls[0][0] as string[];
    const sepIdx = args.indexOf('--');
    expect(sepIdx).toBeGreaterThan(-1);
    expect(args.slice(sepIdx + 1)).toEqual(['src/foo.ts', 'docs/bar.md']);
  });

  it('returns zero counts when git returns no output', async () => {
    const result = await getCommitsSinceBatch('/proj', ['src/foo.ts'], new Date());
    expect(result.get('src/foo.ts')).toBe(0);
  });

  it('returns empty map when paths array is empty', async () => {
    const result = await getCommitsSinceBatch('/proj', [], new Date());
    expect(result.size).toBe(0);
    expect(rawMock).not.toHaveBeenCalled();
  });

  it('counts commits per path from sentinel-delimited git output', async () => {
    const SENTINEL = '___CTXLINT_COMMIT___';
    // Simulate two commits: first touches foo.ts, second touches both
    rawMock.mockResolvedValue(
      `\n${SENTINEL}\n\nsrc/foo.ts\n\n${SENTINEL}\n\nsrc/foo.ts\ndocs/bar.md\n`,
    );

    const result = await getCommitsSinceBatch('/proj', ['src/foo.ts', 'docs/bar.md'], new Date());
    expect(result.get('src/foo.ts')).toBe(2);
    expect(result.get('docs/bar.md')).toBe(1);
  });
});
