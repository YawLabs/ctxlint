import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { parseContextFile } from '../../parser.js';
import { checkCommands } from '../commands.js';
import type { DiscoveredFile } from '../../scanner.js';

const FIXTURES = path.resolve(__dirname, '../../../../fixtures');

function makeDiscovered(fixtureName: string, fileName: string): DiscoveredFile {
  return {
    absolutePath: path.join(FIXTURES, fixtureName, fileName),
    relativePath: fileName,
    isSymlink: false,
  };
}

describe('checkCommands', () => {
  it('reports missing npm scripts', async () => {
    const parsed = parseContextFile(makeDiscovered('wrong-commands', 'AGENTS.md'));
    const projectRoot = path.join(FIXTURES, 'wrong-commands');
    const issues = await checkCommands(parsed, projectRoot);

    const messages = issues.map((i) => i.message);
    // "pnpm test" — script "test" not in package.json
    expect(messages.some((m) => m.includes('"test"') && m.includes('not found'))).toBe(true);
  });

  it('reports missing deploy script', async () => {
    const parsed = parseContextFile(makeDiscovered('wrong-commands', 'AGENTS.md'));
    const projectRoot = path.join(FIXTURES, 'wrong-commands');
    const issues = await checkCommands(parsed, projectRoot);

    const messages = issues.map((i) => i.message);
    expect(messages.some((m) => m.includes('"deploy"'))).toBe(true);
  });

  it('reports no issues for healthy project', async () => {
    const parsed = parseContextFile(makeDiscovered('healthy-project', 'CLAUDE.md'));
    const projectRoot = path.join(FIXTURES, 'healthy-project');
    const issues = await checkCommands(parsed, projectRoot);
    expect(issues.length).toBe(0);
  });
});
