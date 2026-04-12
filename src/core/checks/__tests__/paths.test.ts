import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseContextFile } from '../../parser.js';
import { checkPaths, resetPathsCache } from '../paths.js';
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

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-paths-'));
  resetPathsCache();
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  resetPathsCache();
});

function seed(files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(tmpRoot, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function discoveredIn(fileName: string): DiscoveredFile {
  return {
    absolutePath: path.join(tmpRoot, fileName),
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

  it('emits paths/glob-no-match for a glob with zero matches', async () => {
    seed({
      'CLAUDE.md': 'See src/*.fakext for config.\n',
      'src/app.ts': 'x',
    });
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkPaths(parsed, tmpRoot);
    const glob = issues.find((i) => i.ruleId === 'paths/glob-no-match');
    expect(glob).toBeDefined();
    expect(glob!.message).toContain('fakext');
  });

  it('does NOT emit glob-no-match when a glob matches at least one file', async () => {
    seed({
      'CLAUDE.md': 'See src/*.ts for code.\n',
      'src/app.ts': 'x',
    });
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkPaths(parsed, tmpRoot);
    expect(issues.find((i) => i.ruleId === 'paths/glob-no-match')).toBeUndefined();
  });

  it('emits paths/not-found with a fuzzy-match suggestion for a typo', async () => {
    seed({
      'CLAUDE.md': 'See src/authMidleware.ts\n',
      'src/authMiddleware.ts': 'x',
    });
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkPaths(parsed, tmpRoot);
    const notFound = issues.find((i) => i.ruleId === 'paths/not-found');
    expect(notFound).toBeDefined();
    // Fuzzy match should suggest the real file path
    expect(notFound!.suggestion).toContain('authMiddleware.ts');
    expect(notFound!.fix).toBeDefined();
    expect(notFound!.fix!.newText.replace(/\\/g, '/')).toContain('src/authMiddleware.ts');
  });

  it('emits paths/not-found with a basename-match suggestion when directory differs', async () => {
    seed({
      'CLAUDE.md': 'See src/helpers/utils.ts\n',
      'src/lib/utils.ts': 'x',
    });
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkPaths(parsed, tmpRoot);
    const notFound = issues.find((i) => i.ruleId === 'paths/not-found');
    expect(notFound).toBeDefined();
    expect(notFound!.suggestion).toContain('utils.ts');
  });

  it('emits paths/not-found without suggestion when no close match exists', async () => {
    seed({
      'CLAUDE.md': 'See docs/xyz-totally-unrelated-qqq.txt\n',
      'src/app.ts': 'x',
    });
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkPaths(parsed, tmpRoot);
    const notFound = issues.find((i) => i.ruleId === 'paths/not-found');
    expect(notFound).toBeDefined();
    expect(notFound!.suggestion).toBeUndefined();
  });
});
