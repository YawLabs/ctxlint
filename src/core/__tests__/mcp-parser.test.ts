import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseMcpConfig } from '../mcp-parser.js';
import type { DiscoveredFile } from '../scanner.js';

const FIXTURES = path.resolve(__dirname, '../../../fixtures/mcp-configs');

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-mcp-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeTmp(content: string, name = '.mcp.json'): DiscoveredFile {
  const abs = path.join(tmpDir, name);
  fs.writeFileSync(abs, content);
  return { absolutePath: abs, relativePath: name, isSymlink: false, type: 'mcp-config' };
}

function makeFile(fixturePath: string, relativePath: string): DiscoveredFile {
  return {
    absolutePath: path.join(fixturePath, relativePath),
    relativePath: relativePath.replace(/\\/g, '/'),
    isSymlink: false,
    type: 'mcp-config',
  };
}

describe('parseMcpConfig', () => {
  it('parses a valid .mcp.json', async () => {
    const file = makeFile(path.join(FIXTURES, 'valid'), '.mcp.json');
    const config = await parseMcpConfig(file, path.join(FIXTURES, 'valid'), 'project');
    expect(config.parseErrors).toHaveLength(0);
    expect(config.client).toBe('claude-code');
    expect(config.expectedRootKey).toBe('mcpServers');
    expect(config.actualRootKey).toBe('mcpServers');
    expect(config.servers).toHaveLength(2);
    expect(config.servers[0].name).toBe('filesystem');
    expect(config.servers[0].transport).toBe('stdio');
    expect(config.servers[0].command).toBe('npx');
    expect(config.servers[1].name).toBe('remote-api');
    expect(config.servers[1].transport).toBe('http');
    expect(config.servers[1].url).toBe('https://api.example.com/mcp');
  });

  it('parses a valid .vscode/mcp.json with "servers" root key', async () => {
    const file = makeFile(path.join(FIXTURES, 'valid'), '.vscode/mcp.json');
    const config = await parseMcpConfig(file, path.join(FIXTURES, 'valid'), 'project');
    expect(config.client).toBe('vscode');
    expect(config.expectedRootKey).toBe('servers');
    expect(config.actualRootKey).toBe('servers');
    expect(config.servers).toHaveLength(1);
  });

  it('parses a valid .cursor/mcp.json', async () => {
    const file = makeFile(path.join(FIXTURES, 'valid'), '.cursor/mcp.json');
    const config = await parseMcpConfig(file, path.join(FIXTURES, 'valid'), 'project');
    expect(config.client).toBe('cursor');
    expect(config.expectedRootKey).toBe('mcpServers');
  });

  it('parses a valid .amazonq/mcp.json', async () => {
    const file = makeFile(path.join(FIXTURES, 'valid'), '.amazonq/mcp.json');
    const config = await parseMcpConfig(file, path.join(FIXTURES, 'valid'), 'project');
    expect(config.client).toBe('amazonq');
    expect(config.servers[0].timeout).toBe(60000);
  });

  it('reports JSON parse errors', async () => {
    const file = makeFile(path.join(FIXTURES, 'invalid-json'), '.mcp.json');
    const config = await parseMcpConfig(file, path.join(FIXTURES, 'invalid-json'), 'project');
    expect(config.parseErrors.length).toBeGreaterThan(0);
    expect(config.servers).toHaveLength(0);
  });

  it('detects wrong root key', async () => {
    const file = makeFile(path.join(FIXTURES, 'wrong-root-key'), '.vscode/mcp.json');
    const config = await parseMcpConfig(file, path.join(FIXTURES, 'wrong-root-key'), 'project');
    expect(config.expectedRootKey).toBe('servers');
    expect(config.actualRootKey).toBe('mcpServers');
  });

  it('handles missing root key', async () => {
    // .mcp.json with "servers" instead of "mcpServers"
    const file = makeFile(path.join(FIXTURES, 'wrong-root-key'), '.mcp.json');
    const config = await parseMcpConfig(file, path.join(FIXTURES, 'wrong-root-key'), 'project');
    expect(config.expectedRootKey).toBe('mcpServers');
    // It still finds "servers" as the actual root key
    expect(config.actualRootKey).toBe('servers');
  });

  it('parses missing fields config', async () => {
    const file = makeFile(path.join(FIXTURES, 'missing-fields'), '.mcp.json');
    const config = await parseMcpConfig(file, path.join(FIXTURES, 'missing-fields'), 'project');
    expect(config.servers).toHaveLength(2);
    expect(config.servers[0].transport).toBe('stdio');
    expect(config.servers[0].command).toBeUndefined();
    expect(config.servers[1].transport).toBe('http');
    expect(config.servers[1].url).toBeUndefined();
  });

  it('parses empty servers', async () => {
    const file = makeFile(path.join(FIXTURES, 'empty-servers'), '.mcp.json');
    const config = await parseMcpConfig(file, path.join(FIXTURES, 'empty-servers'), 'project');
    expect(config.actualRootKey).toBe('mcpServers');
    expect(config.servers).toHaveLength(0);
  });

  it('infers stdio transport from command field', async () => {
    const file = makeFile(path.join(FIXTURES, 'valid'), '.mcp.json');
    const config = await parseMcpConfig(file, path.join(FIXTURES, 'valid'), 'project');
    const fs = config.servers.find((s) => s.name === 'filesystem');
    expect(fs?.transport).toBe('stdio');
  });

  it('infers http transport from url field', async () => {
    const file = makeFile(path.join(FIXTURES, 'valid'), '.mcp.json');
    const config = await parseMcpConfig(file, path.join(FIXTURES, 'valid'), 'project');
    const remote = config.servers.find((s) => s.name === 'remote-api');
    expect(remote?.transport).toBe('http');
  });

  it('parseErrors includes "must be a JSON object" when root is an array', async () => {
    const file = writeTmp('[1, 2, 3]');
    const config = await parseMcpConfig(file, tmpDir, 'project');
    expect(config.parseErrors.some((e) => e.includes('must be a JSON object'))).toBe(true);
    expect(config.servers).toHaveLength(0);
  });

  it('parseErrors includes "must be a JSON object" when root is a scalar', async () => {
    const file = writeTmp('"hello"');
    const config = await parseMcpConfig(file, tmpDir, 'project');
    expect(config.parseErrors.some((e) => e.includes('must be a JSON object'))).toBe(true);
    expect(config.servers).toHaveLength(0);
  });

  it('parseErrors includes "must be an object" when mcpServers is a string', async () => {
    const file = writeTmp(JSON.stringify({ mcpServers: 'nope' }));
    const config = await parseMcpConfig(file, tmpDir, 'project');
    expect(config.parseErrors.some((e) => e.includes('must be an object'))).toBe(true);
    expect(config.servers).toHaveLength(0);
  });

  it('parseErrors includes "must be an object" when mcpServers is an array', async () => {
    const file = writeTmp(JSON.stringify({ mcpServers: [1, 2, 3] }));
    const config = await parseMcpConfig(file, tmpDir, 'project');
    expect(config.parseErrors.some((e) => e.includes('must be an object'))).toBe(true);
  });

  it('parses a BOM-prefixed .mcp.json', async () => {
    // Windows editors prepend U+FEFF; without BOM stripping this throws on JSON.parse.
    const file = writeTmp('﻿' + JSON.stringify({ mcpServers: { fs: { command: 'npx' } } }));
    const config = await parseMcpConfig(file, tmpDir, 'project');
    expect(config.parseErrors).toHaveLength(0);
    expect(config.servers).toHaveLength(1);
    expect(config.servers[0].name).toBe('fs');
  });

  it('attributes a server named after a field key to its own line, not an earlier nested key', async () => {
    // A flat regex scan finds the FIRST `"env":` after the root key, which is
    // server a's nested env block (line 5), not the server defined at line 7.
    const file = writeTmp(
      [
        '{',
        '  "mcpServers": {',
        '    "a": {',
        '      "command": "foo",',
        '      "env": { "K": "v" }',
        '    },',
        '    "env": {',
        '      "command": "bar"',
        '    }',
        '  }',
        '}',
      ].join('\n'),
    );
    const config = await parseMcpConfig(file, tmpDir, 'project');
    const envServer = config.servers.find((s) => s.name === 'env');
    expect(envServer).toBeDefined();
    expect(envServer!.line).toBe(7);
  });

  it('attributes a duplicated server name to the last definition (the one JSON.parse keeps)', async () => {
    const file = writeTmp(
      [
        '{',
        '  "mcpServers": {',
        '    "api": { "url": "https://old.example.com/mcp" },',
        '    "other": { "url": "https://other.example.com/mcp" },',
        '    "api": { "url": "https://new.example.com/mcp" }',
        '  }',
        '}',
      ].join('\n'),
    );
    const config = await parseMcpConfig(file, tmpDir, 'project');
    const api = config.servers.find((s) => s.name === 'api');
    expect(api!.url).toBe('https://new.example.com/mcp');
    expect(api!.line).toBe(5);
  });

  it('keeps string env values when a sibling value is non-string', async () => {
    // All-or-nothing narrowing would drop the whole env block -- hiding the
    // token next to the stray number from the security check.
    const file = writeTmp(
      JSON.stringify({
        mcpServers: {
          gh: {
            command: 'npx',
            env: { GITHUB_TOKEN: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij', PORT: 3000 },
          },
        },
      }),
    );
    const config = await parseMcpConfig(file, tmpDir, 'project');
    expect(config.servers[0].env).toEqual({
      GITHUB_TOKEN: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij',
    });
  });

  it('keeps string header values when a sibling header is non-string', async () => {
    const file = writeTmp(
      JSON.stringify({
        mcpServers: {
          api: {
            url: 'https://api.example.com/mcp',
            headers: { 'X-Api-Key': 'sk-proj-abcdefghijklmnopqrstuvwxyz1234567890', Retries: 3 },
          },
        },
      }),
    );
    const config = await parseMcpConfig(file, tmpDir, 'project');
    expect(config.servers[0].headers).toEqual({
      'X-Api-Key': 'sk-proj-abcdefghijklmnopqrstuvwxyz1234567890',
    });
  });

  it('leaves env undefined when a non-empty env has no string values', async () => {
    // Surfacing `{}` here would false-trigger mcp-env/empty-env-block.
    const file = writeTmp(
      JSON.stringify({ mcpServers: { srv: { command: 'npx', env: { PORT: 3000 } } } }),
    );
    const config = await parseMcpConfig(file, tmpDir, 'project');
    expect(config.servers[0].env).toBeUndefined();
  });

  it('keeps a genuinely empty env object (so empty-env-block can fire)', async () => {
    const file = writeTmp(JSON.stringify({ mcpServers: { srv: { command: 'npx', env: {} } } }));
    const config = await parseMcpConfig(file, tmpDir, 'project');
    expect(config.servers[0].env).toEqual({});
  });

  it('rejects array-shaped oauth field on a server entry', async () => {
    // `typeof [] === 'object'` and arrays are not null, so a previous guard
    // accepted arrays here and surfaced them as `oauth: Record<string, unknown>`.
    // The parser should now leave `oauth` undefined when the value is an array.
    const file = writeTmp(
      JSON.stringify({
        mcpServers: {
          remote: {
            url: 'https://api.example.com/mcp',
            oauth: ['not', 'an', 'object'],
          },
        },
      }),
    );
    const config = await parseMcpConfig(file, tmpDir, 'project');
    expect(config.servers).toHaveLength(1);
    expect(config.servers[0].oauth).toBeUndefined();
  });
});
