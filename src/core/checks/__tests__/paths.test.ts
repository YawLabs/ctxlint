import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseContextFile } from '../../parser.js';
import { checkPaths, resetPathsCache } from '../paths.js';
import type { DiscoveredFile } from '../../scanner.js';
import type { ParsedContextFile } from '../../types.js';

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

  it('emits paths/directory-not-found for a missing directory reference', async () => {
    seed({
      'CLAUDE.md': 'Components live in ./src/components/ but that directory is gone.\n',
    });
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkPaths(parsed, tmpRoot);
    const dirIssue = issues.find((i) => i.ruleId === 'paths/directory-not-found');
    expect(dirIssue).toBeDefined();
    expect(dirIssue!.message).toContain('src/components/');
  });

  it('does NOT emit directory-not-found when the directory exists', async () => {
    seed({
      'CLAUDE.md': 'Components live in ./src/components/ today.\n',
      'src/components/index.ts': 'x',
    });
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkPaths(parsed, tmpRoot);
    expect(issues.find((i) => i.ruleId === 'paths/directory-not-found')).toBeUndefined();
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

  // Regression: an absolute glob (e.g. /etc/*.conf, C:/x/*.ts) must be matched
  // as an absolute pattern, not relativized against cwd. Building the reference
  // directly avoids the parser regex's handling of Windows drive prefixes.
  it('does NOT emit glob-no-match for an absolute glob that matches an existing file', async () => {
    seed({ 'src/app.ts': 'x' });
    const absGlob = path.join(tmpRoot, 'src', '*.ts').replace(/\\/g, '/');
    expect(path.isAbsolute(absGlob)).toBe(true);
    const parsed: ParsedContextFile = {
      filePath: path.join(tmpRoot, 'CLAUDE.md'),
      relativePath: 'CLAUDE.md',
      isSymlink: false,
      totalTokens: 0,
      totalLines: 1,
      content: '',
      sections: [],
      references: {
        paths: [{ value: absGlob, line: 1, column: 1 }],
        commands: [],
      },
    };
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

  // Regression: the basename pass and the full-path fallback pass each have
  // their own distance cap. A basename-equal candidate at some non-trivial
  // edit distance should still win over a full-path candidate that happens to
  // have a smaller raw Levenshtein distance — basename equality is the
  // stronger signal, and pass-scoped caps make this explicit.
  it('prefers a basename match even when a full-path candidate has smaller raw distance', async () => {
    seed({
      'CLAUDE.md': 'See src/very/deeply/nested/dir/utils.ts\n',
      // Basename match but in a totally different directory tree -- larger
      // overall path-edit distance.
      'lib/utils.ts': 'x',
      // Full-path candidate with closer raw Levenshtein to the typo'd
      // reference, but wrong basename.
      'src/very/deeply/nested/dir/utilx.ts': 'x',
    });
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkPaths(parsed, tmpRoot);
    const notFound = issues.find((i) => i.ruleId === 'paths/not-found');
    expect(notFound).toBeDefined();
    // Basename-equal candidate (lib/utils.ts) should win regardless of the
    // closer-by-raw-distance full-path candidate.
    expect(notFound!.suggestion).toContain('lib/utils.ts');
    expect(notFound!.fix!.newText.replace(/\\/g, '/')).toBe('lib/utils.ts');
  });

  // Length-prefilter correctness: candidates with very different lengths
  // (lower bound on Levenshtein > cap) must be skipped, but a genuinely close
  // candidate inside the cap must still be found.
  it('finds a close full-path match while ignoring length-distant candidates', async () => {
    seed({
      'CLAUDE.md': 'See src/app.ts\n',
      // Existing file with a one-character typo in the basename so the
      // full-path fallback (not the basename pass) is what fires.
      'src/aqp.ts': 'x',
      // Length-distant candidate that should be skipped by the prefilter.
      'docs/some/very/long/and/totally/unrelated/path/document-name.md': 'x',
    });
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkPaths(parsed, tmpRoot);
    const notFound = issues.find((i) => i.ruleId === 'paths/not-found');
    expect(notFound).toBeDefined();
    expect(notFound!.suggestion).toContain('src/aqp.ts');
  });
});
