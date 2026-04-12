import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
