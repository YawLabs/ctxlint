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

  it('does not extract common false positives', () => {
    const result = parseContent(`
This is n/a for now.
Check I/O performance.
See e.g. the docs.
    `);
    const paths = result.references.paths.map((p) => p.value);
    expect(paths).toHaveLength(0);
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
