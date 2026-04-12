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
});
