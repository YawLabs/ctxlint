import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { parseContextFile } from '../../parser.js';
import { checkPaths } from '../paths.js';
import type { DiscoveredFile } from '../../scanner.js';

const FIXTURES = path.resolve(__dirname, '../../../../fixtures');

function makeDiscovered(fixtureName: string, fileName: string): DiscoveredFile {
  return {
    absolutePath: path.join(FIXTURES, fixtureName, fileName),
    relativePath: fileName,
    isSymlink: false,
    type: 'context',
  };
}

describe('checkPaths', () => {
  it('reports broken paths', async () => {
    const parsed = parseContextFile(makeDiscovered('broken-paths', 'CLAUDE.md'));
    const projectRoot = path.join(FIXTURES, 'broken-paths');
    const issues = await checkPaths(parsed, projectRoot);

    const messages = issues.map((i) => i.message);
    expect(messages.some((m) => m.includes('src/auth/middleware.ts'))).toBe(true);
    expect(messages.some((m) => m.includes('config/database.yml'))).toBe(true);
  });

  it('does not report valid paths', async () => {
    const parsed = parseContextFile(makeDiscovered('broken-paths', 'CLAUDE.md'));
    const projectRoot = path.join(FIXTURES, 'broken-paths');
    const issues = await checkPaths(parsed, projectRoot);

    // src/app.ts exists, should not be reported
    const messages = issues.map((i) => i.message);
    expect(messages.some((m) => m.includes('src/app.ts'))).toBe(false);
  });

  it('reports no issues for healthy project', async () => {
    const parsed = parseContextFile(makeDiscovered('healthy-project', 'CLAUDE.md'));
    const projectRoot = path.join(FIXTURES, 'healthy-project');
    const issues = await checkPaths(parsed, projectRoot);
    expect(issues.length).toBe(0);
  });
});
