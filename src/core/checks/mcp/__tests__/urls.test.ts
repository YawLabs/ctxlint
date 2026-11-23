import { describe, it, expect } from 'vitest';
import { checkMcpUrls } from '../urls.js';
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

describe('checkMcpUrls', () => {
  it('flags malformed URL', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'broken',
          transport: 'http',
          url: 'not-a-url',
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpUrls(config, '/project');
    const malformed = issues.find((i) => i.message.includes('invalid URL'));
    expect(malformed).toBeDefined();
    expect(malformed!.severity).toBe('error');
  });

  it.each(['localhost:3000/mcp', 'file:///tmp/mcp', 'ftp://example.com/mcp'])(
    'flags %s (a scheme no MCP transport speaks) as malformed',
    async (url) => {
      const config = makeConfig({
        servers: [{ name: 'local', transport: 'http', url, line: 3, raw: {} }],
      });
      const issues = await checkMcpUrls(config, '/project');
      expect(issues.map((i) => i.ruleId)).toEqual(['mcp-urls/malformed-url']);
    },
  );

  it.each(['http://example.com/mcp', 'https://example.com/mcp', 'wss://example.com/mcp'])(
    'accepts the %s scheme',
    async (url) => {
      const config = makeConfig({
        servers: [{ name: 'ok', transport: 'http', url, line: 3, raw: {} }],
      });
      const issues = await checkMcpUrls(config, '/project');
      expect(issues.filter((i) => i.ruleId === 'mcp-urls/malformed-url')).toEqual([]);
    },
  );

  it('does not echo the query string or userinfo of a malformed URL', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'leaky',
          transport: 'http',
          url: 'api.example.com/mcp?token=SUPERSECRETVALUE',
          line: 3,
          raw: {},
        },
        {
          name: 'creds',
          transport: 'http',
          url: 'https://admin:hunter2pass@exa mple.com/mcp#access_token=FRAGSECRET',
          line: 4,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpUrls(config, '/project');
    const malformed = issues.filter((i) => i.ruleId === 'mcp-urls/malformed-url');
    expect(malformed).toHaveLength(2);
    const text = JSON.stringify(malformed);
    expect(text).not.toContain('SUPERSECRETVALUE');
    expect(text).not.toContain('hunter2pass');
    expect(text).not.toContain('admin');
    expect(text).not.toContain('FRAGSECRET');
    // The non-secret parts still identify the URL.
    expect(malformed[0].message).toContain('api.example.com/mcp?');
    expect(malformed[1].message).toContain('@exa mple.com/mcp');
  });

  it('skips URL validation when env var references present', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'api',
          transport: 'http',
          url: '${API_BASE_URL}/mcp',
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpUrls(config, '/project');
    expect(issues.filter((i) => i.message.includes('invalid URL'))).toHaveLength(0);
  });

  it('flags localhost URL in project config', async () => {
    const config = makeConfig({
      scope: 'project',
      servers: [
        {
          name: 'local',
          transport: 'http',
          url: 'http://localhost:3000/mcp',
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpUrls(config, '/project');
    const localhost = issues.find((i) => i.message.includes("won't work for teammates"));
    expect(localhost).toBeDefined();
    expect(localhost!.severity).toBe('warning');
  });

  it('flags IPv6 loopback [::1] URL in project config', async () => {
    // URL.hostname keeps the brackets ('[::1]'); the check must strip them.
    // Same loopback set as the http-no-tls exemption, so this config can't
    // lint clean through both rules.
    const config = makeConfig({
      scope: 'project',
      servers: [
        {
          name: 'local6',
          transport: 'http',
          url: 'http://[::1]:3000/mcp',
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpUrls(config, '/project');
    const loopback = issues.find((i) => i.ruleId === 'mcp-urls/localhost-in-project-config');
    expect(loopback).toBeDefined();
    expect(loopback!.severity).toBe('warning');
  });

  it('flags non-.1 loopback (127.0.0.2) URL in project config', async () => {
    const config = makeConfig({
      scope: 'project',
      servers: [
        {
          name: 'local127',
          transport: 'http',
          url: 'http://127.0.0.2:8080/mcp',
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpUrls(config, '/project');
    expect(issues.filter((i) => i.ruleId === 'mcp-urls/localhost-in-project-config')).toHaveLength(
      1,
    );
  });

  it('does not flag a public host masquerading as loopback (127.evil.com)', async () => {
    const config = makeConfig({
      scope: 'project',
      servers: [
        {
          name: 'fakeloop',
          transport: 'http',
          url: 'https://127.evil.com/mcp',
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpUrls(config, '/project');
    expect(issues.filter((i) => i.ruleId === 'mcp-urls/localhost-in-project-config')).toHaveLength(
      0,
    );
  });

  it('does not flag localhost in user-scope config', async () => {
    const config = makeConfig({
      scope: 'user',
      servers: [
        {
          name: 'local',
          transport: 'http',
          url: 'http://localhost:3000/mcp',
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpUrls(config, '/project');
    expect(issues.filter((i) => i.message.includes("won't work for teammates"))).toHaveLength(0);
  });

  it('flags URL with no path', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'api',
          transport: 'http',
          url: 'https://api.example.com',
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpUrls(config, '/project');
    const noPath = issues.find((i) => i.message.includes('no path'));
    expect(noPath).toBeDefined();
    expect(noPath!.severity).toBe('info');
  });

  it('does not flag URL with a path', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'api',
          transport: 'http',
          url: 'https://api.example.com/mcp',
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpUrls(config, '/project');
    expect(issues.filter((i) => i.message.includes('no path'))).toHaveLength(0);
  });

  it('skips servers without url', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'local',
          transport: 'stdio',
          command: 'npx',
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpUrls(config, '/project');
    expect(issues).toHaveLength(0);
  });
});
