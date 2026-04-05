import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { parseContextFile } from '../parser.js';
import type { DiscoveredFile } from '../scanner.js';

const FIXTURES = path.resolve(__dirname, '../../../fixtures');

function makeDiscovered(fixtureName: string, fileName: string): DiscoveredFile {
  return {
    absolutePath: path.join(FIXTURES, fixtureName, fileName),
    relativePath: fileName,
    isSymlink: false,
  };
}

describe('parser', () => {
  it('extracts path references', () => {
    const result = parseContextFile(makeDiscovered('broken-paths', 'CLAUDE.md'));
    const paths = result.references.paths.map((p) => p.value);
    expect(paths).toContain('src/auth/middleware.ts');
    expect(paths).toContain('config/database.yml');
    expect(paths).toContain('src/app.ts');
  });

  it('extracts command references', () => {
    const result = parseContextFile(makeDiscovered('wrong-commands', 'AGENTS.md'));
    const commands = result.references.commands.map((c) => c.value);
    expect(commands).toContain('pnpm test');
  });

  it('counts tokens', () => {
    const result = parseContextFile(makeDiscovered('healthy-project', 'CLAUDE.md'));
    expect(result.totalTokens).toBeGreaterThan(0);
    expect(result.totalLines).toBeGreaterThan(0);
  });

  it('parses sections', () => {
    const result = parseContextFile(makeDiscovered('healthy-project', 'CLAUDE.md'));
    expect(result.sections.length).toBeGreaterThan(0);
    expect(result.sections[0].title).toBe('Project');
  });

  it('skips URLs', () => {
    const result = parseContextFile(makeDiscovered('healthy-project', 'CLAUDE.md'));
    const paths = result.references.paths.map((p) => p.value);
    for (const p of paths) {
      expect(p).not.toMatch(/^https?:\/\//);
    }
  });
});
