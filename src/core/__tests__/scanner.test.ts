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

describe('mcpFileHasMcpKey peek (fix 2)', () => {
  // scanGlobalMcpConfigs gates `~/.claude.json` and `~/.claude/settings.json`
  // through a cheap text-only peek. For `.claude.json` -- Claude Code's own
  // state file, where projects/history precede `mcpServers` and push the key
  // well past 8KB on real workstations -- the peek STREAMS the file and must
  // detect the key wherever it sits, bailing as soon as it matches (so a key
  // near the top still avoids a full read). `settings.json` stays on the cheap
  // 8KB prefix peek since it's always small.
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
    const start = Date.now();
    const files = await scanGlobalMcpConfigs();
    const elapsed = Date.now() - start;
    expect(files.map((f) => f.relativePath)).toContain('~/.claude.json');
    // Generous bound -- a true full-read of 10MB is ~50-200ms on most disks,
    // an early-exit first-chunk read is <5ms. 250ms catches a regression to a
    // full read without flaking.
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
