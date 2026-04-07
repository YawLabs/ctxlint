import { describe, it, expect } from 'vitest';
import { checkMcpDeprecated } from '../deprecated.js';
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

describe('checkMcpDeprecated', () => {
  it('flags SSE transport as deprecated', async () => {
    const config = makeConfig({
      content:
        '{\n  "mcpServers": {\n    "old": {\n      "type": "sse",\n      "url": "https://old.example.com/sse"\n    }\n  }\n}',
      servers: [
        {
          name: 'old',
          transport: 'sse',
          url: 'https://old.example.com/sse',
          line: 3,
          raw: { type: 'sse', url: 'https://old.example.com/sse' },
        },
      ],
    });
    const issues = await checkMcpDeprecated(config, '/project');
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].message).toContain('deprecated SSE transport');
    expect(issues[0].fix).toBeDefined();
    expect(issues[0].fix!.oldText).toBe('"sse"');
    expect(issues[0].fix!.newText).toBe('"http"');
  });

  it('does not flag http transport', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'modern',
          transport: 'http',
          url: 'https://modern.example.com/mcp',
          line: 3,
          raw: { type: 'http', url: 'https://modern.example.com/mcp' },
        },
      ],
    });
    const issues = await checkMcpDeprecated(config, '/project');
    expect(issues).toHaveLength(0);
  });

  it('does not flag stdio transport', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'local',
          transport: 'stdio',
          command: 'npx',
          line: 3,
          raw: { command: 'npx' },
        },
      ],
    });
    const issues = await checkMcpDeprecated(config, '/project');
    expect(issues).toHaveLength(0);
  });
});
