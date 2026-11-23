import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  RootKeyScanner,
  scanForContextFiles,
  scanForMcpConfigs,
  scanGlobalMcpConfigs,
} from '../scanner.js';
import { parseMcpConfig } from '../mcp-parser.js';

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
    // One file per level, so each depth step must add exactly one file.
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), 'root');
    fs.mkdirSync(path.join(tmpDir, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'a', 'CLAUDE.md'), 'one');
    fs.writeFileSync(path.join(tmpDir, 'a', 'b', 'CLAUDE.md'), 'two');
    const at = async (depth: number) =>
      (await scanForContextFiles(tmpDir, { depth })).map((f) => f.relativePath);
    expect(await at(0)).toEqual(['CLAUDE.md']);
    expect(await at(1)).toEqual(['CLAUDE.md', 'a/CLAUDE.md']);
    expect(await at(2)).toEqual(['CLAUDE.md', 'a/CLAUDE.md', 'a/b/CLAUDE.md']);
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

  // Symlink whose real target is outside the project root must be excluded.
  it('skips a context-file symlink whose target escapes the project root', async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-outside-'));
    const outsideTarget = path.join(outsideDir, 'secret.md');
    fs.writeFileSync(outsideTarget, '# outside the project root');
    const link = path.join(tmpDir, 'CLAUDE.md');
    try {
      fs.symlinkSync(outsideTarget, link);
    } catch {
      fs.rmSync(outsideDir, { recursive: true, force: true });
      return; // symlinks unsupported in this env
    }
    try {
      const files = await scanForContextFiles(tmpDir);
      expect(files.find((f) => f.relativePath === 'CLAUDE.md')).toBeUndefined();
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  // 5 MB cap: a file whose byte count exceeds MAX_FILE_BYTES must be excluded.
  it('skips a context file larger than the 5 MB cap', async () => {
    const filePath = path.join(tmpDir, 'CLAUDE.md');
    fs.writeFileSync(filePath, Buffer.alloc(5 * 1024 * 1024 + 1, 'x'));
    const files = await scanForContextFiles(tmpDir);
    expect(files.find((f) => f.relativePath === 'CLAUDE.md')).toBeUndefined();
  });

  it('includes a context file at exactly the 5 MB cap', async () => {
    const filePath = path.join(tmpDir, 'CLAUDE.md');
    fs.writeFileSync(filePath, Buffer.alloc(5 * 1024 * 1024, 'x'));
    const files = await scanForContextFiles(tmpDir);
    expect(files.find((f) => f.relativePath === 'CLAUDE.md')).toBeDefined();
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

  it('discovers every MCP_CONFIG_PATTERN family in a single batched call', async () => {
    // One file per pattern family -- guards against a regression where the
    // batched glob (array of patterns in one call) accidentally drops patterns.
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), '{}');
    fs.mkdirSync(path.join(tmpDir, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.cursor', 'mcp.json'), '{}');
    fs.mkdirSync(path.join(tmpDir, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.vscode', 'mcp.json'), '{}');
    fs.mkdirSync(path.join(tmpDir, '.amazonq'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.amazonq', 'mcp.json'), '{}');
    fs.mkdirSync(path.join(tmpDir, '.continue', 'mcpServers'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.continue', 'mcpServers', 'my-server.json'), '{}');

    const files = await scanForMcpConfigs(tmpDir);
    const rel = files.map((f) => f.relativePath.replace(/\\/g, '/'));
    expect(rel).toContain('.mcp.json');
    expect(rel).toContain('.cursor/mcp.json');
    expect(rel).toContain('.vscode/mcp.json');
    expect(rel).toContain('.amazonq/mcp.json');
    expect(rel).toContain('.continue/mcpServers/my-server.json');
  });

  // Symlink whose real target is outside the project root must be excluded
  // (mirrors the context-scan guard) -- isExcludedScanTarget must fire on the
  // MCP path too, not just the context path.
  it('skips an MCP-config symlink whose target escapes the project root', async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-outside-'));
    const outsideTarget = path.join(outsideDir, 'secret.json');
    fs.writeFileSync(outsideTarget, '{"mcpServers":{}}');
    const link = path.join(tmpDir, '.mcp.json');
    try {
      fs.symlinkSync(outsideTarget, link);
    } catch {
      fs.rmSync(outsideDir, { recursive: true, force: true });
      return; // symlinks unsupported in this env
    }
    try {
      const files = await scanForMcpConfigs(tmpDir);
      expect(files.find((f) => f.relativePath === '.mcp.json')).toBeUndefined();
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

describe('scanGlobalMcpConfigs', () => {
  const ENV_KEYS = ['HOME', 'USERPROFILE', 'APPDATA', 'XDG_CONFIG_HOME'] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    // Isolate every home-ish variable so the real workstation never leaks in.
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;
    process.env.APPDATA = path.join(tmpDir, 'AppData', 'Roaming');
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, '.config');
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('returns [] for an empty home', async () => {
    expect(await scanGlobalMcpConfigs()).toEqual([]);
  });

  it('reports found configs as ~/-prefixed mcp-config entries in code-unit order', async () => {
    fs.mkdirSync(path.join(tmpDir, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.cursor', 'mcp.json'), '{"mcpServers":{}}');
    fs.mkdirSync(path.join(tmpDir, '.aws', 'amazonq'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.aws', 'amazonq', 'mcp.json'), '{"mcpServers":{}}');
    const files = await scanGlobalMcpConfigs();
    expect(files.map((f) => f.relativePath)).toEqual([
      '~/.aws/amazonq/mcp.json',
      '~/.cursor/mcp.json',
    ]);
    for (const f of files) expect(f.type).toBe('mcp-config');
  });

  it("discovers Cline's MCP settings in the VS Code extension's globalStorage", async () => {
    const userDir =
      process.platform === 'win32'
        ? path.join(tmpDir, 'AppData', 'Roaming', 'Code', 'User')
        : process.platform === 'darwin'
          ? path.join(tmpDir, 'Library', 'Application Support', 'Code', 'User')
          : path.join(tmpDir, '.config', 'Code', 'User');
    const settings = path.join(
      userDir,
      'globalStorage',
      'saoudrizwan.claude-dev',
      'settings',
      'cline_mcp_settings.json',
    );
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, '{"mcpServers":{}}');
    const files = await scanGlobalMcpConfigs();
    const found = files.find((f) => f.absolutePath === path.normalize(settings));
    expect(found).toBeDefined();
    expect(found!.relativePath.endsWith('/cline_mcp_settings.json')).toBe(true);
  });

  it("discovers the Cline CLI's MCP settings under ~/.cline/data/settings", async () => {
    const saved = process.env.CLINE_MCP_SETTINGS_PATH;
    delete process.env.CLINE_MCP_SETTINGS_PATH;
    try {
      const settings = path.join(tmpDir, '.cline', 'data', 'settings', 'cline_mcp_settings.json');
      fs.mkdirSync(path.dirname(settings), { recursive: true });
      fs.writeFileSync(settings, '{"mcpServers":{}}');
      const files = await scanGlobalMcpConfigs();
      expect(files.map((f) => f.relativePath)).toContain(
        '~/.cline/data/settings/cline_mcp_settings.json',
      );
    } finally {
      if (saved !== undefined) process.env.CLINE_MCP_SETTINGS_PATH = saved;
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

describe('mcpFileHasMcpKey peek (fix 2)', () => {
  // scanGlobalMcpConfigs gates `~/.claude.json` and `~/.claude/settings.json`
  // through a cheap text-only peek that STREAMS the file. For `.claude.json`
  // -- Claude Code's own state file, where projects/history precede
  // `mcpServers` and push the key well past any fixed prefix on real
  // workstations -- it must detect the key wherever it sits, bailing as soon
  // as it matches (so a key near the top still avoids a full read). Only a
  // TOP-LEVEL key counts.
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

  it('detects mcpServers in .claude.json when the key is buried past 8KB', async () => {
    const claudeJson = path.join(tmpDir, '.claude.json');
    // 50KB of leading filler (the projects/history Claude Code writes ahead
    // of mcpServers on a real workstation), THEN the mcpServers key. The
    // streaming scan must read past the 8KB prefix and INCLUDE the file --
    // the old prefix-only peek dropped it silently.
    const filler = '"a":"' + 'x'.repeat(50_000) + '",';
    const body = '{' + filler + '"mcpServers":{"x":{"command":"node"}}}';
    fs.writeFileSync(claudeJson, body);
    const files = await scanGlobalMcpConfigs();
    const paths = files.map((f) => f.relativePath);
    expect(paths).toContain('~/.claude.json');
  });

  it('detects mcpServers in .claude.json when the key straddles a chunk boundary', async () => {
    const claudeJson = path.join(tmpDir, '.claude.json');
    // Pad so the `"mcpServers":` token lands across a 64KB chunk boundary --
    // the carry-over overlap between chunks must prevent the split from
    // hiding the match. 64KB minus a few bytes of leading filler puts the key
    // right on the seam.
    const filler = '"a":"' + 'x'.repeat(64 * 1024 - 6) + '",';
    const body = '{' + filler + '"mcpServers":{"x":{"command":"node"}}}';
    fs.writeFileSync(claudeJson, body);
    const files = await scanGlobalMcpConfigs();
    const paths = files.map((f) => f.relativePath);
    expect(paths).toContain('~/.claude.json');
  });

  it('skips a large .claude.json with NO mcp key anywhere', async () => {
    const claudeJson = path.join(tmpDir, '.claude.json');
    // 100KB of general state, no mcpServers/servers key -- the streaming scan
    // reads to EOF and the file is correctly excluded.
    const body = '{"projects":"' + 'x'.repeat(100_000) + '","theme":"dark"}';
    fs.writeFileSync(claudeJson, body);
    const files = await scanGlobalMcpConfigs();
    const paths = files.map((f) => f.relativePath);
    expect(paths).not.toContain('~/.claude.json');
  });

  it('bails early on a large file when the key sits near the top (no full read)', async () => {
    const claudeJson = path.join(tmpDir, '.claude.json');
    // 10MB file with the key at the very top. The streaming scan must match
    // on the first chunk and return WITHOUT reading the remaining ~10MB.
    const body =
      '{"mcpServers":{"x":{"command":"node"}},"filler":"' + 'x'.repeat(10_000_000) + '"}';
    fs.writeFileSync(claudeJson, body);
    // Count the bytes actually read instead of timing the call: a wall-clock
    // bound flakes under load, while the read volume is deterministic.
    const realOpen = fs.promises.open.bind(fs.promises);
    let bytesRead = 0;
    const spy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...(args as Parameters<typeof realOpen>));
      const realRead = handle.read.bind(handle) as (
        ...a: unknown[]
      ) => Promise<{ bytesRead: number }>;
      Object.assign(handle, {
        read: async (...readArgs: unknown[]) => {
          const r = await realRead(...readArgs);
          bytesRead += r.bytesRead;
          return r;
        },
      });
      return handle;
    });
    try {
      const files = await scanGlobalMcpConfigs();
      expect(files.map((f) => f.relativePath)).toContain('~/.claude.json');
      expect(bytesRead).toBeGreaterThan(0);
      expect(bytesRead).toBeLessThanOrEqual(64 * 1024);
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps a .claude.json whose only servers are per-project (plain `claude mcp add`)', async () => {
    // Local-scope servers live at projects.<path>.mcpServers; the gate used to
    // demand a top-level key, so mcp-parser's per-project linting never ran.
    const claudeJson = path.join(tmpDir, '.claude.json');
    fs.writeFileSync(
      claudeJson,
      JSON.stringify(
        {
          numStartups: 3,
          projects: {
            '/other': { mcpServers: {} },
            '/repo': { allowedTools: [], mcpServers: { x: { command: 'node' } } },
          },
        },
        null,
        2,
      ),
    );
    const files = await scanGlobalMcpConfigs();
    const found = files.find((f) => f.relativePath === '~/.claude.json');
    expect(found).toBeDefined();
    const config = await parseMcpConfig(found!, tmpDir, 'global');
    expect(config.servers.map((s) => s.name)).toEqual(['x']);
  });

  it('skips a .claude.json whose per-project mcpServers blocks are all empty', async () => {
    // Claude Code writes `"mcpServers": {}` for every project it has opened;
    // that alone must not pull a clean workstation's state file in.
    fs.writeFileSync(
      path.join(tmpDir, '.claude.json'),
      JSON.stringify({ projects: { '/a': { mcpServers: {} }, '/b': { mcpServers: {} } } }),
    );
    const files = await scanGlobalMcpConfigs();
    expect(files.map((f) => f.relativePath)).not.toContain('~/.claude.json');
  });

  it('does not take projects.* mcpServers from ~/.claude/settings.json', async () => {
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.claude', 'settings.json'),
      JSON.stringify({ projects: { '/repo': { mcpServers: { x: {} } } } }),
    );
    const files = await scanGlobalMcpConfigs();
    expect(files.map((f) => f.relativePath)).not.toContain('~/.claude/settings.json');
  });

  it('skips a .claude.json that mentions "mcpServers": only inside a string value', async () => {
    fs.writeFileSync(
      path.join(tmpDir, '.claude.json'),
      JSON.stringify({ note: '"mcpServers": {}', other: 1 }),
    );
    const files = await scanGlobalMcpConfigs();
    expect(files.map((f) => f.relativePath)).not.toContain('~/.claude.json');
  });

  it('finds a top-level key that follows a nested one', async () => {
    fs.writeFileSync(
      path.join(tmpDir, '.claude.json'),
      JSON.stringify({ projects: { '/r': { mcpServers: {} } }, mcpServers: { x: {} } }),
    );
    const files = await scanGlobalMcpConfigs();
    expect(files.map((f) => f.relativePath)).toContain('~/.claude.json');
  });

  it('applies the top-level gate to ~/.claude/settings.json too', async () => {
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
    const settings = path.join(tmpDir, '.claude', 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({ permissions: { servers: [] } }));
    expect((await scanGlobalMcpConfigs()).map((f) => f.relativePath)).not.toContain(
      '~/.claude/settings.json',
    );
    fs.writeFileSync(settings, JSON.stringify({ mcpServers: {} }));
    expect((await scanGlobalMcpConfigs()).map((f) => f.relativePath)).toContain(
      '~/.claude/settings.json',
    );
  });

  describe('with CLAUDE_CONFIG_DIR set', () => {
    let savedConfigDir: string | undefined;
    let configDir: string;

    beforeEach(() => {
      savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
      configDir = path.join(tmpDir, 'claude-cfg');
      fs.mkdirSync(configDir, { recursive: true });
      process.env.CLAUDE_CONFIG_DIR = configDir;
    });

    afterEach(() => {
      if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    });

    it('reads .claude.json from inside CLAUDE_CONFIG_DIR', async () => {
      // Claude Code keeps its state file in the config dir when the override
      // is set; a stale ~/.claude.json must not win over it.
      fs.writeFileSync(path.join(configDir, '.claude.json'), '{"mcpServers":{"x":{}}}');
      fs.writeFileSync(path.join(tmpDir, '.claude.json'), '{"mcpServers":{"stale":{}}}');
      const files = await scanGlobalMcpConfigs();
      const paths = files.map((f) => f.absolutePath);
      expect(paths).toContain(path.normalize(path.join(configDir, '.claude.json')));
      expect(paths).not.toContain(path.normalize(path.join(tmpDir, '.claude.json')));
    });

    it('falls back to ~/.claude.json when CLAUDE_CONFIG_DIR has none', async () => {
      fs.writeFileSync(path.join(tmpDir, '.claude.json'), '{"mcpServers":{"x":{}}}');
      const files = await scanGlobalMcpConfigs();
      expect(files.map((f) => f.relativePath)).toContain('~/.claude.json');
    });
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

describe('scanForContextFiles exclude option', () => {
  // Root CLAUDE.md plus two files under fixtures/ -- one at the top level of
  // that dir and one nested, so a `fixtures/**` glob has to match both depths.
  beforeEach(() => {
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# Root\n');
    fs.mkdirSync(path.join(tmpDir, 'fixtures', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'fixtures', 'AGENTS.md'), '# Fixture\n');
    fs.writeFileSync(path.join(tmpDir, 'fixtures', 'nested', 'CLAUDE.md'), '# Nested fixture\n');
  });

  it('drops every file under an excluded glob, at any depth', async () => {
    const files = await scanForContextFiles(tmpDir, { exclude: ['fixtures/**'] });
    expect(files.map((f) => f.relativePath)).toEqual(['CLAUDE.md']);
  });

  it('keeps everything when exclude is omitted', async () => {
    const files = await scanForContextFiles(tmpDir);
    expect(files.map((f) => f.relativePath).sort()).toEqual([
      'CLAUDE.md',
      'fixtures/AGENTS.md',
      'fixtures/nested/CLAUDE.md',
    ]);
  });

  it('treats an empty exclude array as no exclusion', async () => {
    const files = await scanForContextFiles(tmpDir, { exclude: [] });
    expect(files.length).toBe(3);
  });

  it('excludes only what the glob matches', async () => {
    // Negative control: a glob aimed at the nested dir must leave the sibling
    // fixture file alone, so a broad `fixtures/**` is not the only thing tested.
    const files = await scanForContextFiles(tmpDir, { exclude: ['fixtures/nested/**'] });
    expect(files.map((f) => f.relativePath).sort()).toEqual(['CLAUDE.md', 'fixtures/AGENTS.md']);
  });

  it('matches dotted directories (picomatch dot:true)', async () => {
    // Without { dot: true } inside matchesGlob, `.claude/**` silently matches
    // nothing and the exclusion looks configured but does nothing.
    fs.mkdirSync(path.join(tmpDir, '.claude', 'rules'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.claude', 'rules', 'a.md'), '# Rule\n');
    const withExclude = await scanForContextFiles(tmpDir, { exclude: ['.claude/**'] });
    expect(withExclude.map((f) => f.relativePath)).not.toContain('.claude/rules/a.md');
    const without = await scanForContextFiles(tmpDir);
    expect(without.map((f) => f.relativePath)).toContain('.claude/rules/a.md');
  });

  it('accepts multiple globs', async () => {
    const files = await scanForContextFiles(tmpDir, {
      exclude: ['fixtures/AGENTS.md', 'fixtures/nested/**'],
    });
    expect(files.map((f) => f.relativePath)).toEqual(['CLAUDE.md']);
  });
});

describe('RootKeyScanner', () => {
  const scan = (chunks: string[]) => {
    const sc = new RootKeyScanner(new Set(['mcpServers']));
    return chunks.some((c) => sc.feed(c));
  };

  it('matches a root key split across chunks at every position', () => {
    const text = '{"a":1,"mcpServers":{}}';
    for (let i = 1; i < text.length; i++) {
      expect(scan([text.slice(0, i), text.slice(i)]), `split at ${i}`).toBe(true);
    }
  });

  it('ignores nested keys, string contents (incl. escaped quotes) and array roots', () => {
    expect(scan(['{"x":{"mcpServers":{}}}'])).toBe(false);
    expect(scan([JSON.stringify({ x: '"mcpServers": 1' })])).toBe(false);
    expect(scan(['["mcpServers"]'])).toBe(false);
  });

  it('ignores a value equal to the key name', () => {
    expect(scan(['{"a":"mcpServers","b":1}'])).toBe(false);
  });

  describe('projectServers', () => {
    const scanProjects = (chunks: string[]) => {
      const sc = new RootKeyScanner(new Set(['mcpServers']), { projectServers: true });
      return chunks.some((c) => sc.feed(c));
    };
    const longPath = '/' + 'very-long-project-path/'.repeat(4);

    it('matches a non-empty projects.*.mcpServers, split at every position', () => {
      const text = JSON.stringify({ projects: { [longPath]: { mcpServers: { x: {} } } } }, null, 1);
      for (let i = 1; i < text.length; i++) {
        expect(scanProjects([text.slice(0, i), text.slice(i)]), `split at ${i}`).toBe(true);
      }
    });

    it('ignores empty blocks, other parents, deeper nesting and string contents', () => {
      expect(scanProjects([JSON.stringify({ projects: { '/a': { mcpServers: {} } } })])).toBe(
        false,
      );
      expect(scanProjects([JSON.stringify({ other: { '/a': { mcpServers: { x: {} } } } })])).toBe(
        false,
      );
      expect(
        scanProjects([JSON.stringify({ projects: { '/a': { n: { mcpServers: { x: {} } } } } })]),
      ).toBe(false);
      expect(scanProjects([JSON.stringify({ projects: { '/a': { mcpServers: [1] } } })])).toBe(
        false,
      );
      expect(
        scanProjects([JSON.stringify({ projects: { '/a': { note: '"mcpServers": {"x": 1}' } } })]),
      ).toBe(false);
      expect(scanProjects([JSON.stringify({ projects: [{ mcpServers: { x: {} } }] })])).toBe(false);
    });

    it('is off by default', () => {
      expect(scan([JSON.stringify({ projects: { '/a': { mcpServers: { x: {} } } } })])).toBe(false);
    });
  });
});

describe('scanner hardening', () => {
  it('skips files reached through a directory junction / symlink that escapes the root', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-outside-dir-'));
    try {
      fs.mkdirSync(path.join(outside, 'rules'), { recursive: true });
      fs.writeFileSync(path.join(outside, 'rules', 'x.md'), '# outside');
      fs.writeFileSync(path.join(outside, 'mcp.json'), '{"mcpServers":{}}');
      try {
        // 'junction' needs no privilege on Windows; POSIX ignores the type.
        fs.symlinkSync(outside, path.join(tmpDir, '.claude'), 'junction');
        fs.symlinkSync(outside, path.join(tmpDir, '.cursor'), 'junction');
      } catch {
        return; // links unsupported in this env
      }
      fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# root');
      const files = await scanForContextFiles(tmpDir);
      expect(files.map((f) => f.relativePath)).toEqual(['CLAUDE.md']);
      const mcp = await scanForMcpConfigs(tmpDir);
      expect(mcp.map((f) => f.relativePath)).not.toContain('.cursor/mcp.json');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('keeps files under an in-root junction / symlinked dir', async () => {
    // Positive control for the escape check above: a link whose target is
    // INSIDE the root must still be walked.
    fs.mkdirSync(path.join(tmpDir, 'realcursor', 'rules'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'realcursor', 'rules', 'a.md'), '# rule');
    try {
      // 'junction' needs no privilege on Windows (and an absolute target);
      // POSIX ignores the type.
      fs.symlinkSync(path.join(tmpDir, 'realcursor'), path.join(tmpDir, '.cursor'), 'junction');
    } catch {
      return; // links unsupported in this env
    }
    const files = await scanForContextFiles(tmpDir);
    expect(files.map((f) => f.relativePath)).toContain('.cursor/rules/a.md');
  });

  it('keeps an in-root file whose name merely starts with ".."', async () => {
    fs.writeFileSync(path.join(tmpDir, '..notes.md'), '# notes');
    const files = await scanForContextFiles(tmpDir, { extraPatterns: ['..notes.md'] });
    expect(files.map((f) => f.relativePath)).toContain('..notes.md');
  });

  it('keeps a symlink to an in-root target whose name starts with ".."', async () => {
    fs.writeFileSync(path.join(tmpDir, '..target.md'), '# target');
    try {
      fs.symlinkSync(path.join(tmpDir, '..target.md'), path.join(tmpDir, 'CLAUDE.md'));
    } catch {
      return; // symlinks unsupported in this env
    }
    const files = await scanForContextFiles(tmpDir);
    expect(files.map((f) => f.relativePath)).toContain('CLAUDE.md');
  });

  it('warns on stderr when it drops a file over the 5 MB cap', async () => {
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), Buffer.alloc(5 * 1024 * 1024 + 1, 'x'));
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await scanForContextFiles(tmpDir);
      const messages = warn.mock.calls.map((a) => a.join(' ')).join(' | ');
      expect(messages).toContain('skipping CLAUDE.md');
      expect(messages).toContain('5 MB');
    } finally {
      warn.mockRestore();
    }
  });

  it('warns on stderr when it drops a file that resolves outside the project root', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-outside-warn-'));
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      fs.mkdirSync(path.join(outside, 'rules'), { recursive: true });
      fs.writeFileSync(path.join(outside, 'rules', 'style.md'), '# shared');
      fs.mkdirSync(path.join(tmpDir, '.claude'));
      try {
        fs.symlinkSync(
          path.join(outside, 'rules'),
          path.join(tmpDir, '.claude', 'rules'),
          'junction',
        );
      } catch {
        return; // links unsupported in this env
      }
      fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# root');
      const files = await scanForContextFiles(tmpDir);
      expect(files.map((f) => f.relativePath)).toEqual(['CLAUDE.md']);
      const messages = warn.mock.calls.map((a) => a.join(' ')).join(' | ');
      expect(messages).toContain('skipping .claude/rules/style.md');
      expect(messages).toContain('resolves outside the project root');
      // The kept in-root file draws no warning.
      expect(messages).not.toContain('skipping CLAUDE.md');
    } finally {
      warn.mockRestore();
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('sorts by code unit, not locale (uppercase before lowercase)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# c');
    fs.writeFileSync(path.join(tmpDir, 'aaa.md'), '# a');
    const files = await scanForContextFiles(tmpDir, { extraPatterns: ['aaa.md'] });
    expect(files.map((f) => f.relativePath)).toEqual(['CLAUDE.md', 'aaa.md']);
  });

  it('skips every shared ignored directory, including coverage and __pycache__', async () => {
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), 'root');
    for (const dir of ['coverage', '__pycache__']) {
      fs.mkdirSync(path.join(tmpDir, dir));
      fs.writeFileSync(path.join(tmpDir, dir, 'CLAUDE.md'), 'junk');
    }
    const files = await scanForContextFiles(tmpDir);
    expect(files.map((f) => f.relativePath)).toEqual(['CLAUDE.md']);
  });

  it.runIf(process.platform === 'win32' || process.platform === 'darwin')(
    'exclude globs match case-insensitively where discovery does',
    async () => {
      fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# root');
      fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# agents');
      const files = await scanForContextFiles(tmpDir, { exclude: ['claude.md'] });
      expect(files.map((f) => f.relativePath)).toEqual(['AGENTS.md']);
    },
  );
});

describe('scanForMcpConfigs exclude option', () => {
  it('drops MCP configs matching an exclude glob', async () => {
    fs.writeFileSync(path.join(tmpDir, '.mcp.json'), '{}');
    fs.mkdirSync(path.join(tmpDir, '.cursor'));
    fs.writeFileSync(path.join(tmpDir, '.cursor', 'mcp.json'), '{}');
    const files = await scanForMcpConfigs(tmpDir, { exclude: ['.cursor/**'] });
    expect(files.map((f) => f.relativePath)).toEqual(['.mcp.json']);
  });
});
