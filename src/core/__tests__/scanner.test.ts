import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { scanForContextFiles, scanForMcpConfigs, scanGlobalMcpConfigs } from '../scanner.js';

const FIXTURES = path.resolve(__dirname, '../../../fixtures');

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-scan-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('scanner', () => {
  it('finds CLAUDE.md in a project', async () => {
    const files = await scanForContextFiles(path.join(FIXTURES, 'healthy-project'));
    expect(files.length).toBe(1);
    expect(files[0].relativePath).toBe('CLAUDE.md');
  });

  it('finds AGENTS.md', async () => {
    const files = await scanForContextFiles(path.join(FIXTURES, 'wrong-commands'));
    expect(files.length).toBe(1);
    expect(files[0].relativePath).toBe('AGENTS.md');
  });

  it('finds multiple context files', async () => {
    const files = await scanForContextFiles(path.join(FIXTURES, 'multiple-files'));
    expect(files.length).toBeGreaterThanOrEqual(3);
    const names = files.map((f) => f.relativePath);
    expect(names).toContain('CLAUDE.md');
    expect(names).toContain('AGENTS.md');
    expect(names).toContain('.cursorrules');
  });

  it('returns empty for directory with no context files', async () => {
    const files = await scanForContextFiles(path.join(FIXTURES, 'healthy-project', 'src'));
    expect(files.length).toBe(0);
  });

  it('finds .mdc and .windsurf/rules/*.md files', async () => {
    const files = await scanForContextFiles(path.join(FIXTURES, 'frontmatter'));
    const names = files.map((f) => f.relativePath);
    expect(names.some((n) => n.endsWith('.mdc'))).toBe(true);
    expect(names.some((n) => n.includes('.windsurf/rules/'))).toBe(true);
  });

  it('finds .github/instructions/*.md files', async () => {
    const files = await scanForContextFiles(path.join(FIXTURES, 'frontmatter'));
    const names = files.map((f) => f.relativePath);
    expect(names.some((n) => n.includes('.github/instructions/'))).toBe(true);
  });

  it('respects depth option', async () => {
    const filesDepth0 = await scanForContextFiles(path.join(FIXTURES, 'multiple-files'), {
      depth: 0,
    });
    const filesDefault = await scanForContextFiles(path.join(FIXTURES, 'multiple-files'));
    // depth 0 means only root, should be same or fewer files
    expect(filesDepth0.length).toBeLessThanOrEqual(filesDefault.length);
  });

  it('skips ignored directories (node_modules, .git, dist, build, vendor)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), 'root');
    for (const dir of ['node_modules', '.git', 'dist', 'build', 'vendor']) {
      fs.mkdirSync(path.join(tmpDir, dir));
      fs.writeFileSync(path.join(tmpDir, dir, 'CLAUDE.md'), 'junk');
    }
    const files = await scanForContextFiles(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0].relativePath).toBe('CLAUDE.md');
  });

  it('skips dotdirs at depth traversal (unless explicitly in a pattern)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), 'root');
    fs.mkdirSync(path.join(tmpDir, '.hidden'));
    fs.writeFileSync(path.join(tmpDir, '.hidden', 'CLAUDE.md'), 'ignored');
    const files = await scanForContextFiles(tmpDir);
    const paths = files.map((f) => f.relativePath.replace(/\\/g, '/'));
    expect(paths).not.toContain('.hidden/CLAUDE.md');
  });

  it('extraPatterns merges with built-in patterns', async () => {
    fs.writeFileSync(path.join(tmpDir, 'CONVENTIONS.md'), '# conventions');
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# claude');
    const files = await scanForContextFiles(tmpDir, { extraPatterns: ['CONVENTIONS.md'] });
    const names = files.map((f) => f.relativePath);
    expect(names).toContain('CONVENTIONS.md');
    expect(names).toContain('CLAUDE.md');
  });

  it('deduplicates files discovered by overlapping patterns', async () => {
    // CLAUDE.md matches the built-in pattern AND an extraPatterns entry
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# claude');
    const files = await scanForContextFiles(tmpDir, { extraPatterns: ['CLAUDE.md'] });
    expect(files.filter((f) => f.relativePath === 'CLAUDE.md')).toHaveLength(1);
  });

  it('returns results sorted by relative path', async () => {
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# z');
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# a');
    const files = await scanForContextFiles(tmpDir);
    const names = files.map((f) => f.relativePath);
    expect(names).toEqual([...names].sort());
  });

  // Symlink creation on Windows typically requires admin; skip on failure.
  it('marks symlinked files with isSymlink: true', async () => {
    const target = path.join(tmpDir, 'target.md');
    const link = path.join(tmpDir, 'CLAUDE.md');
    fs.writeFileSync(target, '# target');
    try {
      fs.symlinkSync(target, link);
    } catch {
      return; // symlinks unsupported in this env
    }
    const files = await scanForContextFiles(tmpDir);
    const claude = files.find((f) => f.relativePath === 'CLAUDE.md');
    expect(claude?.isSymlink).toBe(true);
    expect(claude?.symlinkTarget).toBe(target);
  });
});

describe('nested-dotdir pattern discovery (regression guard)', () => {
  // Each entry: relative path inside the project. Walking the full
  // CONTEXT_FILE_PATTERNS list via one parameterized test so an accidental
  // pattern removal from scanner.ts breaks visibly.
  it.each([
    { pattern: '.claude/rules/r.md' },
    { pattern: '.clinerules/r.md' },
    { pattern: '.continue/rules/r.md' },
    { pattern: '.aiassistant/rules/r.md' },
    { pattern: '.junie/guidelines.md' },
    { pattern: '.junie/AGENTS.md' },
    { pattern: '.aide/rules/r.md' },
    { pattern: '.amazonq/rules/r.md' },
    { pattern: '.goose/instructions.md' },
    { pattern: '.github/copilot-instructions.md' },
    { pattern: '.github/git-commit-instructions.md' },
    { pattern: '.cursor/rules/r.md' },
  ])('discovers $pattern', async ({ pattern }) => {
    const full = path.join(tmpDir, pattern);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '# rule');
    const files = await scanForContextFiles(tmpDir);
    const paths = files.map((f) => f.relativePath.replace(/\\/g, '/'));
    expect(paths).toContain(pattern);
  });
});

describe('scanForMcpConfigs', () => {
  it('returns empty array when no MCP configs exist', async () => {
    const files = await scanForMcpConfigs(tmpDir);
    expect(files).toEqual([]);
  });

  it('discovers .mcp.json at project root', async () => {
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), '{}');
    const files = await scanForMcpConfigs(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0].relativePath).toBe('.mcp.json');
    expect(files[0].type).toBe('mcp-config');
  });

  it('discovers .cursor/mcp.json and .vscode/mcp.json', async () => {
    fs.mkdirSync(path.join(tmpDir, '.cursor'));
    fs.mkdirSync(path.join(tmpDir, '.vscode'));
    fs.writeFileSync(path.join(tmpDir, '.cursor', 'mcp.json'), '{}');
    fs.writeFileSync(path.join(tmpDir, '.vscode', 'mcp.json'), '{}');
    const files = await scanForMcpConfigs(tmpDir);
    const paths = files.map((f) => f.relativePath.replace(/\\/g, '/'));
    expect(paths).toContain('.cursor/mcp.json');
    expect(paths).toContain('.vscode/mcp.json');
  });

  it('returns results sorted by relative path', async () => {
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), '{}');
    fs.mkdirSync(path.join(tmpDir, '.cursor'));
    fs.writeFileSync(path.join(tmpDir, '.cursor', 'mcp.json'), '{}');
    const files = await scanForMcpConfigs(tmpDir);
    const names = files.map((f) => f.relativePath);
    expect(names).toEqual([...names].sort());
  });
});

describe('scanGlobalMcpConfigs', () => {
  it('returns an array (env-dependent; may be empty or populated)', async () => {
    const files = await scanGlobalMcpConfigs();
    expect(Array.isArray(files)).toBe(true);
    // Whatever it finds must be marked as mcp-config type and ~/-prefixed
    for (const f of files) {
      expect(f.type).toBe('mcp-config');
      expect(f.relativePath.startsWith('~/')).toBe(true);
    }
  });
});

describe('scanGlobalMcpConfigs home resolution', () => {
  let savedHome: string | undefined;
  let savedUserprofile: string | undefined;
  let savedAppdata: string | undefined;
  let fakeHome: string;

  beforeEach(() => {
    savedHome = process.env.HOME;
    savedUserprofile = process.env.USERPROFILE;
    savedAppdata = process.env.APPDATA;
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-mcp-home-'));
    // Keep the win32 Claude Desktop probe inside the sandbox so a real
    // workstation config can't leak into the results.
    process.env.APPDATA = path.join(fakeHome, 'AppData', 'Roaming');
    delete process.env.HOME;
    delete process.env.USERPROFILE;
  });

  afterEach(() => {
    vi.doUnmock('node:os');
    vi.resetModules();
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserprofile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserprofile;
    if (savedAppdata === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = savedAppdata;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  // scanner.ts binds `homedir` at import time, so the mock has to land before
  // a fresh module instance is created.
  async function importScannerWithHomedir(dir: string) {
    vi.resetModules();
    vi.doMock('node:os', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:os')>();
      return { ...actual, homedir: () => dir };
    });
    return import('../scanner.js');
  }

  it('falls back to os.homedir() when HOME and USERPROFILE are unset', async () => {
    // Env-stripped contexts (systemd services, minimal containers) must scan
    // the OS-resolved home -- the same resolution the session and skill
    // pillars use -- instead of silently returning [].
    fs.mkdirSync(path.join(fakeHome, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, '.cursor', 'mcp.json'), '{"mcpServers":{}}');

    const mod = await importScannerWithHomedir(fakeHome);
    const files = await mod.scanGlobalMcpConfigs();
    expect(files.map((f) => f.relativePath)).toContain('~/.cursor/mcp.json');
  });

  it('prefers HOME over os.homedir() when both resolve', async () => {
    // The config exists only under the env home -- finding it proves the
    // env-first ordering (the mocked os home has no configs).
    const envHome = path.join(fakeHome, 'env-home');
    fs.mkdirSync(path.join(envHome, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(envHome, '.cursor', 'mcp.json'), '{"mcpServers":{}}');
    process.env.HOME = envHome;

    const mod = await importScannerWithHomedir(path.join(fakeHome, 'os-home-without-configs'));
    const files = await mod.scanGlobalMcpConfigs();
    expect(files.map((f) => f.relativePath)).toContain('~/.cursor/mcp.json');
  });

  it('returns [] when no home resolves at all (env unset, os.homedir empty)', async () => {
    // With home === '' every entry would degrade to a RELATIVE path
    // (path.join('', '.claude.json') === '.claude.json') that accessSync
    // resolves against process.cwd() -- picking up a project-local file and
    // reporting it as '~/.claude.json'. The scan must bail out early instead.
    const mod = await importScannerWithHomedir('');
    const files = await mod.scanGlobalMcpConfigs();
    expect(files).toEqual([]);
  });
});

describe('nested-dotted dir discovery (fix 1)', () => {
  // The blanket `!entry.name.startsWith('.')` skip in collectDirs prevented
  // the walker from descending INTO `.claude/`, `.cursor/`, `.github/`, etc.
  // -- so bare-named files like AGENTS.md / CLAUDE.md sitting inside a
  // nested-dotted dir were invisible. These guards make sure the allowlist
  // walk recovers those cases.

  it('finds AGENTS.md inside .claude/ at the project root', async () => {
    // Bare AGENTS.md pattern only matches directly inside scanned dirs --
    // before fix 1, .claude/ was skipped and AGENTS.md inside it was lost.
    const dir = path.join(tmpDir, '.claude');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# nested');
    const files = await scanForContextFiles(tmpDir);
    const paths = files.map((f) => f.relativePath.replace(/\\/g, '/'));
    expect(paths).toContain('.claude/AGENTS.md');
  });

  it('finds AGENTS.md inside packages/foo/.claude/ when depth allows', async () => {
    // Same shape one level deeper -- the walker needs the explicit depth
    // bump to reach the nested .claude/, but fix 1 is what lets it descend
    // INTO that dir once reached.
    const dir = path.join(tmpDir, 'packages', 'foo', '.claude');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# nested');
    const files = await scanForContextFiles(tmpDir, { depth: 3 });
    const paths = files.map((f) => f.relativePath.replace(/\\/g, '/'));
    expect(paths).toContain('packages/foo/.claude/AGENTS.md');
  });

  it('finds .claude/rules/x.md in a deeply-nested subpackage', async () => {
    const dir = path.join(tmpDir, 'packages', 'foo', '.claude', 'rules');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'x.md'), '# rule');
    const files = await scanForContextFiles(tmpDir);
    const paths = files.map((f) => f.relativePath.replace(/\\/g, '/'));
    expect(paths).toContain('packages/foo/.claude/rules/x.md');
  });

  it('still skips non-allowlisted dotted dirs (e.g. .hidden, .cache)', async () => {
    fs.mkdirSync(path.join(tmpDir, '.hidden'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.hidden', 'AGENTS.md'), '# should-not-find');
    fs.mkdirSync(path.join(tmpDir, '.cache'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.cache', 'AGENTS.md'), '# should-not-find');
    const files = await scanForContextFiles(tmpDir);
    const paths = files.map((f) => f.relativePath.replace(/\\/g, '/'));
    expect(paths).not.toContain('.hidden/AGENTS.md');
    expect(paths).not.toContain('.cache/AGENTS.md');
  });
});

describe('mcpFileHasMcpKey prefix-only read (fix 2)', () => {
  // scanGlobalMcpConfigs gates `~/.claude.json` and `~/.claude/settings.json`
  // through a cheap text-only peek. The peek must (a) detect the mcpServers
  // key when present in the file's first 8KB, and (b) NOT read past the
  // prefix -- a key buried at byte 1MB inside a multi-MB file should look
  // like "no mcp key" from the peek's perspective.
  //
  // We exercise the peek through scanGlobalMcpConfigs by pointing HOME at a
  // throwaway dir, then asserting whether `.claude.json` is included in the
  // returned set.

  let savedHome: string | undefined;
  let savedUserprofile: string | undefined;

  beforeEach(() => {
    savedHome = process.env.HOME;
    savedUserprofile = process.env.USERPROFILE;
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserprofile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserprofile;
  });

  it('detects mcpServers when it appears in the first 8KB of a large file', async () => {
    const claudeJson = path.join(tmpDir, '.claude.json');
    // mcpServers key right at the top, then ~5MB of filler. The peek should
    // hit the key in its 8KB prefix read and INCLUDE the file in results.
    const body = '{"mcpServers":{"x":{"command":"node"}},"filler":"' + 'x'.repeat(5_000_000) + '"}';
    fs.writeFileSync(claudeJson, body);
    const files = await scanGlobalMcpConfigs();
    const paths = files.map((f) => f.relativePath);
    expect(paths).toContain('~/.claude.json');
  });

  it('does NOT detect mcpServers when key is buried past the 8KB prefix', async () => {
    const claudeJson = path.join(tmpDir, '.claude.json');
    // 50KB of leading filler, THEN the mcpServers key. The 8KB prefix peek
    // must miss it and the file must be SKIPPED.
    const filler = '"a":"' + 'x'.repeat(50_000) + '",';
    const body = '{' + filler + '"mcpServers":{"x":{"command":"node"}}}';
    fs.writeFileSync(claudeJson, body);
    const files = await scanGlobalMcpConfigs();
    const paths = files.map((f) => f.relativePath);
    expect(paths).not.toContain('~/.claude.json');
  });

  it('completes the peek fast on a large file (no full read)', async () => {
    const claudeJson = path.join(tmpDir, '.claude.json');
    // 10MB file -- a full readFileSync would take noticeably longer than a
    // prefix read. Detection should succeed since the key sits in the prefix.
    const body =
      '{"mcpServers":{"x":{"command":"node"}},"filler":"' + 'x'.repeat(10_000_000) + '"}';
    fs.writeFileSync(claudeJson, body);
    const start = Date.now();
    const files = await scanGlobalMcpConfigs();
    const elapsed = Date.now() - start;
    expect(files.map((f) => f.relativePath)).toContain('~/.claude.json');
    // Generous bound -- a true full-read of 10MB is ~50-200ms on most disks,
    // a prefix read is <5ms. 250ms catches the regression without flaking.
    expect(elapsed).toBeLessThan(250);
  });

  it('handles files smaller than the 8KB prefix', async () => {
    const claudeJson = path.join(tmpDir, '.claude.json');
    fs.writeFileSync(claudeJson, '{"mcpServers":{"x":{"command":"node"}}}');
    const files = await scanGlobalMcpConfigs();
    expect(files.map((f) => f.relativePath)).toContain('~/.claude.json');
  });

  it('skips a small general .claude.json with no mcp key', async () => {
    const claudeJson = path.join(tmpDir, '.claude.json');
    fs.writeFileSync(claudeJson, '{"theme":"dark","other":"setting"}');
    const files = await scanGlobalMcpConfigs();
    expect(files.map((f) => f.relativePath)).not.toContain('~/.claude.json');
  });
});
