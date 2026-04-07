import { describe, it, expect } from 'vitest';
import { checkMcpSecurity } from '../security.js';
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
    isGitTracked: true,
    ...overrides,
  };
}

describe('checkMcpSecurity', () => {
  it('flags hardcoded Bearer token', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'api',
          transport: 'http',
          url: 'https://api.example.com/mcp',
          headers: {
            Authorization: 'Bearer sk-proj-abcdefghijklmnopqrstuvwxyz1234567890',
          },
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    const bearer = issues.find((i) => i.message.includes('hardcoded Bearer token'));
    expect(bearer).toBeDefined();
    expect(bearer!.severity).toBe('error');
    expect(bearer!.fix).toBeDefined();
    expect(bearer!.fix!.newText).toContain('${API_API_KEY}');
  });

  it('does not flag Bearer with env var reference', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'api',
          transport: 'http',
          url: 'https://api.example.com/mcp',
          headers: {
            Authorization: 'Bearer ${API_KEY}',
          },
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    expect(issues.filter((i) => i.message.includes('Bearer'))).toHaveLength(0);
  });

  it('flags known API key patterns in env', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'github-server',
          transport: 'stdio',
          command: 'npx',
          env: {
            GITHUB_TOKEN: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij',
          },
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    const apiKey = issues.find((i) => i.message.includes('hardcoded API key'));
    expect(apiKey).toBeDefined();
    expect(apiKey!.severity).toBe('error');
  });

  it('flags secrets in URL query params', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'api',
          transport: 'http',
          url: 'https://api.example.com/mcp?api_key=mySecret123',
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    const urlSecret = issues.find((i) => i.message.includes('secret in the URL'));
    expect(urlSecret).toBeDefined();
    expect(urlSecret!.severity).toBe('error');
  });

  it('flags HTTP without TLS for non-localhost', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'insecure',
          transport: 'http',
          url: 'http://api.production.example.com/mcp',
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    const httpIssue = issues.find((i) => i.message.includes('HTTP without TLS'));
    expect(httpIssue).toBeDefined();
    expect(httpIssue!.severity).toBe('warning');
  });

  it('does not flag HTTP for localhost', async () => {
    const config = makeConfig({
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
    const issues = await checkMcpSecurity(config, '/project');
    expect(issues.filter((i) => i.message.includes('HTTP without TLS'))).toHaveLength(0);
  });

  it('skips non-git-tracked files', async () => {
    const config = makeConfig({
      isGitTracked: false,
      servers: [
        {
          name: 'api',
          transport: 'http',
          url: 'https://api.example.com/mcp',
          headers: {
            Authorization: 'Bearer sk-proj-abcdefghijklmnopqrstuvwxyz1234567890',
          },
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    expect(issues).toHaveLength(0);
  });

  it('flags high-entropy strings in env values', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'service',
          transport: 'stdio',
          command: 'npx',
          env: {
            SECRET: 'aVeryLongBase64EncodedStringThatLooksLikeASecret123456',
          },
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    const apiKey = issues.find((i) => i.message.includes('hardcoded API key'));
    expect(apiKey).toBeDefined();
  });

  it('does not flag short safe env values', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'service',
          transport: 'stdio',
          command: 'npx',
          env: {
            DEBUG: 'true',
            LOG_LEVEL: 'info',
          },
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    expect(issues).toHaveLength(0);
  });
});
