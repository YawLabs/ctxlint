import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
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

  it('does not flag path-shaped args in user-scope configs', async () => {
    // A user/global config's relative paths resolve against that client's own
    // cwd, not this project root -- resolving them here is a spurious miss.
    const config = makeConfig({
      filePath: '/home/user/.claude.json',
      relativePath: '.claude.json',
      scope: 'user',
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
    expect(issues.filter((i) => i.ruleId === 'mcp-commands/args-path-missing')).toHaveLength(0);
  });

  it('flags missing absolute-path args in user-scope configs', async () => {
    // Absolute paths are cwd-independent, so the relative-path rationale for
    // the user-scope skip doesn't apply -- and user/global configs are where
    // absolute paths are most common.
    const config = makeConfig({
      filePath: '/home/user/.claude.json',
      relativePath: '.claude.json',
      scope: 'user',
      servers: [
        {
          name: 'server',
          transport: 'stdio',
          command: 'node',
          args: ['/definitely/missing/tools/server.js'],
          line: 3,
          raw: { command: 'node', args: ['/definitely/missing/tools/server.js'] },
        },
      ],
    });
    const issues = await checkMcpCommands(config, '/project');
    expect(issues.filter((i) => i.ruleId === 'mcp-commands/args-path-missing')).toHaveLength(1);
  });

  it('does not flag relative-path commands in user-scope configs', async () => {
    // Mirrors the args-path-missing user-scope skip: a user config's relative
    // command resolves against that client's own cwd, not this project root.
    const config = makeConfig({
      filePath: '/home/user/.claude.json',
      relativePath: '.claude.json',
      scope: 'user',
      servers: [
        {
          name: 'server',
          transport: 'stdio',
          command: './bin/serve.sh',
          line: 3,
          raw: { command: './bin/serve.sh' },
        },
      ],
    });
    const issues = await checkMcpCommands(config, '/project');
    expect(issues.filter((i) => i.ruleId === 'mcp-commands/command-not-found')).toHaveLength(0);
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

  describe('windows-npx-no-wrapper', () => {
    // Swap process.platform for the duration of the test. Node prevents
    // direct reassignment; Object.defineProperty is the recommended workaround.
    function stubPlatform(value: string) {
      const original = process.platform;
      Object.defineProperty(process, 'platform', { value, configurable: true });
      return () => {
        Object.defineProperty(process, 'platform', { value: original, configurable: true });
      };
    }
    const RULE = 'mcp-commands/windows-npx-no-wrapper';
    const npx = (command = 'npx', name = 'srv') => ({
      name,
      transport: 'stdio' as const,
      command,
      args: ['-y', '@some/pkg'],
      line: 3,
      raw: {},
    });

    it('does NOT fire for a committed project file with no Windows evidence, on any host', async () => {
      // The file is shared with Mac/Linux teammates; the linting host's OS
      // says nothing about who runs it, and "cmd /c" would break them.
      for (const platform of ['win32', 'linux', 'darwin']) {
        const restore = stubPlatform(platform);
        try {
          const config = makeConfig({ scope: 'project', servers: [npx()] });
          const issues = await checkMcpCommands(config, '/project');
          expect(issues.find((i) => i.ruleId === RULE)).toBeUndefined();
        } finally {
          restore();
        }
      }
    });

    it('warns for a project file that is Windows-specific by its own content, on any host', async () => {
      for (const platform of ['win32', 'linux']) {
        const restore = stubPlatform(platform);
        try {
          const config = makeConfig({
            scope: 'project',
            servers: [
              npx(),
              {
                name: 'local',
                transport: 'stdio',
                command: 'C:\\tools\\server.exe',
                line: 8,
                raw: {},
              },
            ],
          });
          const issues = await checkMcpCommands(config, '/project');
          const w = issues.filter((i) => i.ruleId === RULE);
          expect(w).toHaveLength(1);
          expect(w[0].severity).toBe('warning');
          expect(w[0].message).toBe('Server "srv": npx requires "cmd /c" wrapper on Windows');
          expect(w[0].fix).toBeUndefined();
        } finally {
          restore();
        }
      }
    });

    it('errors for a user-scope config on a Windows host', async () => {
      const restore = stubPlatform('win32');
      try {
        const config = makeConfig({ scope: 'user', servers: [npx()] });
        const issues = await checkMcpCommands(config, '/project');
        const w = issues.find((i) => i.ruleId === RULE);
        expect(w).toBeDefined();
        expect(w!.severity).toBe('error');
        expect(w!.message).toContain('cmd /c');
        expect(w!.fix).toBeUndefined();
      } finally {
        restore();
      }
    });

    it('does NOT fire for a user-scope config on a non-Windows host', async () => {
      const restore = stubPlatform('darwin');
      try {
        const config = makeConfig({ scope: 'user', servers: [npx()] });
        const issues = await checkMcpCommands(config, '/project');
        expect(issues.find((i) => i.ruleId === RULE)).toBeUndefined();
      } finally {
        restore();
      }
    });

    it('recognises npx.cmd, bunx and pnpm as needing the wrapper too', async () => {
      const restore = stubPlatform('win32');
      try {
        const config = makeConfig({
          scope: 'user',
          servers: [npx('npx.cmd', 'a'), npx('bunx', 'b'), npx('pnpm', 'c'), npx('NPX', 'd')],
        });
        const issues = await checkMcpCommands(config, '/project');
        expect(issues.filter((i) => i.ruleId === RULE).map((i) => i.message)).toEqual([
          'Server "a": npx.cmd requires "cmd /c" wrapper on Windows',
          'Server "b": bunx requires "cmd /c" wrapper on Windows',
          'Server "c": pnpm requires "cmd /c" wrapper on Windows',
          'Server "d": NPX requires "cmd /c" wrapper on Windows',
        ]);
      } finally {
        restore();
      }
    });

    it('does NOT fire when command is already "cmd"', async () => {
      const restore = stubPlatform('win32');
      try {
        const config = makeConfig({
          scope: 'user',
          servers: [
            {
              name: 'srv',
              transport: 'stdio',
              command: 'cmd',
              args: ['/c', 'npx', '-y', '@some/pkg'],
              line: 3,
              raw: {},
            },
          ],
        });
        const issues = await checkMcpCommands(config, '/project');
        expect(issues.find((i) => i.ruleId === RULE)).toBeUndefined();
      } finally {
        restore();
      }
    });

    it('checks Windows absolute path args on a Windows host', async () => {
      const restore = stubPlatform('win32');
      try {
        const config = makeConfig({
          scope: 'user',
          servers: [
            {
              name: 's',
              transport: 'stdio',
              command: 'node',
              args: ['C:\\definitely\\missing\\server.js'],
              line: 3,
              raw: {},
            },
          ],
        });
        const issues = await checkMcpCommands(config, '/project');
        expect(issues.filter((i) => i.ruleId === 'mcp-commands/args-path-missing')).toHaveLength(1);
      } finally {
        restore();
      }
    });
  });

  it('does not flag package specs, URIs with any scheme, or image refs as file paths', async () => {
    const nonPaths = [
      '@modelcontextprotocol/server-filesystem@2025.8.21',
      'ghcr.io/org/image:1.2.3',
      'mcr.microsoft.com/playwright/mcp:v0.0.1',
      'postgresql://u@db/app.public',
      'mongodb+srv://cluster.example.net/db.json',
    ];
    const config = makeConfig({
      servers: [
        { name: 's', transport: 'stdio', command: 'npx', args: nonPaths, line: 3, raw: {} },
      ],
    });
    const issues = await checkMcpCommands(config, '/project');
    expect(issues.filter((i) => i.ruleId === 'mcp-commands/args-path-missing')).toEqual([]);
  });

  it('does not resolve args with unexpandable ${...} references literally', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 's',
          transport: 'stdio',
          command: 'node',
          args: ['${HOME}/dist/index.js', '${env:ROOT}/x/server.js', '${input:dir}/a.js'],
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpCommands(config, '/project');
    expect(issues.filter((i) => i.ruleId === 'mcp-commands/args-path-missing')).toEqual([]);
  });

  it('expands ${workspaceFolder} to the project root before checking', async () => {
    const root = path.resolve(__dirname, '..');
    const config = makeConfig({
      client: 'cursor',
      relativePath: '.cursor/mcp.json',
      servers: [
        {
          name: 's',
          transport: 'stdio',
          command: 'node',
          args: ['${workspaceFolder}/commands.ts', '${workspaceFolder}/nope/missing.js'],
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpCommands(config, root);
    expect(
      issues.filter((i) => i.ruleId === 'mcp-commands/args-path-missing').map((i) => i.message),
    ).toEqual([
      'Server "s": arg "${workspaceFolder}/nope/missing.js" looks like a file path but doesn\'t exist',
    ]);
  });

  it('does not flag URL args as missing file paths', async () => {
    const urlArgs = [
      'https://api.example.com/openapi.json',
      's3://bucket/spec.json',
      'git://git.example.com/repo.git',
    ];
    const config = makeConfig({
      servers: [
        {
          name: 'wrapper',
          transport: 'stdio',
          command: 'node',
          args: ['./wrap.js', ...urlArgs],
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpCommands(config, '/project');
    // Match the exact quoted arg the missing-path message embeds, so each
    // URL is checked whole rather than by a host-name fragment.
    const urlFalsePositives = issues.filter((i) =>
      urlArgs.some((u) => i.message.includes(`arg "${u}"`)),
    );
    expect(urlFalsePositives).toHaveLength(0);
  });
});
