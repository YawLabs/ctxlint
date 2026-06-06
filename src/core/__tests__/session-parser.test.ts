import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  classifyPath,
  encodeProjectDir,
  extractPaths,
  parseFrontmatter,
  parseMemoryFile,
  projectDirMatchesPath,
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

  it('extracts bare relative paths with file extensions (no leading ./)', () => {
    const paths = extractPaths('The auth middleware lives in src/api/middleware.ts somewhere.');
    expect(paths).toContain('src/api/middleware.ts');
  });

  it('does not match prose tokens like "I/O" or "Vitest/Jest" that lack a file extension', () => {
    const paths = extractPaths('We use Vitest/Jest for I/O testing and n/a otherwise.');
    expect(paths).toEqual([]);
  });

  it('does not match a single segment without a slash', () => {
    const paths = extractPaths('See package.json for the scripts.');
    expect(paths).toEqual([]);
  });

  it('extracts Windows drive-absolute forward-slash paths', () => {
    const paths = extractPaths('The handler is at C:/Users/jeff/foo.ts in the repo.');
    expect(paths).toContain('C:/Users/jeff/foo.ts');
  });

  it('extracts Windows drive-absolute backslash paths', () => {
    const paths = extractPaths('The handler is at C:\\Users\\jeff\\foo.ts in the repo.');
    expect(paths).toContain('C:\\Users\\jeff\\foo.ts');
  });

  it('does not match prose colons that are not drive letters', () => {
    const paths = extractPaths('note: this is fine and n/a otherwise.');
    expect(paths).toEqual([]);
  });
});

describe('classifyPath', () => {
  it('classifies slash commands', () => {
    expect(classifyPath('/yaw-review')).toBe('slash-command');
    expect(classifyPath('/release-yaw')).toBe('slash-command');
    expect(classifyPath('/yaw-session-audit')).toBe('slash-command');
  });

  it('classifies tilde approximations', () => {
    expect(classifyPath('~80%')).toBe('approximation');
    expect(classifyPath('~23h')).toBe('approximation');
    expect(classifyPath('~1KB')).toBe('approximation');
    expect(classifyPath('~600')).toBe('approximation');
    expect(classifyPath('~Nx')).toBe('approximation');
  });

  it('classifies URL paths via known web first segments', () => {
    expect(classifyPath('/blog')).toBe('url-path');
    expect(classifyPath('/docs')).toBe('url-path');
    expect(classifyPath('/api/webhooks/lemonsqueezy')).toBe('url-path');
  });

  it('classifies URL paths via co-occurring base URL', () => {
    expect(classifyPath('/internal-page', { baseUrls: ['https://mcp.hosting'] })).toBe('url-path');
  });

  it('classifies template placeholders', () => {
    expect(classifyPath('~/.claude/skills/<name>/SKILL.md')).toBe('template');
    expect(classifyPath('src/{{module}}/index.ts')).toBe('template');
  });

  it('still returns fs-path for real paths', () => {
    expect(classifyPath('~/.bashrc')).toBe('fs-path');
    expect(classifyPath('~/projects/foo/index.ts')).toBe('fs-path');
    expect(classifyPath('/var/log/app.log')).toBe('fs-path');
    expect(classifyPath('./src/index.ts')).toBe('fs-path');
    expect(classifyPath('src/api/middleware.ts')).toBe('fs-path');
  });

  it('returns fs-path for url-shaped paths that carry a file extension', () => {
    // The classifier's URL-path rule is gated on "no extension" -- a /api
    // path with .json or .yaml is almost certainly a real file (manifest,
    // config) rather than a route. Keep it as fs-path so the stale-memory
    // check can verify it.
    expect(classifyPath('/api/foo.json')).toBe('fs-path');
    expect(classifyPath('/docs/index.html')).toBe('fs-path');
    expect(classifyPath('/blog/post.md')).toBe('fs-path');
  });

  it('returns fs-path for /-rooted paths whose first segment is not a known web segment', () => {
    // Without a base URL hint, /var, /etc, /usr, /opt should all stay fs-path
    // even though they have no file extension.
    expect(classifyPath('/var/log')).toBe('fs-path');
    expect(classifyPath('/etc/hosts')).toBe('fs-path');
    expect(classifyPath('/usr/local/bin')).toBe('fs-path');
  });
});

describe('extractPaths -- mcp-hosting false-positive regression', () => {
  it('drops slash-command tokens', () => {
    const paths = extractPaths('Use /yaw-review before /release-yaw');
    expect(paths).not.toContain('/yaw-review');
    expect(paths).not.toContain('/release-yaw');
  });

  it('drops tilde approximations', () => {
    const paths = extractPaths('Took ~23h, saved ~80%, footprint ~1KB');
    expect(paths.filter((p) => p.startsWith('~'))).toEqual([]);
  });

  it('drops URL paths when a base URL is in the same memory', () => {
    const paths = extractPaths('See https://mcp.hosting/blog and /docs and /api/health');
    expect(paths).not.toContain('/blog');
    expect(paths).not.toContain('/docs');
    expect(paths).not.toContain('/api/health');
  });

  it('drops template placeholder paths', () => {
    const paths = extractPaths('Skill files live at ~/.claude/skills/<name>/SKILL.md');
    expect(paths).not.toContain('~/.claude/skills/<name>/SKILL.md');
  });

  it('still extracts real paths in the same content', () => {
    const paths = extractPaths('See /var/log/app.log, /yaw-review, and ~/projects/foo/x.ts');
    expect(paths).toContain('/var/log/app.log');
    expect(paths).toContain('~/projects/foo/x.ts');
    expect(paths).not.toContain('/yaw-review');
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
