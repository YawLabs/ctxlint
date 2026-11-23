import { describe, it, expect } from 'vitest';
import { checkMcpRedundancy } from '../redundancy.js';
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

  describe('parsed from source', () => {
    const IDENTICAL = 'mcp-redundancy/identical-across-scopes';
    const parse = (
      obj: unknown,
      relativePath: string,
      scope: 'project' | 'user',
      projectRoot?: string,
    ) =>
      parseMcpContent(JSON.stringify(obj, null, 2), {
        filePath: '/x/' + relativePath,
        relativePath,
        scope,
        projectRoot,
      });

    it('compares env blocks regardless of key order', async () => {
      const project = parse(
        { mcpServers: { s: { command: 'srv', env: { A: '1', B: '2' } } } },
        '.mcp.json',
        'project',
      );
      const user = parse(
        { mcpServers: { s: { command: 'srv', env: { B: '2', A: '1' } } } },
        '~/.claude.json',
        'user',
      );
      const issues = await checkMcpRedundancy([project, user]);
      expect(issues.filter((i) => i.ruleId === IDENTICAL)).toHaveLength(1);
    });

    it("ignores another project's ~/.claude.json block, but not this project's", async () => {
      const root = process.platform === 'win32' ? 'C:/work/app' : '/work/app';
      const project = parse(
        { mcpServers: { s: { command: 'srv' } } },
        '.mcp.json',
        'project',
        root,
      );
      const user = parse(
        {
          projects: {
            '/elsewhere': { mcpServers: { s: { command: 'srv' } } },
            [root]: { mcpServers: { s: { command: 'srv' } } },
          },
        },
        '~/.claude.json',
        'user',
        root,
      );
      const issues = await checkMcpRedundancy([project, user]);
      expect(issues.filter((i) => i.ruleId === IDENTICAL)).toHaveLength(1);

      const otherOnly = parse(
        { projects: { '/elsewhere': { mcpServers: { s: { command: 'srv' } } } } },
        '~/.claude.json',
        'user',
        root,
      );
      const none = await checkMcpRedundancy([project, otherOnly]);
      expect(none.filter((i) => i.ruleId === IDENTICAL)).toHaveLength(0);
    });
  });
});
