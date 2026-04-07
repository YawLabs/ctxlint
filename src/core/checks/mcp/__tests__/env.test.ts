import { describe, it, expect } from 'vitest';
import { checkMcpEnv } from '../env.js';
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

describe('checkMcpEnv', () => {
  it('flags ${env:VAR} syntax in Claude Code config', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'api',
          transport: 'http',
          url: 'https://api.example.com/mcp',
          headers: { Authorization: 'Bearer ${env:API_KEY}' },
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpEnv(config, '/project');
    const wrongSyntax = issues.find((i) => i.message.includes('Claude Code uses ${VAR}'));
    expect(wrongSyntax).toBeDefined();
    expect(wrongSyntax!.severity).toBe('error');
    expect(wrongSyntax!.fix).toBeDefined();
  });

  it('flags ${VAR} syntax in Cursor config', async () => {
    const config = makeConfig({
      client: 'cursor',
      relativePath: '.cursor/mcp.json',
      servers: [
        {
          name: 'api',
          transport: 'http',
          url: 'https://api.example.com/mcp',
          headers: { Authorization: 'Bearer ${API_KEY}' },
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpEnv(config, '/project');
    const wrongSyntax = issues.find((i) => i.message.includes('Cursor uses ${env:VAR}'));
    expect(wrongSyntax).toBeDefined();
    expect(wrongSyntax!.severity).toBe('error');
  });

  it('does not flag correct syntax for Claude Code', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'api',
          transport: 'http',
          url: 'https://api.example.com/mcp',
          headers: { Authorization: 'Bearer ${API_KEY}' },
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpEnv(config, '/project');
    const wrongSyntax = issues.filter((i) => i.message.includes('Claude Code uses'));
    expect(wrongSyntax).toHaveLength(0);
  });

  it('reports unset environment variables', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'api',
          transport: 'http',
          url: 'https://api.example.com/mcp',
          headers: { Authorization: 'Bearer ${UNLIKELY_ENV_VAR_NAME_FOR_TESTING_12345}' },
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpEnv(config, '/project');
    const unset = issues.find((i) => i.message.includes('is not set'));
    expect(unset).toBeDefined();
    expect(unset!.severity).toBe('info');
  });

  it('reports empty env block', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'server',
          transport: 'stdio',
          command: 'npx',
          env: {},
          line: 3,
          raw: { command: 'npx', env: {} },
        },
      ],
    });
    const issues = await checkMcpEnv(config, '/project');
    const empty = issues.find((i) => i.message.includes('empty "env" block'));
    expect(empty).toBeDefined();
    expect(empty!.severity).toBe('info');
  });

  it('flags wrong syntax in Continue config', async () => {
    const config = makeConfig({
      client: 'continue',
      relativePath: '.continue/mcpServers/test.json',
      servers: [
        {
          name: 'api',
          transport: 'http',
          url: 'https://api.example.com/mcp',
          headers: { Authorization: 'Bearer ${API_KEY}' },
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpEnv(config, '/project');
    const wrongSyntax = issues.find((i) => i.message.includes('Continue uses'));
    expect(wrongSyntax).toBeDefined();
  });
});
