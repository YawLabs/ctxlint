import { describe, it, expect } from 'vitest';
import { checkMcpCommands } from '../commands.js';
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

describe('checkMcpCommands', () => {
  it('flags local command path that does not exist', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'local-server',
          transport: 'stdio',
          command: './scripts/nonexistent-server.sh',
          line: 3,
          raw: { command: './scripts/nonexistent-server.sh' },
        },
      ],
    });
    const issues = await checkMcpCommands(config, '/project');
    const notFound = issues.find((i) => i.message.includes('not found'));
    expect(notFound).toBeDefined();
    expect(notFound!.severity).toBe('warning');
  });

  it('flags arg that looks like a missing file path', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'server',
          transport: 'stdio',
          command: 'node',
          args: ['./scripts/nonexistent.js'],
          line: 3,
          raw: { command: 'node', args: ['./scripts/nonexistent.js'] },
        },
      ],
    });
    const issues = await checkMcpCommands(config, '/project');
    const argIssue = issues.find((i) => i.message.includes('looks like a file path'));
    expect(argIssue).toBeDefined();
    expect(argIssue!.severity).toBe('warning');
  });

  it('does not flag non-path args like flags and packages', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'server',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@some/package', '--verbose'],
          line: 3,
          raw: { command: 'npx', args: ['-y', '@some/package', '--verbose'] },
        },
      ],
    });
    const issues = await checkMcpCommands(config, '/project');
    expect(issues.filter((i) => i.message.includes('file path'))).toHaveLength(0);
  });

  it('skips http transport servers', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'remote',
          transport: 'http',
          url: 'https://example.com/mcp',
          line: 3,
          raw: { type: 'http', url: 'https://example.com/mcp' },
        },
      ],
    });
    const issues = await checkMcpCommands(config, '/project');
    expect(issues).toHaveLength(0);
  });
});
