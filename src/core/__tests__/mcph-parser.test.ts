import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseMchpConfig } from '../mcph-parser.js';
import type { DiscoveredFile } from '../scanner.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-mcph-parser-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeTmp(content: string, name = '.mcph.json'): DiscoveredFile {
  const abs = path.join(tmpDir, name);
  fs.writeFileSync(abs, content);
  return { absolutePath: abs, relativePath: name, isSymlink: false, type: 'mcph-config' };
}

describe('parseMchpConfig — trailing commas + comments', () => {
  // Regression: parseTree is configured with `allowTrailingComma: true`, so
  // these inputs are valid JSONC. Earlier versions then ran the input through
  // `JSON.parse(stripComments(content))`, which is NOT trailing-comma-tolerant,
  // and the catch silently set `raw: null` so every downstream check became
  // a no-op without surfacing a parse error. `getNodeValue(tree)` lifts the
  // value directly from the already-validated tree.
  it('populates raw when the file uses trailing commas', async () => {
    const file = writeTmp(
      '{\n  "token": "mcp_pat_abc123",\n  "apiBase": "https://mcp.hosting",\n}\n',
    );
    const config = await parseMchpConfig(file, tmpDir);
    expect(config.parseErrors).toEqual([]);
    expect(config.raw).not.toBeNull();
    expect(config.raw?.token).toBe('mcp_pat_abc123');
    expect(config.raw?.apiBase).toBe('https://mcp.hosting');
    expect(config.positions.token?.line).toBe(2);
  });

  it('populates raw when the file contains // and /* */ comments', async () => {
    const file = writeTmp(
      [
        '{',
        '  // user-global token (move to MCPH_TOKEN env var)',
        '  "token": "mcp_pat_xyz",',
        '  /* api endpoint */',
        '  "apiBase": "https://mcp.hosting"',
        '}',
        '',
      ].join('\n'),
    );
    const config = await parseMchpConfig(file, tmpDir);
    expect(config.parseErrors).toEqual([]);
    expect(config.raw?.token).toBe('mcp_pat_xyz');
    expect(config.raw?.apiBase).toBe('https://mcp.hosting');
  });

  it('populates raw with both trailing commas AND comments on the same input', async () => {
    const file = writeTmp(
      [
        '{',
        '  // mcph config',
        '  "token": "mcp_pat_combo",',
        '  "servers": [',
        '    "alpha",',
        '    "beta", // trailing comma in array too',
        '  ],',
        '}',
        '',
      ].join('\n'),
    );
    const config = await parseMchpConfig(file, tmpDir);
    expect(config.parseErrors).toEqual([]);
    expect(config.raw?.token).toBe('mcp_pat_combo');
    expect(config.listEntries.servers.map((e) => e.value)).toEqual(['alpha', 'beta']);
  });

  it('still surfaces parseErrors and leaves raw null on genuinely broken JSON', async () => {
    const file = writeTmp('{ "token": "mcp_pat_x" "apiBase": "..." }');
    const config = await parseMchpConfig(file, tmpDir);
    expect(config.parseErrors.length).toBeGreaterThan(0);
    expect(config.raw).toBeNull();
  });

  it('reports "must be a JSON object at the root" when the root is an array', async () => {
    const file = writeTmp('[1, 2, 3]');
    const config = await parseMchpConfig(file, tmpDir);
    expect(config.parseErrors.some((e) => e.includes('JSON object at the root'))).toBe(true);
    expect(config.raw).toBeNull();
  });

  it('detects scope from filename', async () => {
    const local = writeTmp('{ "token": "mcp_pat_local" }', '.mcph.local.json');
    const proj = writeTmp('{ "token": "mcp_pat_proj" }', '.mcph.json');

    const localConfig = await parseMchpConfig(local, tmpDir);
    const projConfig = await parseMchpConfig(proj, tmpDir);

    expect(localConfig.scope).toBe('project-local');
    expect(projConfig.scope).toBe('project');
  });

  it('flags unknown top-level fields with positions', async () => {
    const file = writeTmp('{\n  "tokens": "typo",\n  "blockList": []\n}\n');
    const config = await parseMchpConfig(file, tmpDir);
    expect(config.unknownFields.map((f) => f.name)).toEqual(['tokens', 'blockList']);
    expect(config.unknownFields[0].position.line).toBe(2);
    expect(config.unknownFields[1].position.line).toBe(3);
  });

  it('captures listEntries with per-element positions', async () => {
    const file = writeTmp(
      ['{', '  "servers": [', '    "alpha",', '    "beta"', '  ]', '}', ''].join('\n'),
    );
    const config = await parseMchpConfig(file, tmpDir);
    expect(config.listEntries.servers).toHaveLength(2);
    expect(config.listEntries.servers[0]).toEqual({
      value: 'alpha',
      position: expect.objectContaining({ line: 3 }),
    });
    expect(config.listEntries.servers[1]).toEqual({
      value: 'beta',
      position: expect.objectContaining({ line: 4 }),
    });
  });
});
