import { describe, it, expect } from 'vitest';
import { checkMcpRedundancy } from '../redundancy.js';
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

describe('checkMcpRedundancy', () => {
  it('flags disabled servers', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'old-service',
          transport: 'stdio',
          command: 'npx',
          disabled: true,
          line: 3,
          raw: { command: 'npx', disabled: true },
        },
      ],
    });
    const issues = await checkMcpRedundancy([config]);
    const disabled = issues.find((i) => i.message.includes('disabled'));
    expect(disabled).toBeDefined();
    expect(disabled!.severity).toBe('info');
  });

  it('does not flag enabled servers', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'active-service',
          transport: 'stdio',
          command: 'npx',
          line: 3,
          raw: { command: 'npx' },
        },
      ],
    });
    const issues = await checkMcpRedundancy([config]);
    expect(issues.filter((i) => i.message.includes('disabled'))).toHaveLength(0);
  });

  it('flags identical config across project and global scope', async () => {
    const projectConfig = makeConfig({
      relativePath: '.mcp.json',
      scope: 'project',
      servers: [
        {
          name: 'api',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@some/server'],
          line: 3,
          raw: {},
        },
      ],
    });
    const globalConfig = makeConfig({
      filePath: '/home/.claude.json',
      relativePath: '.claude.json',
      scope: 'user',
      servers: [
        {
          name: 'api',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@some/server'],
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpRedundancy([projectConfig, globalConfig]);
    const identical = issues.find((i) => i.message.includes('identically configured'));
    expect(identical).toBeDefined();
    expect(identical!.severity).toBe('info');
  });

  it('does not flag different config across scopes', async () => {
    const projectConfig = makeConfig({
      scope: 'project',
      servers: [
        {
          name: 'api',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@some/server@1.0'],
          line: 3,
          raw: {},
        },
      ],
    });
    const globalConfig = makeConfig({
      filePath: '/home/.claude.json',
      relativePath: '.claude.json',
      scope: 'user',
      servers: [
        {
          name: 'api',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@some/server@2.0'],
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpRedundancy([projectConfig, globalConfig]);
    expect(issues.filter((i) => i.message.includes('identically configured'))).toHaveLength(0);
  });
});
