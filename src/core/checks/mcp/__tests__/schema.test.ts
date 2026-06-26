import { describe, it, expect } from 'vitest';
import { checkMcpSchema } from '../schema.js';
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

describe('checkMcpSchema', () => {
  it('reports invalid JSON', async () => {
    const config = makeConfig({
      parseErrors: ['Unexpected token } in JSON at position 42'],
    });
    const issues = await checkMcpSchema(config, '/project');
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
    expect(issues[0].message).toContain('not valid JSON');
  });

  it('reports missing root key', async () => {
    const config = makeConfig({
      actualRootKey: null,
      content: '{"something": {}}',
    });
    const issues = await checkMcpSchema(config, '/project');
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
    expect(issues[0].message).toContain('no "mcpServers" key');
  });

  it('reports wrong root key for VS Code', async () => {
    const config = makeConfig({
      filePath: '/project/.vscode/mcp.json',
      relativePath: '.vscode/mcp.json',
      client: 'vscode',
      expectedRootKey: 'servers',
      actualRootKey: 'mcpServers',
      content: '{\n  "mcpServers": {}\n}',
    });
    const issues = await checkMcpSchema(config, '/project');
    const wrongKey = issues.find((i) => i.message.includes('must use "servers"'));
    expect(wrongKey).toBeDefined();
    expect(wrongKey!.severity).toBe('error');
    expect(wrongKey!.fix).toBeDefined();
    expect(wrongKey!.fix!.oldText).toBe('"mcpServers"');
    expect(wrongKey!.fix!.newText).toBe('"servers"');
  });

  it('reports wrong root key for Claude Code (.mcp.json using "servers")', async () => {
    const config = makeConfig({
      actualRootKey: 'servers',
      content: '{\n  "servers": {}\n}',
    });
    const issues = await checkMcpSchema(config, '/project');
    const wrongKey = issues.find((i) => i.message.includes('must use "mcpServers"'));
    expect(wrongKey).toBeDefined();
  });

  it('suppresses the wrong-root-key fix when the expected key is also present', async () => {
    // Both "mcpServers" (expected) and "servers" (wrong) exist. Swapping
    // "servers" -> "mcpServers" would create a duplicate key, which JSON.parse
    // resolves by keeping only the last -- silently dropping a server block.
    // The wrong-root-key error must still fire, but with NO autofix.
    const config = makeConfig({
      filePath: '/project/.vscode/mcp.json',
      relativePath: '.vscode/mcp.json',
      client: 'vscode',
      expectedRootKey: 'servers',
      actualRootKey: 'mcpServers',
      content: '{\n  "mcpServers": {},\n  "servers": {}\n}',
    });
    const issues = await checkMcpSchema(config, '/project');
    const wrongKey = issues.find((i) => i.ruleId === 'mcp-schema/wrong-root-key');
    expect(wrongKey).toBeDefined();
    expect(wrongKey!.severity).toBe('error');
    expect(wrongKey!.fix).toBeUndefined();
  });

  it('keeps the wrong-root-key fix when the expected key is absent', async () => {
    // Only the wrong key exists; the expected key is nowhere in the file, so
    // the rename is safe and the autofix is still emitted, anchored to the
    // located root-key line.
    const config = makeConfig({
      filePath: '/project/.vscode/mcp.json',
      relativePath: '.vscode/mcp.json',
      client: 'vscode',
      expectedRootKey: 'servers',
      actualRootKey: 'mcpServers',
      content: '{\n  "mcpServers": {}\n}',
    });
    const issues = await checkMcpSchema(config, '/project');
    const wrongKey = issues.find((i) => i.ruleId === 'mcp-schema/wrong-root-key');
    expect(wrongKey).toBeDefined();
    expect(wrongKey!.fix).toBeDefined();
    expect(wrongKey!.fix!.oldText).toBe('"mcpServers"');
    expect(wrongKey!.fix!.newText).toBe('"servers"');
    expect(wrongKey!.fix!.line).toBe(2);
  });

  it('reports empty servers', async () => {
    const config = makeConfig({
      content: '{\n  "mcpServers": {}\n}',
    });
    const issues = await checkMcpSchema(config, '/project');
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('info');
    expect(issues[0].message).toContain('no server entries');
  });

  it('reports missing command for stdio server', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'test-server',
          transport: 'stdio',
          line: 3,
          raw: { type: 'stdio' },
        },
      ],
    });
    const issues = await checkMcpSchema(config, '/project');
    const missing = issues.find((i) => i.message.includes('no "command" field'));
    expect(missing).toBeDefined();
    expect(missing!.severity).toBe('error');
  });

  it('reports missing url for http server', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'remote',
          transport: 'http',
          line: 3,
          raw: { type: 'http' },
        },
      ],
    });
    const issues = await checkMcpSchema(config, '/project');
    const missing = issues.find((i) => i.message.includes('no "url" field'));
    expect(missing).toBeDefined();
    expect(missing!.severity).toBe('error');
  });

  it('reports missing url for sse server', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'remote',
          transport: 'sse',
          line: 3,
          raw: { type: 'sse' },
        },
      ],
    });
    const issues = await checkMcpSchema(config, '/project');
    const missing = issues.find((i) => i.message.includes('no "url" field'));
    expect(missing).toBeDefined();
  });

  it('reports unknown transport type', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'weird',
          transport: 'unknown',
          line: 3,
          raw: { type: 'websocket' },
        },
      ],
    });
    const issues = await checkMcpSchema(config, '/project');
    const unknown = issues.find((i) => i.message.includes('unknown transport type'));
    expect(unknown).toBeDefined();
    expect(unknown!.severity).toBe('warning');
    expect(unknown!.message).toContain('websocket');
  });

  it('reports a server with no transport signal at all', async () => {
    // `{}` is the most broken possible entry; missing-command/missing-url are
    // transport-conditional, so without this rule it would lint clean.
    const config = makeConfig({
      servers: [
        {
          name: 'empty',
          transport: 'unknown',
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSchema(config, '/project');
    const unknown = issues.find((i) => i.ruleId === 'mcp-schema/unknown-transport');
    expect(unknown).toBeDefined();
    expect(unknown!.severity).toBe('warning');
    expect(unknown!.message).toContain('no recognizable transport');
  });

  it('reports a non-string "type" value as unknown transport', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'mangled',
          transport: 'unknown',
          line: 3,
          raw: { type: 42 },
        },
      ],
    });
    const issues = await checkMcpSchema(config, '/project');
    expect(issues.find((i) => i.ruleId === 'mcp-schema/unknown-transport')).toBeDefined();
  });

  it('reports ambiguous transport (both command and url)', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'confused',
          transport: 'stdio',
          command: 'npx',
          url: 'https://example.com/mcp',
          line: 3,
          raw: { command: 'npx', url: 'https://example.com/mcp' },
        },
      ],
    });
    const issues = await checkMcpSchema(config, '/project');
    const ambiguous = issues.find((i) => i.message.includes('ambiguous'));
    expect(ambiguous).toBeDefined();
    expect(ambiguous!.severity).toBe('warning');
  });

  it('passes for valid config', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'filesystem',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem'],
          line: 3,
          raw: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] },
        },
        {
          name: 'remote',
          transport: 'http',
          url: 'https://api.example.com/mcp',
          line: 8,
          raw: { type: 'http', url: 'https://api.example.com/mcp' },
        },
      ],
    });
    const issues = await checkMcpSchema(config, '/project');
    expect(issues).toHaveLength(0);
  });
});
