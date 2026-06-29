import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import simpleGit from 'simple-git';
import { parseContextFile } from '../../parser.js';
import { checkPaths, resetPathsCache } from '../paths.js';
import { resetGit } from '../../../utils/git.js';
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

afterEach(async () => {
  resetGit();
  // Windows holds .git/index handles briefly after the last git subprocess
  // exits; retry the cleanup a few times (mirrors git.test.ts).
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  resetPathsCache();
}, 10000);

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

  // Windows-style .\foo refs must resolve from the context file's directory
  // (like ./foo), not the project root. Built directly because the reference
  // shape, not the parser, is under test.
  it("resolves a Windows-style .\\ ref against the context file's directory", async () => {
    seed({ 'docs/helpers/util.ts': 'x' });
    const parsed: ParsedContextFile = {
      filePath: path.join(tmpRoot, 'docs', 'CLAUDE.md'),
      relativePath: 'docs/CLAUDE.md',
      isSymlink: false,
      totalTokens: 0,
      totalLines: 1,
      content: '',
      sections: [],
      references: {
        paths: [{ value: '.\\helpers\\util.ts', line: 1, column: 1 }],
        commands: [],
      },
    };
    const issues = await checkPaths(parsed, tmpRoot);
    expect(issues.find((i) => i.ruleId === 'paths/not-found')).toBeUndefined();
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

  // Basename-index: when multiple project files share the same basename, the
  // one with the smallest Levenshtein distance to the full target path wins.
  // Guards the index-backed Pass 1 against a regression that would pick an
  // arbitrary same-basename file instead of the path-closest one.
  it('picks the basename candidate with smallest path distance when multiple share the same basename', async () => {
    seed({
      'CLAUDE.md': 'See src/components/utils.ts\n',
      // Two files with the same basename; src/lib/utils.ts is path-closer
      'src/lib/utils.ts': 'x',
      'other/deep/nested/dir/utils.ts': 'x',
    });
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkPaths(parsed, tmpRoot);
    const notFound = issues.find((i) => i.ruleId === 'paths/not-found');
    expect(notFound).toBeDefined();
    // src/lib/utils.ts is closer to src/components/utils.ts than the deeply nested one
    expect(notFound!.fix!.newText.replace(/\\/g, '/')).toBe('src/lib/utils.ts');
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

  // Regression: the basename pass is deliberately uncapped — basename
  // equality is the signal, and edit distance only ranks among basename-equal
  // candidates (the absolute cap applies solely to the full-path fallback
  // pass). So a basename-equal candidate at a large path-edit distance must
  // still win over a full-path candidate with a smaller raw Levenshtein
  // distance.
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

  // References are built directly for the glob-ignore tests: the `**/*.x`
  // extraction shape belongs to the parser's tests, while the SUT here is
  // the glob() validation call.
  function parsedWithRefs(refs: string[], relPath = 'CLAUDE.md'): ParsedContextFile {
    return {
      filePath: path.join(tmpRoot, relPath),
      relativePath: relPath,
      isSymlink: false,
      totalTokens: 0,
      totalLines: 1,
      content: '',
      sections: [],
      references: {
        paths: refs.map((value, i) => ({ value, line: i + 1, column: 1 })),
        commands: [],
      },
    };
  }

  it('reports glob-no-match when the only matches live inside ignored dirs (node_modules not crawled)', async () => {
    seed({
      'node_modules/pkg/index.test.ts': 'x',
      'dist/out.test.ts': 'x',
      'src/app.ts': 'x',
    });
    const issues = await checkPaths(parsedWithRefs(['**/*.test.ts']), tmpRoot);
    const noMatch = issues.find((i) => i.ruleId === 'paths/glob-no-match');
    expect(noMatch).toBeDefined();
    expect(noMatch!.message).toContain('**/*.test.ts');
  });

  it('matches a double-star glob against real project files despite the ignore list', async () => {
    seed({
      'src/app.test.ts': 'x',
      // Decoy inside an ignored dir -- must not be needed for the match.
      'node_modules/pkg/index.test.ts': 'x',
    });
    const issues = await checkPaths(parsedWithRefs(['**/*.test.ts']), tmpRoot);
    expect(issues.find((i) => i.ruleId === 'paths/glob-no-match')).toBeUndefined();
  });

  // @-imports resolve relative to the IMPORTING file's own directory (Claude
  // Code / combineClaudeMd semantics), not the project root. A subdirectory
  // CLAUDE.md whose `@./rules/x.md` import resolves to a real sibling file
  // must NOT be reported as broken (the bug that fuzzy-"fixed" durable bundle
  // source).
  it('does NOT flag an @./-import that resolves under the doc directory', async () => {
    seed({
      'content/yaw-mode/CLAUDE.md': 'Imports @./rules/agent-setup.md at build time.\n',
      'content/yaw-mode/rules/agent-setup.md': 'x',
    });
    const parsed = parseContextFile(discoveredIn('content/yaw-mode/CLAUDE.md'));
    const issues = await checkPaths(parsed, tmpRoot);
    expect(issues.find((i) => i.ruleId === 'paths/not-found')).toBeUndefined();
  });

  it('does NOT flag a bare relative ref that resolves under the doc directory', async () => {
    seed({
      'content/yaw-mode/CLAUDE.md': 'combineClaudeMd reads rules/manifest.json.\n',
      'content/yaw-mode/rules/manifest.json': '{}',
    });
    const parsed = parseContextFile(discoveredIn('content/yaw-mode/CLAUDE.md'));
    const issues = await checkPaths(parsed, tmpRoot);
    expect(issues.find((i) => i.ruleId === 'paths/not-found')).toBeUndefined();
  });

  it('does NOT flag a scoped npm package mention that looks like an @-import', async () => {
    seed({ 'CLAUDE.md': 'Use @anthropic-ai/sdk for the client.\n' });
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkPaths(parsed, tmpRoot);
    expect(issues.find((i) => i.ruleId === 'paths/not-found')).toBeUndefined();
  });

  it('does NOT flag a relative path that escapes the project root', async () => {
    // The classic `ln -sf ../../scripts/x .git/hooks/y` symlink target: the
    // path is relative to where the link lives, not the doc, and escapes the
    // repo -- ctxlint can't validate it and must not autofix it into nonsense.
    seed({ 'CLAUDE.md': 'Install: ln -sf ../../scripts/ci-local.sh .git/hooks/pre-push\n' });
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkPaths(parsed, tmpRoot);
    expect(issues.find((i) => i.ruleId === 'paths/not-found')).toBeUndefined();
  });

  // findRenames matches in git's repo-root-relative coordinate space, so a
  // ./-relative ref in a SUBDIRECTORY context file (resolved against the
  // doc's own dir, paths.ts:38) must still get rename provenance (commit
  // hash + daysAgo) instead of degrading to the fuzzy Levenshtein fallback.
  it(
    'preserves rename provenance for a ./-relative ref in a subdirectory context file',
    { timeout: 30000 },
    async () => {
      // Resolve symlinks so projectRoot matches the toplevel git reports.
      const root = fs.realpathSync(tmpRoot);
      seed({ 'docs/sub/file.md': 'a\nb\nc\nd\ne\n' });
      const git = simpleGit(root);
      await git.raw(['init', '-b', 'main']);
      await git.addConfig('user.email', 'test@example.com');
      await git.addConfig('user.name', 'Test');
      await git.addConfig('core.autocrlf', 'false');
      await git.add('docs/sub/file.md');
      await git.commit('add');
      await git.mv('docs/sub/file.md', 'docs/sub/moved.md');
      await git.commit('rename');
      resetGit();

      const parsed = parsedWithRefs(['./sub/file.md'], path.join('docs', 'CLAUDE.md'));
      parsed.filePath = path.join(root, 'docs', 'CLAUDE.md');
      const issues = await checkPaths(parsed, root);
      const notFound = issues.find((i) => i.ruleId === 'paths/not-found');
      expect(notFound).toBeDefined();
      expect(notFound!.suggestion).toContain('docs/sub/moved.md');
      // Provenance comes from the rename match, not the fuzzy fallback.
      expect(notFound!.detail).toMatch(/commit [a-f0-9]{7}/);
      // The autofix newText must share the ref's coordinate space. The ref
      // (./sub/file.md) is resolved from the doc's OWN dir, so the rewrite
      // is doc-relative too -- ./sub/moved.md, not the root-relative
      // docs/sub/moved.md the suggestion shows. A root-relative newText would
      // re-resolve under docs/ to docs/docs/sub/moved.md when applied.
      expect(notFound!.fix?.newText).toBe('./sub/moved.md');
    },
  );

  // The basename index + project-file list are cached by projectRoot
  // (getBasenameIndex / getProjectFiles check `cached?.root === projectRoot`).
  // A second checkPaths call against a DIFFERENT root, with no resetPathsCache
  // between, must rebuild both for that root -- otherwise root B would be linted
  // against root A's cached index. Two independent temp roots, each with a
  // broken ref whose basename matches a file that exists ONLY in that root.
  it('rebuilds the basename index when projectRoot changes without a reset', async () => {
    // Root A is the shared tmpRoot: ref basename `alpha.ts` exists only here.
    seed({
      'CLAUDE.md': 'See src/wrongdir/alpha.ts\n',
      'lib/alpha.ts': 'x',
    });
    const parsedA = parseContextFile(discoveredIn('CLAUDE.md'));

    // Root B is an independent temp dir (replicating seed/discoveredIn): ref
    // basename `bravo.ts` exists only here, at a path absent from root A.
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-paths-b-'));
    try {
      const writeB = (rel: string, content: string) => {
        const full = path.join(rootB, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
      };
      writeB('CLAUDE.md', 'See src/wrongdir/bravo.ts\n');
      writeB('lib/bravo.ts', 'x');
      const parsedB = parseContextFile({
        absolutePath: path.join(rootB, 'CLAUDE.md'),
        relativePath: 'CLAUDE.md',
        isSymlink: false,
        type: 'context',
      });

      // Populate the per-root caches for A, then switch to B with NO reset.
      const issuesA = await checkPaths(parsedA, tmpRoot);
      const notFoundA = issuesA.find((i) => i.ruleId === 'paths/not-found');
      expect(notFoundA).toBeDefined();
      expect(notFoundA!.fix!.newText.replace(/\\/g, '/')).toBe('lib/alpha.ts');

      const issuesB = await checkPaths(parsedB, rootB);
      const notFoundB = issuesB.find((i) => i.ruleId === 'paths/not-found');
      expect(notFoundB).toBeDefined();
      // Had the index served root A's cache, `bravo.ts` would be absent from it
      // and the Pass-1 basename lookup would miss -- so a B-pointing fix proves
      // the index rebuilt for root B.
      expect(notFoundB!.fix!.newText.replace(/\\/g, '/')).toBe('lib/bravo.ts');
    } finally {
      for (let i = 0; i < 5; i++) {
        try {
          fs.rmSync(rootB, { recursive: true, force: true });
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    }
  });

  // Pass-1 priority: ANY basename-equal candidate wins over a Pass-2 full-path
  // candidate, even when the Pass-2 candidate shares the same directory and is
  // one character off. `other/bar.ts` (basename match, far path) beats
  // `src/foo/baz.ts` (path-close, different basename).
  it('prefers a basename match over a path-closer non-basename file', async () => {
    seed({
      'CLAUDE.md': 'See src/foo/bar.ts\n',
      'other/bar.ts': 'x',
      'src/foo/baz.ts': 'x',
    });
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkPaths(parsed, tmpRoot);
    const notFound = issues.find((i) => i.ruleId === 'paths/not-found');
    expect(notFound).toBeDefined();
    expect(notFound!.fix!.newText.replace(/\\/g, '/')).toBe('other/bar.ts');
  });

  // ---- Fix A2 (bare-fence directory-diagram tree children) + Fix B
  // (lowercase slash-prose). See parser.ts extractPathReferences. ----

  // The full reproduction fixture: a bare-fence nested directory diagram plus
  // lowercase slash-prose. The diagram's non-indented parents (apps/ packages/
  // scripts/) are seeded as real dirs and resolve; every indented child and the
  // prose phrases are suppressed -> zero findings.
  it('reports zero path findings for the diagram-and-prose fixture', async () => {
    const parsed = parseContextFile(makeDiscovered('diagram-and-prose', 'CLAUDE.md'));
    const projectRoot = path.join(FIXTURES, 'diagram-and-prose');
    const issues = await checkPaths(parsed, projectRoot);
    const pathIssues = issues.filter((i) => i.check === 'paths');
    // Spell out the tokens the maintainer cares about, then assert total zero.
    const msgs = pathIssues.map((i) => i.message);
    for (const tok of ['api/', 'indexer/', 'db/', 'retrieval/', 'unit/integration', 'skill/agent']) {
      expect(msgs.some((m) => m.includes(tok))).toBe(false);
    }
    expect(pathIssues).toHaveLength(0);
  });

  // Fix A2: an INDENTED single-segment `name/` child inside a bare fence is a
  // phantom root-relative ref and must not be reported. Non-indented parents
  // are seeded and resolve.
  it('does NOT report indented single-segment dir children in a bare-fence diagram', async () => {
    seed({
      'CLAUDE.md': [
        '# Layout',
        '',
        '```',
        'apps/',
        '  api/        the api service',
        '  indexer/    the worker',
        'packages/',
        '  db/         drizzle schema',
        '```',
        '',
      ].join('\n'),
      'apps/placeholder.ts': 'x',
      'packages/placeholder.ts': 'x',
    });
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkPaths(parsed, tmpRoot);
    expect(issues).toHaveLength(0);
  });

  // Fix A2 negative control: a genuinely broken MULTI-segment path in a bare
  // fence (a real flat file-tree, the documented use case) is STILL reported.
  it('STILL reports a broken multi-segment path in a bare-fence flat file-tree', async () => {
    seed({
      'CLAUDE.md': ['# Files', '', '```', 'src/index.ts', 'src/does-not-exist.ts', '```', ''].join(
        '\n',
      ),
      'src/index.ts': 'x',
    });
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkPaths(parsed, tmpRoot);
    expect(issues.some((i) => i.message.includes('src/does-not-exist.ts'))).toBe(true);
    // The real file on the line above is not falsely reported.
    expect(issues.some((i) => i.message.includes('src/index.ts'))).toBe(false);
  });

  // Fix B: lowercase `word/word` prose is suppressed, but a real top-level ref
  // (allow-listed first segment) is still validated in BOTH directions --
  // existing dir resolves, broken dir is reported.
  it('suppresses lowercase slash-prose but still validates real top-level refs', async () => {
    seed({
      'CLAUDE.md': [
        '- Vitest for unit/integration tests.',
        '- Maintaining skill/agent path references.',
        '- The content/length router.',
        '- See src/core for the core.',
        '- See src/missing for the missing one.',
        '',
      ].join('\n'),
      'src/core/index.ts': 'x',
    });
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkPaths(parsed, tmpRoot);
    const msgs = issues.map((i) => i.message);
    // Prose phrases are not reported.
    expect(msgs.some((m) => m.includes('unit/integration'))).toBe(false);
    expect(msgs.some((m) => m.includes('skill/agent'))).toBe(false);
    expect(msgs.some((m) => m.includes('content/length'))).toBe(false);
    // src/core exists -> not falsely suppressed into a finding (it resolves).
    expect(msgs.some((m) => m.includes('src/core'))).toBe(false);
    // src/missing has an allow-listed first segment -> still validated + broken.
    expect(msgs.some((m) => m.includes('src/missing'))).toBe(true);
  });

  // Fix B must not fire OUTSIDE a 2-segment lowercase shape: a `word/word.ext`
  // (extension) and a Capitalized/Capitalized token keep their existing
  // behavior, and a multi-segment lowercase token (build/seed/probe/lint) is
  // NOT covered by Fix B (documented residual).
  it('does NOT suppress extension-bearing or allow-listed two-segment refs', async () => {
    seed({
      'CLAUDE.md': [
        '- The apps/api service is the proxy.',
        '- Config lives at config/database.yml.',
        '',
      ].join('\n'),
      'apps/api/index.ts': 'x',
      'config/database.yml': 'x',
    });
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkPaths(parsed, tmpRoot);
    // Both resolve, so neither is reported; but crucially neither was silently
    // suppressed (apps/ is allow-listed; the .yml carries an extension).
    expect(issues).toHaveLength(0);
  });
});
