import { describe, it, expect } from 'vitest';
import { checkMcpConsistency } from '../consistency.js';
import type { ParsedMcpConfig } from '../../../types.js';

function makeConfig(overrides: Partial<ParsedMcpConfig> = {}): ParsedMcpConfig {
  return {
    filePath: '/project/.mcp.json',
    relativePath: '.mcp.json',
    client: 'claude-code',
    scope: 'project',
    expectedRootKey: 'mcpServers',
    actualRootKey: 'mcpServers',
    servers: [],
    parseErrors: [],
    content: '{}',
    isGitTracked: false,
    ...overrides,
  };
}

describe('checkMcpConsistency', () => {
  it('flags same server with different URLs across configs', async () => {
    const configs = [
      makeConfig({
        relativePath: '.mcp.json',
        servers: [
          { name: 'api', transport: 'http', url: 'https://v1.example.com/mcp', line: 3, raw: {} },
        ],
      }),
      makeConfig({
        relativePath: '.cursor/mcp.json',
        client: 'cursor',
        servers: [
          { name: 'api', transport: 'http', url: 'https://v2.example.com/mcp', line: 3, raw: {} },
        ],
      }),
    ];
    const issues = await checkMcpConsistency(configs);
    const drift = issues.find((i) => i.message.includes('configured differently'));
    expect(drift).toBeDefined();
    expect(drift!.severity).toBe('warning');
  });

  it('does not flag identical servers across configs', async () => {
    const configs = [
      makeConfig({
        relativePath: '.mcp.json',
        servers: [
          {
            name: 'api',
            transport: 'http',
            url: 'https://api.example.com/mcp',
            line: 3,
            raw: {},
          },
        ],
      }),
      makeConfig({
        relativePath: '.cursor/mcp.json',
        client: 'cursor',
        servers: [
          {
            name: 'api',
            transport: 'http',
            url: 'https://api.example.com/mcp',
            line: 3,
            raw: {},
          },
        ],
      }),
    ];
    const issues = await checkMcpConsistency(configs);
    expect(issues.filter((i) => i.message.includes('configured differently'))).toHaveLength(0);
  });

  it('flags server in .mcp.json but missing from .cursor/mcp.json', async () => {
    const configs = [
      makeConfig({
        relativePath: '.mcp.json',
        servers: [
          { name: 'api', transport: 'http', url: 'https://api.example.com/mcp', line: 3, raw: {} },
          {
            name: 'filesystem',
            transport: 'stdio',
            command: 'npx',
            line: 8,
            raw: { command: 'npx' },
          },
        ],
      }),
      makeConfig({
        relativePath: '.cursor/mcp.json',
        client: 'cursor',
        servers: [
          { name: 'api', transport: 'http', url: 'https://api.example.com/mcp', line: 3, raw: {} },
        ],
      }),
    ];
    const issues = await checkMcpConsistency(configs);
    const missing = issues.find(
      (i) => i.message.includes('missing from') && i.message.includes('filesystem'),
    );
    expect(missing).toBeDefined();
    expect(missing!.severity).toBe('info');
  });

  it('flags duplicate server name within a single file', async () => {
    const config = makeConfig({
      relativePath: '.mcp.json',
      content:
        '{\n  "mcpServers": {\n    "api": { "url": "https://old.example.com" },\n    "api": { "url": "https://new.example.com" }\n  }\n}',
      servers: [
        { name: 'api', transport: 'http', url: 'https://new.example.com', line: 4, raw: {} },
      ],
    });
    const issues = await checkMcpConsistency([config]);
    const dup = issues.find((i) => i.message.includes('Duplicate server name'));
    expect(dup).toBeDefined();
    expect(dup!.severity).toBe('warning');
  });

  it('returns empty for a single config with no issues', async () => {
    const config = makeConfig({
      servers: [
        { name: 'api', transport: 'http', url: 'https://api.example.com/mcp', line: 3, raw: {} },
      ],
    });
    const issues = await checkMcpConsistency([config]);
    expect(issues).toHaveLength(0);
  });

  // Regression: a server literally named `env` (or any other key-like name)
  // should not false-positive as "duplicate" just because `"env":` appears
  // inside other servers' nested env blocks.
  it('does not flag server named env as duplicate when nested env blocks exist', async () => {
    const config = makeConfig({
      content: [
        '{',
        '  "mcpServers": {',
        '    "env": {',
        '      "command": "foo",',
        '      "env": { "K": "v" }',
        '    },',
        '    "other": {',
        '      "command": "bar",',
        '      "env": { "K2": "v2" }',
        '    }',
        '  }',
        '}',
      ].join('\n'),
      servers: [
        { name: 'env', transport: 'stdio', command: 'foo', line: 3, raw: {} },
        { name: 'other', transport: 'stdio', command: 'bar', line: 7, raw: {} },
      ],
    });
    const issues = await checkMcpConsistency([config]);
    const dup = issues.find((i) => i.message.includes('Duplicate server name'));
    expect(dup).toBeUndefined();
  });

  it('does not flag server named args or command as duplicate', async () => {
    const config = makeConfig({
      content: [
        '{',
        '  "mcpServers": {',
        '    "args": { "command": "foo", "args": ["--flag"] },',
        '    "command": { "command": "bar", "args": [] }',
        '  }',
        '}',
      ].join('\n'),
      servers: [
        { name: 'args', transport: 'stdio', command: 'foo', line: 3, raw: {} },
        { name: 'command', transport: 'stdio', command: 'bar', line: 4, raw: {} },
      ],
    });
    const issues = await checkMcpConsistency([config]);
    expect(issues.filter((i) => i.message.includes('Duplicate server name'))).toHaveLength(0);
  });
});
