import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  encodeProjectDir,
  projectDirMatchesPath,
  extractPaths,
  parseFrontmatter,
  parseMemoryFile,
} from '../session-parser.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-sp-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('encodeProjectDir', () => {
  it('replaces / \\ : . with -', () => {
    expect(encodeProjectDir('C:/Users/jeff/yaw/ctxlint')).toBe('C--Users-jeff-yaw-ctxlint');
  });

  it('handles Windows backslash paths', () => {
    expect(encodeProjectDir('C:\\Users\\jeff')).toBe('C--Users-jeff');
  });

  it('handles POSIX absolute paths', () => {
    expect(encodeProjectDir('/home/jeff/repo')).toBe('-home-jeff-repo');
  });

  it('encodes dots in project names', () => {
    expect(encodeProjectDir('/home/jeff/repo.js')).toBe('-home-jeff-repo-js');
  });
});

describe('projectDirMatchesPath', () => {
  it('matches identical encoded paths', () => {
    expect(projectDirMatchesPath('C--Users-jeff-yaw-ctxlint', 'C:/Users/jeff/yaw/ctxlint')).toBe(
      true,
    );
  });

  it('returns false for mismatched paths', () => {
    expect(projectDirMatchesPath('C--Users-jeff-other', 'C:/Users/jeff/yaw/ctxlint')).toBe(false);
  });

  it('normalizes backslashes in the input path before comparing', () => {
    expect(
      projectDirMatchesPath('C--Users-jeff-yaw-ctxlint', 'C:\\Users\\jeff\\yaw\\ctxlint'),
    ).toBe(true);
  });
});

describe('extractPaths', () => {
  it('extracts relative paths after whitespace', () => {
    const paths = extractPaths('See ./src/index.ts and ../other/file.md for details.');
    expect(paths).toContain('./src/index.ts');
    expect(paths).toContain('../other/file.md');
  });

  it('extracts absolute POSIX paths', () => {
    const paths = extractPaths('The log is at /var/log/app.log');
    expect(paths).toContain('/var/log/app.log');
  });

  it('extracts home-relative paths', () => {
    const paths = extractPaths('Config in ~/.config/tool/settings.json');
    expect(paths).toContain('~/.config/tool/settings.json');
  });

  it('extracts paths inside backticks', () => {
    const paths = extractPaths('Look at `./README.md` for the overview.');
    expect(paths).toContain('./README.md');
  });

  it('trims trailing brackets', () => {
    const paths = extractPaths('See (./notes.md) for more.');
    expect(paths).toContain('./notes.md');
  });

  it('skips http URLs', () => {
    const paths = extractPaths('See https://example.com/path for the docs.');
    expect(paths).not.toContain('https://example.com/path');
  });

  it('skips protocol-relative URLs', () => {
    const paths = extractPaths('Link: //example.com/x');
    expect(paths.some((p) => p.startsWith('//'))).toBe(false);
  });

  it('deduplicates repeated references', () => {
    const paths = extractPaths('./a.md and ./a.md again and ./a.md');
    expect(paths.filter((p) => p === './a.md')).toHaveLength(1);
  });

  it('returns empty array for content with no paths', () => {
    expect(extractPaths('no paths here, just prose.')).toEqual([]);
  });
});

describe('parseFrontmatter', () => {
  it('returns only body when no frontmatter is present', () => {
    const result = parseFrontmatter('# Heading\n\nJust body.');
    expect(result.body).toBe('# Heading\n\nJust body.');
    expect(result.name).toBeUndefined();
    expect(result.description).toBeUndefined();
    expect(result.type).toBeUndefined();
  });

  it('parses name, description, and type', () => {
    const content = '---\nname: my-memory\ndescription: A test\ntype: feedback\n---\n\nbody';
    const result = parseFrontmatter(content);
    expect(result.name).toBe('my-memory');
    expect(result.description).toBe('A test');
    expect(result.type).toBe('feedback');
    expect(result.body).toBe('\nbody');
  });

  it('returns only body when frontmatter is unclosed', () => {
    const content = '---\nname: oops\nno closing delimiter';
    const result = parseFrontmatter(content);
    expect(result.body).toBe(content);
  });

  it('ignores unrecognized fields without crashing', () => {
    const content = '---\nname: x\ndescription: y\ntype: user\nextra: ignored\n---\nbody';
    const result = parseFrontmatter(content);
    expect(result.name).toBe('x');
    expect(result.body).toBe('body');
  });
});

describe('parseMemoryFile', () => {
  it('parses a complete memory file', async () => {
    const filePath = path.join(tmpDir, 'feedback_example.md');
    fs.writeFileSync(
      filePath,
      '---\nname: example\ndescription: sample feedback\ntype: feedback\n---\n\nRefers to ./src/index.ts in the body.\n',
    );

    const entry = await parseMemoryFile(filePath, 'C--projects-example');

    expect(entry.filePath).toBe(filePath);
    expect(entry.projectDir).toBe('C--projects-example');
    expect(entry.name).toBe('example');
    expect(entry.description).toBe('sample feedback');
    expect(entry.type).toBe('feedback');
    expect(entry.referencedPaths).toContain('./src/index.ts');
  });

  it('parses a memory file without frontmatter', async () => {
    const filePath = path.join(tmpDir, 'bare.md');
    fs.writeFileSync(filePath, 'Just prose, no frontmatter, no paths.\n');

    const entry = await parseMemoryFile(filePath, 'proj');

    expect(entry.name).toBeUndefined();
    expect(entry.description).toBeUndefined();
    expect(entry.type).toBeUndefined();
    expect(entry.referencedPaths).toEqual([]);
  });
});
