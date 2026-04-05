import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { parseContextFile } from '../../parser.js';
import { checkRedundancy, checkDuplicateContent } from '../redundancy.js';
import type { DiscoveredFile } from '../../scanner.js';

const FIXTURES = path.resolve(__dirname, '../../../../fixtures');

function makeDiscovered(fixtureName: string, fileName: string): DiscoveredFile {
  return {
    absolutePath: path.join(FIXTURES, fixtureName, fileName),
    relativePath: fileName,
    isSymlink: false,
  };
}

describe('checkRedundancy', () => {
  it('flags technology mentions already in package.json', async () => {
    const parsed = parseContextFile(makeDiscovered('redundant-content', 'CLAUDE.md'));
    const projectRoot = path.join(FIXTURES, 'redundant-content');
    const issues = await checkRedundancy(parsed, projectRoot);

    const messages = issues.map((i) => i.message);
    expect(messages.some((m) => m.includes('React'))).toBe(true);
    expect(messages.some((m) => m.includes('Express') || m.includes('TypeScript'))).toBe(true);
  });

  it('flags discoverable directory structure', async () => {
    const parsed = parseContextFile(makeDiscovered('redundant-content', 'CLAUDE.md'));
    const projectRoot = path.join(FIXTURES, 'redundant-content');
    const issues = await checkRedundancy(parsed, projectRoot);

    const messages = issues.map((i) => i.message);
    expect(messages.some((m) => m.includes('src/components/'))).toBe(true);
  });
});

describe('checkDuplicateContent', () => {
  it('flags high overlap between files', () => {
    const file1 = parseContextFile(makeDiscovered('multiple-files', 'CLAUDE.md'));
    const file2 = parseContextFile(makeDiscovered('multiple-files', 'AGENTS.md'));
    const issues = checkDuplicateContent([file1, file2]);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].message).toContain('overlap');
  });
});
