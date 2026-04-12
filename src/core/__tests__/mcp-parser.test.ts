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
    const config = await parseMcpConfig(file, path.join(FIXTURES, 'valid'));
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
    const config = await parseMcpConfig(file, path.join(FIXTURES, 'valid'));
    expect(config.client).toBe('vscode');
    expect(config.expectedRootKey).toBe('servers');
    expect(config.actualRootKey).toBe('servers');
    expect(config.servers).toHaveLength(1);
  });

  it('parses a valid .cursor/mcp.json', async () => {
    const file = makeFile(path.join(FIXTURES, 'valid'), '.cursor/mcp.json');
    const config = await parseMcpConfig(file, path.join(FIXTURES, 'valid'));
    expect(config.client).toBe('cursor');
    expect(config.expectedRootKey).toBe('mcpServers');
  });

  it('parses a valid .amazonq/mcp.json', async () => {
    const file = makeFile(path.join(FIXTURES, 'valid'), '.amazonq/mcp.json');
    const config = await parseMcpConfig(file, path.join(FIXTURES, 'valid'));
    expect(config.client).toBe('amazonq');
    expect(config.servers[0].timeout).toBe(60000);
  });

  it('reports JSON parse errors', async () => {
    const file = makeFile(path.join(FIXTURES, 'invalid-json'), '.mcp.json');
    const config = await parseMcpConfig(file, path.join(FIXTURES, 'invalid-json'));
    expect(config.parseErrors.length).toBeGreaterThan(0);
    expect(config.servers).toHaveLength(0);
  });

  it('detects wrong root key', async () => {
    const file = makeFile(path.join(FIXTURES, 'wrong-root-key'), '.vscode/mcp.json');
    const config = await parseMcpConfig(file, path.join(FIXTURES, 'wrong-root-key'));
    expect(config.expectedRootKey).toBe('servers');
    expect(config.actualRootKey).toBe('mcpServers');
  });

  it('handles missing root key', async () => {
    // .mcp.json with "servers" instead of "mcpServers"
    const file = makeFile(path.join(FIXTURES, 'wrong-root-key'), '.mcp.json');
    const config = await parseMcpConfig(file, path.join(FIXTURES, 'wrong-root-key'));
    expect(config.expectedRootKey).toBe('mcpServers');
    // It still finds "servers" as the actual root key
    expect(config.actualRootKey).toBe('servers');
  });

  it('parses missing fields config', async () => {
    const file = makeFile(path.join(FIXTURES, 'missing-fields'), '.mcp.json');
    const config = await parseMcpConfig(file, path.join(FIXTURES, 'missing-fields'));
    expect(config.servers).toHaveLength(2);
    expect(config.servers[0].transport).toBe('stdio');
    expect(config.servers[0].command).toBeUndefined();
    expect(config.servers[1].transport).toBe('http');
    expect(config.servers[1].url).toBeUndefined();
  });

  it('parses empty servers', async () => {
    const file = makeFile(path.join(FIXTURES, 'empty-servers'), '.mcp.json');
    const config = await parseMcpConfig(file, path.join(FIXTURES, 'empty-servers'));
    expect(config.actualRootKey).toBe('mcpServers');
    expect(config.servers).toHaveLength(0);
  });

  it('infers stdio transport from command field', async () => {
    const file = makeFile(path.join(FIXTURES, 'valid'), '.mcp.json');
    const config = await parseMcpConfig(file, path.join(FIXTURES, 'valid'));
    const fs = config.servers.find((s) => s.name === 'filesystem');
    expect(fs?.transport).toBe('stdio');
  });

  it('infers http transport from url field', async () => {
    const file = makeFile(path.join(FIXTURES, 'valid'), '.mcp.json');
    const config = await parseMcpConfig(file, path.join(FIXTURES, 'valid'));
    const remote = config.servers.find((s) => s.name === 'remote-api');
    expect(remote?.transport).toBe('http');
  });

  it('parseErrors includes "must be a JSON object" when root is an array', async () => {
    const file = writeTmp('[1, 2, 3]');
    const config = await parseMcpConfig(file, tmpDir);
    expect(config.parseErrors.some((e) => e.includes('must be a JSON object'))).toBe(true);
    expect(config.servers).toHaveLength(0);
  });

  it('parseErrors includes "must be a JSON object" when root is a scalar', async () => {
    const file = writeTmp('"hello"');
    const config = await parseMcpConfig(file, tmpDir);
    expect(config.parseErrors.some((e) => e.includes('must be a JSON object'))).toBe(true);
    expect(config.servers).toHaveLength(0);
  });

  it('parseErrors includes "must be an object" when mcpServers is a string', async () => {
    const file = writeTmp(JSON.stringify({ mcpServers: 'nope' }));
    const config = await parseMcpConfig(file, tmpDir);
    expect(config.parseErrors.some((e) => e.includes('must be an object'))).toBe(true);
    expect(config.servers).toHaveLength(0);
  });

  it('parseErrors includes "must be an object" when mcpServers is an array', async () => {
    const file = writeTmp(JSON.stringify({ mcpServers: [1, 2, 3] }));
    const config = await parseMcpConfig(file, tmpDir);
    expect(config.parseErrors.some((e) => e.includes('must be an object'))).toBe(true);
  });
});
