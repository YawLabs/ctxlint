import { describe, it, expect } from 'vitest';
import { checkMcpConsistency } from '../consistency.js';
import { parseMcpContent } from '../../../mcp-parser.js';
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

  it('does not flag a cross-scope difference (project overrides user is precedence, not drift)', async () => {
    const configs = [
      makeConfig({
        relativePath: '.mcp.json',
        scope: 'project',
        servers: [
          { name: 'api', transport: 'http', url: 'https://v1.example.com/mcp', line: 3, raw: {} },
        ],
      }),
      makeConfig({
        filePath: '/home/user/.claude.json',
        relativePath: '.claude.json',
        scope: 'user',
        servers: [
          { name: 'api', transport: 'http', url: 'https://v2.example.com/mcp', line: 3, raw: {} },
        ],
      }),
    ];
    const issues = await checkMcpConsistency(configs);
    expect(issues.filter((i) => i.message.includes('configured differently'))).toHaveLength(0);
  });

  it('flags user-user drift between two global client configs', async () => {
    // Two different clients' per-user files (e.g. under --mcp-global) have no
    // precedence relationship -- each client reads only its own file -- so a
    // shared server name with divergent values is drift, same as at project
    // scope.
    const configs = [
      makeConfig({
        filePath: '/home/user/.cursor/mcp.json',
        relativePath: '.cursor/mcp.json',
        client: 'cursor',
        scope: 'user',
        servers: [
          { name: 'api', transport: 'http', url: 'https://v1.example.com/mcp', line: 3, raw: {} },
        ],
      }),
      makeConfig({
        filePath: '/home/user/claude_desktop_config.json',
        relativePath: 'claude_desktop_config.json',
        client: 'claude-desktop',
        scope: 'user',
        servers: [
          { name: 'api', transport: 'http', url: 'https://v2.example.com/mcp', line: 3, raw: {} },
        ],
      }),
    ];
    const issues = await checkMcpConsistency(configs);
    expect(issues.filter((i) => i.message.includes('configured differently'))).toHaveLength(1);
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

  it('flags duplicate server name within a single file at the redefinition line', async () => {
    // Second "api" definition sits on line 7, well below line 1, so a hardcoded
    // line:1 would be wrong.
    const config = makeConfig({
      relativePath: '.mcp.json',
      content: [
        '{',
        '  "mcpServers": {',
        '    "api": {',
        '      "url": "https://old.example.com"',
        '    },',
        '    "other": { "url": "https://other.example.com" },',
        '    "api": {',
        '      "url": "https://new.example.com"',
        '    }',
        '  }',
        '}',
      ].join('\n'),
      servers: [
        { name: 'api', transport: 'http', url: 'https://new.example.com', line: 7, raw: {} },
      ],
    });
    const issues = await checkMcpConsistency([config]);
    const dup = issues.find((i) => i.message.includes('Duplicate server name'));
    expect(dup).toBeDefined();
    expect(dup!.severity).toBe('warning');
    expect(dup!.line).toBe(7);
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

  describe('parsed from source', () => {
    const parse = (content: string, relativePath: string, scope: 'project' | 'user' = 'project') =>
      parseMcpContent(content, { filePath: '/x/' + relativePath, relativePath, scope });

    it('does not report duplicates across ~/.claude.json project blocks', async () => {
      const config = parse(
        JSON.stringify(
          {
            projects: {
              '/a': { mcpServers: { github: { command: 'a' } } },
              '/b': { mcpServers: { github: { command: 'b' } } },
            },
            mcpServers: { github: { command: 'top' } },
          },
          null,
          2,
        ),
        '~/.claude.json',
        'user',
      );
      const issues = await checkMcpConsistency([config]);
      expect(issues).toEqual([]);
    });

    it('still reports a duplicate within one ~/.claude.json project block', async () => {
      const content = [
        '{ "projects": { "/a": { "mcpServers": {',
        '  "gh": { "command": "a" },',
        '  "gh": { "command": "b" }',
        '} } } }',
      ].join('\n');
      const issues = await checkMcpConsistency([parse(content, '~/.claude.json', 'user')]);
      expect(issues.map((i) => [i.ruleId, i.line])).toEqual([
        ['mcp-consistency/duplicate-server-name', 3],
      ]);
      expect(issues[0].message).toContain('projects["/a"]');
    });

    it('does not compare per-project ~/.claude.json servers against other user configs', async () => {
      // A local-scope server overrides the user-scope one by precedence.
      const claude = parse(
        JSON.stringify({ projects: { '/a': { mcpServers: { gh: { command: 'a' } } } } }),
        '~/.claude.json',
        'user',
      );
      const cursor = parse(
        JSON.stringify({ mcpServers: { gh: { command: 'b' } } }),
        '~/.cursor/mcp.json',
        'user',
      );
      const issues = await checkMcpConsistency([claude, cursor]);
      expect(
        issues.filter((i) => i.ruleId === 'mcp-consistency/same-server-different-config'),
      ).toEqual([]);
    });

    it('skips missing-from-client for a config that failed to parse', async () => {
      const primary = parse(JSON.stringify({ mcpServers: { a: { command: 'x' } } }), '.mcp.json');
      const broken = parse('{ "servers": { ', '.vscode/mcp.json');
      expect(broken.parseErrors.length).toBeGreaterThan(0);
      const issues = await checkMcpConsistency([primary, broken]);
      expect(issues.filter((i) => i.ruleId === 'mcp-consistency/missing-from-client')).toEqual([]);
    });

    it("treats each client's own env syntax as the same reference", async () => {
      const claude = parse(
        JSON.stringify({ mcpServers: { s: { command: 'srv', args: ['--key=${K}', '${H:-x}'] } } }),
        '.mcp.json',
      );
      const cursor = parse(
        JSON.stringify({
          mcpServers: { s: { command: 'srv', args: ['--key=${env:K}', '${env:H}'] } },
        }),
        '.cursor/mcp.json',
      );
      const issues = await checkMcpConsistency([claude, cursor]);
      expect(
        issues.filter((i) => i.ruleId === 'mcp-consistency/same-server-different-config'),
      ).toEqual([]);
    });

    it('still flags a real difference next to equivalent env refs', async () => {
      const claude = parse(
        JSON.stringify({ mcpServers: { s: { command: 'srv', args: ['--key=${K}'] } } }),
        '.mcp.json',
      );
      const cursor = parse(
        JSON.stringify({ mcpServers: { s: { command: 'srv', args: ['--key=${env:OTHER}'] } } }),
        '.cursor/mcp.json',
      );
      const issues = await checkMcpConsistency([claude, cursor]);
      expect(
        issues.filter((i) => i.ruleId === 'mcp-consistency/same-server-different-config'),
      ).toHaveLength(1);
    });
  });
});
