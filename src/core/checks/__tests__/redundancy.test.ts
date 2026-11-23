import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseContextFile } from '../../parser.js';
import {
  checkRedundancy,
  checkDuplicateContent,
  _resetRedundancyCachesForTesting,
} from '../redundancy.js';
import { resetPackageJsonCache } from '../../../utils/fs.js';
import { countTokens } from '../../../utils/tokens.js';
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

// Like makeDiscovered but the context file lives in a subdirectory of the
// project root, so its dirname differs from projectRoot. Used to exercise
// the ./-relative directory resolution.
function makeNestedDiscovered(fixtureName: string, relPath: string): DiscoveredFile {
  return {
    absolutePath: path.join(FIXTURES, fixtureName, relPath),
    relativePath: relPath,
    isSymlink: false,
    type: 'context',
  };
}

function makeParsed(
  filePath: string,
  relativePath: string,
  content: string,
  extra: Partial<ParsedContextFile> = {},
): ParsedContextFile {
  return {
    filePath,
    relativePath,
    isSymlink: false,
    totalTokens: 0,
    totalLines: content.split('\n').length,
    content,
    sections: [],
    references: { paths: [], commands: [] },
    ...extra,
  };
}

// Both caches are keyed so they cannot serve a wrong answer, but the
// package.json cache would hand a later test a parse from an earlier temp dir
// that reused a path; reset both so each test reads what it wrote.
beforeEach(() => {
  _resetRedundancyCachesForTesting();
  resetPackageJsonCache();
});

describe('checkRedundancy', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-redundancy-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function project(deps: Record<string, string>, content: string): ParsedContextFile {
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ dependencies: deps }));
    return makeParsed(path.join(tmp, 'CLAUDE.md'), 'CLAUDE.md', content);
  }

  const techIssues = (issues: Awaited<ReturnType<typeof checkRedundancy>>) =>
    issues.filter((i) => i.ruleId === 'redundancy/tech-mention');

  it('flags technology mentions already in package.json, one issue per line', async () => {
    const parsed = parseContextFile(makeDiscovered('redundant-content', 'CLAUDE.md'));
    const projectRoot = path.join(FIXTURES, 'redundant-content');
    const issues = techIssues(await checkRedundancy(parsed, projectRoot));

    expect(issues.map((i) => [i.line, i.message])).toEqual([
      [3, '"React" is in package.json dependencies — agent can infer this'],
      [
        4,
        '"TypeScript" (devDependencies) and "Express" (dependencies) are in package.json — agent can infer these',
      ],
    ]);
  });

  it('does not double-report case variants or alias spellings of one tech', async () => {
    const parsed = project({ vue: '^3.0.0' }, 'Built with Vue.js');
    const issues = techIssues(await checkRedundancy(parsed, tmp));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toBe(
      '"Vue.js" is in package.json dependencies — agent can infer this',
    );
  });

  it('reports one tech once when two packages map to it (redis + ioredis)', async () => {
    const parsed = project({ redis: '1', ioredis: '1' }, 'We use Redis for caching.');
    const issues = techIssues(await checkRedundancy(parsed, tmp));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toBe(
      '"Redis" is in package.json dependencies — agent can infer this',
    );
  });

  it("counts each line's tokens once, however many techs it names", async () => {
    const lines = [
      'We use React with TypeScript.',
      'Built with Vue.js and Next.js.',
      'We use Redis for caching.',
      'This is a React app using Tailwind.',
      'Nothing to see here.',
      'Powered by Express and Prisma.',
    ];
    const parsed = project(
      {
        react: '1',
        typescript: '1',
        vue: '1',
        next: '1',
        redis: '1',
        ioredis: '1',
        tailwindcss: '1',
        express: '1',
        prisma: '1',
      },
      lines.join('\n'),
    );
    const issues = techIssues(await checkRedundancy(parsed, tmp));
    const expected = [0, 1, 2, 3, 5].reduce((sum, i) => sum + countTokens(lines[i]), 0);
    expect(issues).toHaveLength(5);
    expect(issues.reduce((sum, i) => sum + (i.wastedTokens ?? 0), 0)).toBe(expected);
  });

  it('does not treat directives naming a tool as inferable tech mentions', async () => {
    const parsed = project(
      { react: '1', jest: '1' },
      'Use React Testing Library for component tests.\nUse Jest mocks sparingly.\n- Prefer using Jest fake timers.',
    );
    expect(techIssues(await checkRedundancy(parsed, tmp))).toEqual([]);
  });

  it('flags discoverable directory structure', async () => {
    const parsed = parseContextFile(makeDiscovered('redundant-content', 'CLAUDE.md'));
    const projectRoot = path.join(FIXTURES, 'redundant-content');
    const issues = await checkRedundancy(parsed, projectRoot);

    const messages = issues.map((i) => i.message);
    expect(messages.some((m) => m.includes('src/components/'))).toBe(true);
  });

  it('resolves ./-relative directory refs against the context file dir, not project root', async () => {
    // nested-context/sub/CLAUDE.md references `./components/`, which exists at
    // nested-context/sub/components (relative to the file), NOT at
    // nested-context/components (relative to the project root). The old code
    // resolved against projectRoot and would miss this.
    const parsed = parseContextFile(makeNestedDiscovered('nested-context', 'sub/CLAUDE.md'));
    const projectRoot = path.join(FIXTURES, 'nested-context');
    const issues = await checkRedundancy(parsed, projectRoot);

    const dirIssue = issues.find((i) => i.ruleId === 'redundancy/discoverable-dir');
    expect(dirIssue).toBeDefined();
    expect(dirIssue!.message).toContain('./components/');
  });

  it('does not match a placement verb inside another word ("Django in backend/")', async () => {
    fs.mkdirSync(path.join(tmp, 'backend'));
    const parsed = project({}, 'We run Django in backend/ for the API.');
    const issues = await checkRedundancy(parsed, tmp);
    expect(issues.filter((i) => i.ruleId === 'redundancy/discoverable-dir')).toEqual([]);
  });

  it('does not report directories outside the project root', async () => {
    const root = path.join(tmp, 'proj');
    fs.mkdirSync(root);
    fs.mkdirSync(path.join(tmp, 'outside'));
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    const abs = `${tmp.replace(/\\/g, '/')}/`;
    const parsed = makeParsed(
      path.join(root, 'CLAUDE.md'),
      'CLAUDE.md',
      `Scratch files are stored in ../outside/\nLogs are stored in ${abs}`,
    );
    const issues = await checkRedundancy(parsed, root);
    expect(issues.filter((i) => i.ruleId === 'redundancy/discoverable-dir')).toEqual([]);
  });

  it('treats an in-root directory whose name starts with ".." as inside the project', async () => {
    fs.mkdirSync(path.join(tmp, '..cache'));
    const parsed = project({}, 'Build artifacts are stored in ..cache/');
    const issues = await checkRedundancy(parsed, tmp);
    expect(issues.filter((i) => i.ruleId === 'redundancy/discoverable-dir')).toHaveLength(1);
  });
});

describe('checkDuplicateContent', () => {
  it('flags high overlap between files', () => {
    const file1 = parseContextFile(makeDiscovered('multiple-files', 'CLAUDE.md'));
    const file2 = parseContextFile(makeDiscovered('multiple-files', 'AGENTS.md'));
    const issues = checkDuplicateContent([file1, file2]);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toBe('CLAUDE.md and AGENTS.md have 60% content overlap');
  });

  it('does not flag files with different content', () => {
    const a = makeParsed('/p/CLAUDE.md', 'CLAUDE.md', 'Run the unit tests first.\nKeep PRs small.');
    const b = makeParsed(
      '/p/AGENTS.md',
      'AGENTS.md',
      'Deploys go through staging.\nNo force pushes.',
    );
    expect(checkDuplicateContent([a, b])).toEqual([]);
  });

  it('skips a pair where one file is a symlink to the other (AGENTS.md -> CLAUDE.md)', () => {
    const content = 'Always run tests before committing.\nUse TypeScript strict mode.';
    const dir = path.resolve('/p');
    const real = makeParsed(path.join(dir, 'CLAUDE.md'), 'CLAUDE.md', content);
    const link = makeParsed(path.join(dir, 'AGENTS.md'), 'AGENTS.md', content, {
      isSymlink: true,
      symlinkTarget: 'CLAUDE.md',
    });
    expect(checkDuplicateContent([real, link])).toEqual([]);
    expect(checkDuplicateContent([link, real])).toEqual([]);
  });

  it('still flags a symlink whose target is a different file', () => {
    const content = 'Always run tests before committing.\nUse TypeScript strict mode.';
    const dir = path.resolve('/p');
    const a = makeParsed(path.join(dir, 'CLAUDE.md'), 'CLAUDE.md', content);
    const link = makeParsed(path.join(dir, 'AGENTS.md'), 'AGENTS.md', content, {
      isSymlink: true,
      symlinkTarget: 'docs/shared.md',
    });
    expect(checkDuplicateContent([a, link])).toHaveLength(1);
  });
});
