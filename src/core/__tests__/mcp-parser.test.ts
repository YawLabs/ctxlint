import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  classifyGitTrackedError,
  collectServerNameKeys,
  collectServerSets,
  getClaudeProjectScope,
  locateServerValue,
  parseMcpConfig,
  parseMcpContent,
} from '../mcp-parser.js';
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
  fs.mkdirSync(path.dirname(abs), { recursive: true });
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

  it('reports only the position of a JSON error, never quoted source text', () => {
    // An unquoted token value: V8's JSON.parse message quotes ~10 chars of
    // source around it, which would leak the start of the secret.
    const token = `ghp_${'A'.repeat(36)}`;
    const config = parseMcpContent(
      `{\n  "mcpServers": {\n    "gh": { "env": { "TOKEN": ${token} } }\n  }\n}\n`,
      { filePath: '/p/.mcp.json', relativePath: '.mcp.json', scope: 'project' },
    );
    expect(config.parseErrors).toHaveLength(1);
    expect(config.parseErrors[0]).toMatch(/at line 3 column \d+$/);
    expect(config.parseErrors[0]).not.toContain('ghp_');
  });

  it.each([
    '~/AppData/Roaming/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json',
    '~/.cline/data/settings/cline_mcp_settings.json',
    '~/custom/cline_mcp_settings.json',
  ])('classifies %s as the cline client', (relativePath) => {
    const config = parseMcpContent('{"mcpServers": {}}', {
      filePath: '/x',
      relativePath,
      scope: 'global',
    });
    expect(config.client).toBe('cline');
    expect(config.expectedRootKey).toBe('mcpServers');
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

  it('marks a non-repo config untracked without the unknown flag', async () => {
    // No .git in tmpDir: tracking is DETERMINED absent, not unanswerable.
    const file = writeTmp(JSON.stringify({ mcpServers: {} }));
    const config = await parseMcpConfig(file, tmpDir, 'project');
    expect(config.isGitTracked).toBe(false);
    expect(config.gitTrackedUnknown).toBeUndefined();
  });
});

describe('collectServerNameKeys', () => {
  it('accepts the root key only at the top level and stops when its object closes', () => {
    // A nested `mcpServers` (Claude Code's per-project shape) used to latch
    // the scan, and every later depth+1 key -- across the rest of the file --
    // was collected as a server name.
    const content = JSON.stringify(
      {
        projects: {
          '/a': { mcpServers: { github: { command: 'a' } } },
          '/b': { mcpServers: { github: { command: 'b' } } },
        },
        mcpServers: { top: { command: 'x' } },
        other: { notAServer: 1 },
      },
      null,
      2,
    );
    expect(collectServerNameKeys(content, 'mcpServers').map((k) => k.name)).toEqual(['top']);
  });

  it('returns nothing when the root key exists only nested', () => {
    const content = JSON.stringify({ projects: { '/a': { mcpServers: { gh: {} } } } });
    expect(collectServerNameKeys(content, 'mcpServers')).toEqual([]);
  });
});

describe('parseMcpConfig: ~/.claude.json per-project servers', () => {
  const stateFile = (obj: unknown) => writeTmp(JSON.stringify(obj, null, 2), '.claude.json');

  it('keeps each project block a separate server set (no cross-project duplicates)', async () => {
    const file = stateFile({
      projects: {
        '/a': { mcpServers: { github: { command: 'a' } } },
        '/b': { mcpServers: { github: { command: 'b' } } },
      },
      mcpServers: { github: { command: 'top' } },
    });
    const config = await parseMcpConfig(file, tmpDir, 'user');
    const sets = collectServerSets(config.content, config.actualRootKey, config.relativePath);
    expect(sets.map((s) => s.projectPath ?? null)).toEqual([null, '/a', '/b']);
    for (const set of sets) expect(set.keys.map((k) => k.name)).toEqual(['github']);
    expect(config.servers.map((s) => s.command)).toEqual(['top', 'a', 'b']);
  });

  it('lints per-project servers with correct lines when there is no top-level key', async () => {
    const file = stateFile({
      numStartups: 3,
      projects: {
        '/a': { allowedTools: [], mcpServers: { github: { command: 'npx' } } },
      },
    });
    const config = await parseMcpConfig(file, tmpDir, 'user');
    expect(config.parseErrors).toEqual([]);
    expect(config.actualRootKey).toBeNull();
    expect(config.servers.map((s) => s.name)).toEqual(['github']);
    const lines = config.content.split('\n');
    expect(lines[config.servers[0].line - 1]).toContain('"github"');
    expect(getClaudeProjectScope(config.servers[0])).toEqual({
      projectPath: '/a',
      isCurrentProject: false,
    });
  });

  it('marks the per-project block for the linted project root as current', async () => {
    const file = stateFile({
      projects: { [tmpDir.split(path.sep).join('/')]: { mcpServers: { gh: { command: 'npx' } } } },
    });
    const config = await parseMcpConfig(file, tmpDir, 'user');
    expect(getClaudeProjectScope(config.servers[0])?.isCurrentProject).toBe(true);
  });

  it('only reads projects.* for the Claude Code state file', async () => {
    const file = writeTmp(
      JSON.stringify({ projects: { '/a': { mcpServers: { gh: { command: 'npx' } } } } }),
      '.mcp.json',
    );
    const config = await parseMcpConfig(file, tmpDir, 'project');
    expect(config.servers).toHaveLength(0);
  });
});

describe('parseMcpConfig: JSONC', () => {
  const jsonc = [
    '{',
    '  // workspace servers',
    '  "servers": {',
    '    "api": { "url": "https://api.example.com/mcp", },',
    '  },',
    '}',
  ].join('\n');

  it('accepts comments and trailing commas in .vscode/mcp.json', async () => {
    const config = await parseMcpConfig(writeTmp(jsonc, '.vscode/mcp.json'), tmpDir, 'project');
    expect(config.parseErrors).toEqual([]);
    expect(config.servers.map((s) => [s.name, s.line])).toEqual([['api', 4]]);
  });

  it('still rejects comments in .mcp.json (Claude Code reads strict JSON)', async () => {
    const config = await parseMcpConfig(
      writeTmp(jsonc.replace('"servers"', '"mcpServers"'), '.mcp.json'),
      tmpDir,
      'project',
    );
    expect(config.parseErrors.length).toBeGreaterThan(0);
  });

  it('still reports genuinely broken JSONC in .vscode/mcp.json', async () => {
    const config = await parseMcpConfig(
      writeTmp('{ "servers": { "a": ', '.vscode/mcp.json'),
      tmpDir,
      'project',
    );
    expect(config.parseErrors.length).toBeGreaterThan(0);
    expect(config.servers).toHaveLength(0);
  });
});

describe('parseMcpConfig: Windsurf serverUrl', () => {
  it('reads serverUrl as the url of a remote Windsurf server', async () => {
    const file = writeTmp(
      JSON.stringify({ mcpServers: { remote: { serverUrl: 'https://api.example.com/mcp' } } }),
      '.codeium/windsurf/mcp_config.json',
    );
    const config = await parseMcpConfig(file, tmpDir, 'user');
    expect(config.client).toBe('windsurf');
    expect(config.servers[0].transport).toBe('http');
    expect(config.servers[0].url).toBe('https://api.example.com/mcp');
  });

  it('does not treat serverUrl as a url for other clients', async () => {
    const file = writeTmp(
      JSON.stringify({ mcpServers: { remote: { serverUrl: 'https://api.example.com/mcp' } } }),
    );
    const config = await parseMcpConfig(file, tmpDir, 'project');
    expect(config.servers[0].transport).toBe('unknown');
    expect(config.servers[0].url).toBeUndefined();
  });
});

describe('locateServerValue', () => {
  it('finds the line and column of a nested value in pretty-printed JSON', async () => {
    const content = [
      '{',
      '  "mcpServers": {',
      '    "api": {',
      '      "command": "npx",',
      '      "env": {',
      '        "TOKEN": "${env:TOKEN}"',
      '      }',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const config = await parseMcpConfig(writeTmp(content), tmpDir, 'project');
    const loc = locateServerValue(config, config.servers[0], ['env', 'TOKEN']);
    expect(loc).toEqual({ line: 6, column: 18, text: '"${env:TOKEN}"' });
    expect(locateServerValue(config, config.servers[0], ['env', 'NOPE'])).toBeNull();
  });

  it('locates values in the last duplicate definition (the one JSON.parse keeps)', async () => {
    const content = [
      '{ "mcpServers": {',
      '  "a": { "type": "stdio" },',
      '  "a": { "type": "sse" }',
      '} }',
    ].join('\n');
    const config = await parseMcpConfig(writeTmp(content), tmpDir, 'project');
    expect(locateServerValue(config, config.servers[0], ['type'])?.line).toBe(3);
  });

  it('locates values of per-project servers in ~/.claude.json', async () => {
    const content = JSON.stringify(
      { projects: { '/a': { mcpServers: { gh: { command: 'npx', args: ['-y', 'pkg'] } } } } },
      null,
      2,
    );
    const config = await parseMcpConfig(writeTmp(content, '.claude.json'), tmpDir, 'user');
    const loc = locateServerValue(config, config.servers[0], ['args', 1]);
    expect(loc?.text).toBe('"pkg"');
    expect(config.content.split('\n')[loc!.line - 1]).toContain('"pkg"');
  });
});

describe('classifyGitTrackedError', () => {
  it('classifies the two determined-untracked shapes', () => {
    expect(
      classifyGitTrackedError("error: pathspec '.mcp.json' did not match any file(s) known to git"),
    ).toBe('untracked');
    expect(
      classifyGitTrackedError('fatal: not a git repository (or any of the parent directories)'),
    ).toBe('untracked');
  });

  it('classifies a file outside the repository as untracked', () => {
    // A global config linted from inside a repo: git answered, the file just
    // isn't in this repo.
    expect(
      classifyGitTrackedError(
        "fatal: C:/Users/me/.cursor/mcp.json: 'C:/Users/me/.cursor/mcp.json' is outside repository at 'C:/repo'",
      ),
    ).toBe('untracked');
  });

  it('classifies everything else as unknown', () => {
    expect(classifyGitTrackedError('spawn git ENOENT')).toBe('unknown');
    expect(classifyGitTrackedError('fatal: detected dubious ownership in repository')).toBe(
      'unknown',
    );
    expect(classifyGitTrackedError('')).toBe('unknown');
  });
});
