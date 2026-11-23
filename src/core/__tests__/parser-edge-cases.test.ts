import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parseContextFile } from '../parser.js';
import type { DiscoveredFile } from '../scanner.js';

function parseContent(content: string) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-test-'));
  const tmpFile = path.join(tmpDir, 'CLAUDE.md');
  fs.writeFileSync(tmpFile, content);

  const file: DiscoveredFile = {
    absolutePath: tmpFile,
    relativePath: 'CLAUDE.md',
    isSymlink: false,
    type: 'context',
  };

  const result = parseContextFile(file);

  fs.unlinkSync(tmpFile);
  fs.rmdirSync(tmpDir);

  return result;
}

describe('parser edge cases', () => {
  it('does not extract URLs as paths', () => {
    const result = parseContent(`
# Links
Check https://example.com/api/v1/users for details.
See http://localhost:3000/api/health
    `);
    const paths = result.references.paths.map((p) => p.value);
    for (const p of paths) {
      expect(p).not.toContain('example.com');
      expect(p).not.toContain('localhost');
    }
  });

  it('extracts paths from backticks', () => {
    const result = parseContent('Check `src/utils/helper.ts` for the implementation.');
    const paths = result.references.paths.map((p) => p.value);
    expect(paths).toContain('src/utils/helper.ts');
  });

  it('skips paths inside typed code blocks', () => {
    const result = parseContent(`
\`\`\`typescript
import { foo } from 'src/utils/bar.ts';
\`\`\`
    `);
    const paths = result.references.paths.map((p) => p.value);
    expect(paths).not.toContain('src/utils/bar.ts');
  });

  it('extracts commands from $ prefix', () => {
    const result = parseContent(`
$ npm run build
$ pnpm test
    `);
    const commands = result.references.commands.map((c) => c.value);
    expect(commands).toContain('npm run build');
    expect(commands).toContain('pnpm test');
  });

  it('extracts inline backtick commands', () => {
    const result = parseContent('Run `npm run build` to compile.');
    const commands = result.references.commands.map((c) => c.value);
    expect(commands).toContain('npm run build');
  });

  it('extracts commands from bash code blocks', () => {
    const result = parseContent(`
\`\`\`bash
pnpm install
pnpm test
\`\`\`
    `);
    const commands = result.references.commands.map((c) => c.value);
    expect(commands).toContain('pnpm install');
    expect(commands).toContain('pnpm test');
  });

  it('handles empty files', () => {
    const result = parseContent('');
    expect(result.totalLines).toBe(1);
    expect(result.references.paths).toHaveLength(0);
    expect(result.references.commands).toHaveLength(0);
  });

  it('tracks section context for references', () => {
    const result = parseContent(`
# Setup
Check \`src/config/app.ts\` for settings.

# Testing
Run \`npm run test\` to test.
    `);

    const pathRef = result.references.paths.find((p) => p.value.includes('config'));
    expect(pathRef?.section).toBe('Setup');

    const cmdRef = result.references.commands.find((c) => c.value.includes('test'));
    expect(cmdRef?.section).toBe('Testing');
  });

  it('does not extract slash-abbreviation prose (n/a, N/A, w/o, I/O)', () => {
    // These are dropped by the two-segment slash-prose guard (Fix B in
    // extractPathReferences), which is case-agnostic: a 2-segment, extension-
    // less token whose first segment is not a known top-level dir. The real
    // path beside them proves the guard is selective, not a blanket drop.
    const result = parseContent(`
This is n/a for now, N/A. elsewhere.
Ship w/o the flag.
Check I/O performance.
The entry is src/index.ts.
    `);
    const paths = result.references.paths.map((p) => p.value);
    expect(paths).toEqual(['src/index.ts']);
  });

  it('does not extract "Word/Word" prose (tool names, numeric fractions)', () => {
    const result = parseContent(`
Biome/Prettier both format TS.
Jest/Vitest can both run tests.
Fixed 10/12 tasks this sprint.
Score was 3/5 on the review.
    `);
    const paths = result.references.paths.map((p) => p.value);
    expect(paths).not.toContain('Biome/Prettier');
    expect(paths).not.toContain('Jest/Vitest');
    expect(paths).not.toContain('10/12');
    expect(paths).not.toContain('3/5');
  });

  it('still extracts Word/Word when the second segment has a file extension', () => {
    const result = parseContent('See `Config/settings.ts` for details.');
    const paths = result.references.paths.map((p) => p.value);
    expect(paths).toContain('Config/settings.ts');
  });

  it('handles CRLF line endings without leaking \\r into captures', () => {
    const content = 'See `src/config.ts` for details.\r\nAlso src/utils/fmt.ts.\r\n';
    const result = parseContent(content);
    for (const p of result.references.paths) {
      expect(p.value).not.toContain('\r');
    }
    const paths = result.references.paths.map((p) => p.value);
    expect(paths).toContain('src/config.ts');
    expect(paths).toContain('src/utils/fmt.ts');
  });

  // Unicode segments in paths are currently NOT captured by PATH_PATTERN
  // (ASCII-only regex). Documented here as a known limitation; if someone
  // wants to support unicode paths, the PATH_PATTERN needs a /u flag and
  // `\p{L}\p{N}` in the char class. Low priority — most AI agent context
  // files reference ASCII paths.
  it('does not currently capture unicode path segments (documented limitation)', () => {
    const result = parseContent('Docs live in `docs/日本語/notes.md`.');
    const paths = result.references.paths.map((p) => p.value);
    expect(paths).not.toContain('docs/日本語/notes.md');
    // ASCII-prefix like `docs/` would still NOT be captured as a valid path
    // because the middle segment is non-ASCII — the regex sees `docs/` as
    // incomplete.
  });

  it('extracts paths inside a fenced block with no language specifier', () => {
    // ``` with no lang → isExampleCodeBlock('') is false → paths inside ARE
    // captured. Tests the zero-length-lang branch.
    const result = parseContent(
      [
        'Before the block.',
        '```',
        'src/unlabeled/file.ts is referenced here',
        '```',
        'After.',
      ].join('\n'),
    );
    const paths = result.references.paths.map((p) => p.value);
    expect(paths).toContain('src/unlabeled/file.ts');
  });

  it('does not match ~/ as a project-relative path (leaves it alone)', () => {
    // PATH_PATTERN doesn't begin with ~, so ~/foo.md shouldn't be captured.
    // (Session-parser's extractPaths is the one that handles ~/; the
    // context-file parser intentionally stays project-scoped.)
    const result = parseContent('See ~/.claude/CLAUDE.md for global rules.');
    const paths = result.references.paths.map((p) => p.value);
    for (const p of paths) {
      expect(p).not.toMatch(/^~/);
    }
  });

  it('handles relative paths with ./ and ../', () => {
    const result = parseContent(`
Edit \`./src/index.ts\` for the entry point.
Shared types are in \`../shared/types.ts\`.
    `);
    const paths = result.references.paths.map((p) => p.value);
    expect(paths).toContain('./src/index.ts');
    expect(paths).toContain('../shared/types.ts');
  });

  // Spec 2.1 lists `src/**/*.test.ts` as an extractable glob pattern. The
  // middle-segment char class must allow `*` or the `**/` segment kills the
  // match and paths/glob-no-match can never fire on the spec's own example.
  it('extracts double-star glob patterns as path references (spec 2.1)', () => {
    const result = parseContent('Tests match `src/**/*.test.ts` and `**/*.snap` in CI.');
    const paths = result.references.paths.map((p) => p.value);
    expect(paths).toContain('src/**/*.test.ts');
    expect(paths).toContain('**/*.snap');
  });

  it('still extracts single-star globs in the final segment', () => {
    const result = parseContent('Configs live in `config/*.yaml`.');
    const paths = result.references.paths.map((p) => p.value);
    expect(paths).toContain('config/*.yaml');
  });

  // Markdown emphasis wrappers around slash-joined prose must not be captured
  // as paths: a middle segment may be a whole-star glob (`*`/`**`) but may
  // not START with `*` followed by text, and the leading `*` is not a valid
  // delimiter — so the emphasis kills the whole match instead of routing
  // bold/italic prose to paths/glob-no-match.
  it('does not capture markdown emphasis-wrapped prose as paths', () => {
    const result = parseContent(
      [
        'The **docs/missing** section is bold.',
        'Measure **I/O** carefully.',
        'Pick *either/or* style.',
        'Rule **paths/not-found** fires on dead refs.',
      ].join('\n'),
    );
    expect(result.references.paths).toHaveLength(0);
  });

  // Spec 2.2: command references include content in code blocks with no
  // language tag, gated on COMMON_COMMANDS / $-prefix so non-command lines
  // (sample output) are not extracted.
  it('extracts commands from code blocks with no language tag (spec 2.2)', () => {
    const result = parseContent(
      ['```', 'npm run build', 'compiled 14 files in 1.2s', '$ make deploy', '```'].join('\n'),
    );
    const commands = result.references.commands.map((c) => c.value);
    expect(commands).toContain('npm run build');
    expect(commands).toContain('make deploy');
    expect(commands).not.toContain('compiled 14 files in 1.2s');
  });

  // In untagged fences `>` marks blockquote/redirect/REPL output far more
  // often than a prompt (PR templates quote prose like "> make sure tests
  // pass before merging"); only `$`-prefixed lines are honored there.
  it('does not extract >-quoted prose inside a bare fence as a command', () => {
    const result = parseContent(
      ['```', '> make sure tests pass before merging', '$ make deploy', '```'].join('\n'),
    );
    const commands = result.references.commands.map((c) => c.value);
    expect(commands).not.toContain('make sure tests pass before merging');
    expect(commands).toContain('make deploy');
  });

  it('still honors the > prompt inside tagged shell fences', () => {
    const result = parseContent(['```bash', '> make deploy', '```'].join('\n'));
    const commands = result.references.commands.map((c) => c.value);
    expect(commands).toContain('make deploy');
  });

  it('recognizes mocha/tsc/eslint/prettier as commands (spec 2.2 tool list)', () => {
    const result = parseContent(
      [
        'Run `tsc --noEmit` before committing.',
        'Lint with `eslint src/`.',
        'Format via `prettier --write .`.',
        'Tests use `mocha test/unit`.',
      ].join('\n'),
    );
    const commands = result.references.commands.map((c) => c.value);
    expect(commands).toContain('tsc --noEmit');
    expect(commands).toContain('eslint src/');
    expect(commands).toContain('prettier --write .');
    expect(commands).toContain('mocha test/unit');
  });

  it('does not match longer words sharing a recognized-tool prefix', () => {
    // \b after the alternation: `tsconfig.json` must not register as `tsc`.
    const result = parseContent('Edit `tsconfig.json` and `eslintrc-helper` by hand.');
    const commands = result.references.commands.map((c) => c.value);
    expect(commands).toHaveLength(0);
  });
});

describe('parseSections nesting', () => {
  // A parent section's range must span its subsections: tier-tokens
  // section-breakdown slices lines.slice(startLine - 1, endLine) per
  // top-level section, so closing an H2 at its first H3 child would silently
  // exclude all subsection tokens from the parent's cost.
  it('keeps a parent section open across its subsections', () => {
    const result = parseContent(
      ['## Parent', 'intro', '### Child', 'child body', '## Next', 'next body'].join('\n'),
    );
    const [parent, child, next] = result.sections;
    expect(parent).toMatchObject({ title: 'Parent', startLine: 1, endLine: 4, level: 2 });
    expect(child).toMatchObject({ title: 'Child', startLine: 3, endLine: 4, level: 3 });
    expect(next).toMatchObject({ title: 'Next', startLine: 5, endLine: 6, level: 2 });
  });

  it('a shallower heading closes all deeper open sections at once', () => {
    const result = parseContent(
      ['# Top', '### Deep', 'deep body', '## Mid', 'mid body'].join('\n'),
    );
    const byTitle = new Map(result.sections.map((s) => [s.title, s]));
    expect(byTitle.get('Top')?.endLine).toBe(5); // spans everything to EOF
    expect(byTitle.get('Deep')?.endLine).toBe(3); // closed by the shallower ## Mid
    expect(byTitle.get('Mid')?.endLine).toBe(5);
  });

  it('same-level siblings still close each other (flat documents unchanged)', () => {
    const result = parseContent(['## A', 'a body', '## B', 'b body'].join('\n'));
    const [a, b] = result.sections;
    expect(a.endLine).toBe(2);
    expect(b.endLine).toBe(4);
  });
});

describe('parser -- CRLF line endings', () => {
  // Windows checkouts with core.autocrlf=true hand the parser CRLF content
  // (readFileContent only strips the BOM). The CRLF twin of a file must parse
  // to exactly the same lines, sections, refs and columns as the LF original.
  const lf = [
    '# Project',
    '',
    'Run tests:',
    '$ npm test',
    'See `src/utils/helper.ts` and docs/guide.md',
    '',
    '## Build',
    '',
    '```bash',
    'npm run build',
    '$ pnpm lint',
    '```',
    '',
    'Then `npx tsc --noEmit` before src/index.ts',
    '',
  ].join('\n');
  const crlf = lf.replace(/\n/g, '\r\n');

  it('produces identical results for the CRLF twin of a file', () => {
    const a = parseContent(lf);
    const b = parseContent(crlf);
    expect(a.references.commands.map((c) => c.value)).toContain('npm test');
    expect(b.totalLines).toBe(a.totalLines);
    expect(b.sections).toEqual(a.sections);
    expect(b.references.paths).toEqual(a.references.paths);
    expect(b.references.commands).toEqual(a.references.commands);
  });

  it('never carries a trailing carriage return in extracted values', () => {
    const b = parseContent(crlf);
    for (const r of [...b.references.paths, ...b.references.commands]) {
      expect(r.value).not.toMatch(/\r/);
    }
    for (const s of b.sections) expect(s.title).not.toMatch(/\r/);
  });
});

describe('parseSections -- fenced code blocks', () => {
  it('does not treat a # comment inside a fence as a heading', () => {
    const result = parseContent(
      ['## Setup', '```bash', '# install deps', 'npm install', '```', 'See src/index.ts'].join(
        '\n',
      ),
    );
    expect(result.sections.map((s) => s.title)).toEqual(['Setup']);
    expect(result.sections[0]).toMatchObject({ startLine: 1, endLine: 6, level: 2 });
    const ref = result.references.paths.find((p) => p.value === 'src/index.ts');
    expect(ref?.section).toBe('Setup');
  });

  it('does not treat a # line inside an HTML comment as a heading', () => {
    // A commented-out bash fence: the comment wins, so the fence lines are
    // classified `comment`, not `fence` -- they must still not become headings.
    const result = parseContent(
      ['# Top', '<!--', '```bash', '# Install deps', 'npm ci', '```', '-->', '## Real'].join('\n'),
    );
    expect(result.sections.map((s) => s.title)).toEqual(['Top', 'Real']);
  });

  it('does not let a # line in a fence after a stray <!-- become a heading', () => {
    const result = parseContent(
      [
        '# Top',
        'Write <!-- to start a comment.',
        '```bash',
        '# step one',
        '$ npm run build',
        '```',
      ].join('\n'),
    );
    expect(result.sections.map((s) => s.title)).toEqual(['Top']);
  });

  it('does not let a one-line ```cmd``` snippet open a fence', () => {
    // A backtick fence's info string cannot contain a backtick, so this is an
    // inline code span. Treating it as an opener hid every later heading.
    const result = parseContent(
      [
        '# Intro',
        '```npm test``` runs the tests.',
        '## Build',
        'Run `npm run build`.',
        '## Test',
      ].join('\n'),
    );
    expect(result.sections.map((s) => s.title)).toEqual(['Intro', 'Build', 'Test']);
    const cmd = result.references.commands.find((c) => c.value === 'npm run build');
    expect(cmd?.section).toBe('Build');
  });

  it('recognises ~~~ fences for headings and both extractors', () => {
    const result = parseContent(
      [
        '## Setup',
        '~~~bash',
        '# install deps',
        'npm install',
        '~~~',
        '~~~ts',
        "import x from './lib/x.ts';",
        '~~~',
      ].join('\n'),
    );
    expect(result.sections.map((s) => s.title)).toEqual(['Setup']);
    expect(result.references.commands.map((c) => c.value)).toEqual(['npm install']);
    // The ts fence is example code: its import path is not a file reference.
    expect(result.references.paths).toEqual([]);
  });

  it('keeps a 4-backtick fence open across an inner ``` pair', () => {
    const result = parseContent(
      [
        '## Docs',
        '````md',
        '```bash',
        '$ npm ci',
        '# Not a heading',
        '```',
        '````',
        '## After',
      ].join('\n'),
    );
    expect(result.sections.map((s) => s.title)).toEqual(['Docs', 'After']);
    // An md fence is not a shell fence: nothing inside it is a command.
    expect(result.references.commands).toEqual([]);
  });
});

describe('extractCommandReferences -- non-shell fences', () => {
  it('does not extract an inline-backtick command from a ts fence', () => {
    const result = parseContent(
      ['```ts', 'const cmd = `npm run build`;', '```', 'Run `npm test`.'].join('\n'),
    );
    expect(result.references.commands.map((c) => c.value)).toEqual(['npm test']);
  });

  it('does not extract an inline-backtick command from a json fence', () => {
    const result = parseContent(['```json', '{ "note": "`npx tsc` here" }', '```'].join('\n'));
    expect(result.references.commands).toEqual([]);
  });
});
