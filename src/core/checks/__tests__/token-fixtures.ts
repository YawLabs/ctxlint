import type { ParsedContextFile } from '../../types.js';

/**
 * Minimal ParsedContextFile whose only meaningful field is `totalTokens`.
 * Shared by tokens.test.ts and token-thresholds.test.ts.
 */
export function makeParsedFile(tokens: number): ParsedContextFile {
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
