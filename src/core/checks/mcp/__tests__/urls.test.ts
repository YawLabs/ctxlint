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
