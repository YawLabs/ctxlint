import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkMcpEnv, formatEnvRef } from '../env.js';
import { parseMcpContent } from '../../../mcp-parser.js';
import { applyFixes } from '../../../fixer.js';
import type { McpServerEntry, ParsedMcpConfig } from '../../../types.js';

// Source text matching the hand-built servers, so fixes (which anchor on the
// value's real location in the file) can be located. Minified: every value
// sits on line 1.
function sourceFor(servers: McpServerEntry[], rootKey = 'mcpServers'): string {
  const obj = Object.fromEntries(
    servers.map((s) => [
      s.name,
      { command: s.command, args: s.args, url: s.url, headers: s.headers, env: s.env },
    ]),
  );
  return JSON.stringify({ [rootKey]: obj });
}

function makeConfig(overrides: Partial<ParsedMcpConfig> = {}): ParsedMcpConfig {
  return {
    content: sourceFor(overrides.servers ?? []),
    filePath: '/project/.mcp.json',
    relativePath: '.mcp.json',
    client: 'claude-code',
    scope: 'project',
    expectedRootKey: 'mcpServers',
    actualRootKey: 'mcpServers',
    servers: [],
    parseErrors: [],
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

  it('flags ${VAR} syntax in Windsurf config', async () => {
    const config = makeConfig({
      client: 'windsurf',
      relativePath: '.codeium/windsurf/mcp_config.json',
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
    const wrongSyntax = issues.find((i) => i.message.includes('Windsurf uses ${env:VAR}'));
    expect(wrongSyntax).toBeDefined();
    expect(wrongSyntax!.severity).toBe('error');
    expect(wrongSyntax!.fix).toMatchObject({ oldText: '${API_KEY}', newText: '${env:API_KEY}' });
  });

  it('does not flag correct ${env:VAR} syntax in Windsurf config', async () => {
    const config = makeConfig({
      client: 'windsurf',
      relativePath: '.codeium/windsurf/mcp_config.json',
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
    expect(issues.filter((i) => i.ruleId === 'mcp-env/wrong-syntax')).toHaveLength(0);
  });

  it('flags a bare ${VAR} next to a correct ${env:VAR} in Cursor config', async () => {
    // One correct reference in the value must not suppress flagging the
    // incorrect one beside it.
    const config = makeConfig({
      client: 'cursor',
      relativePath: '.cursor/mcp.json',
      servers: [
        {
          name: 'api',
          transport: 'http',
          url: 'https://api.example.com/mcp',
          headers: { Authorization: 'Bearer ${env:PREFIX}-${API_KEY}' },
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpEnv(config, '/project');
    const wrongSyntax = issues.filter((i) => i.message.includes('Cursor uses ${env:VAR}'));
    // Only the wrong ref gets a fix; the correct ${env:PREFIX} is untouched.
    expect(wrongSyntax.map((i) => [i.fix!.oldText, i.fix!.newText])).toEqual([
      ['${API_KEY}', '${env:API_KEY}'],
    ]);
  });

  it('cursor fix converts each reference separately, bounded by its own closing brace', async () => {
    // Greedy default matching used to collapse `${A:-x} and ${B}` into the
    // single replacement `${env:A}`, destroying the literal text and the
    // second reference. The default itself is dropped: ${env:VAR} has no
    // default form.
    const config = makeConfig({
      client: 'cursor',
      relativePath: '.cursor/mcp.json',
      servers: [
        {
          name: 'api',
          transport: 'stdio',
          command: 'npx',
          env: { COMBINED: '${HOST:-localhost} and ${PORT}' },
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpEnv(config, '/project');
    const wrongSyntax = issues.filter((i) => i.ruleId === 'mcp-env/wrong-syntax');
    expect(wrongSyntax.map((i) => [i.fix!.oldText, i.fix!.newText])).toEqual([
      ['${HOST:-localhost}', '${env:HOST}'],
      ['${PORT}', '${env:PORT}'],
    ]);
  });

  it('continue fix converts each reference separately, bounded by its own closing brace', async () => {
    const config = makeConfig({
      client: 'continue',
      relativePath: '.continue/mcpServers/test.json',
      servers: [
        {
          name: 'api',
          transport: 'stdio',
          command: 'npx',
          env: { COMBINED: '${HOST:-localhost} and ${PORT}' },
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpEnv(config, '/project');
    const wrongSyntax = issues.filter((i) => i.ruleId === 'mcp-env/wrong-syntax');
    expect(wrongSyntax.map((i) => [i.fix!.oldText, i.fix!.newText])).toEqual([
      ['${HOST:-localhost}', '${{ secrets.HOST }}'],
      ['${PORT}', '${{ secrets.PORT }}'],
    ]);
  });

  it('flags a bare ${VAR} in Continue config even when a correct secrets ref is present', async () => {
    const config = makeConfig({
      client: 'continue',
      relativePath: '.continue/mcpServers/test.json',
      servers: [
        {
          name: 'api',
          transport: 'http',
          url: 'https://api.example.com/mcp',
          headers: { Authorization: 'Bearer ${{ secrets.PREFIX }}-${API_KEY}' },
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpEnv(config, '/project');
    const wrongSyntax = issues.filter((i) => i.message.includes('Continue uses'));
    expect(wrongSyntax.map((i) => [i.fix!.oldText, i.fix!.newText])).toEqual([
      ['${API_KEY}', '${{ secrets.API_KEY }}'],
    ]);
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

describe('checkMcpEnv: parsed from source', () => {
  const parse = (obj: unknown, relativePath: string) =>
    parseMcpContent(JSON.stringify(obj, null, 2), {
      filePath: '/x/' + relativePath,
      relativePath,
      scope: 'project',
    });

  it('anchors the wrong-syntax fix on the value line and column, not the server line', async () => {
    const config = parse(
      { mcpServers: { api: { command: 'npx', env: { TOKEN: '${env:TOKEN}' } } } },
      '.mcp.json',
    );
    // 1 {  2 "mcpServers": {  3 "api": {  4 "command"  5 "env": {  6 "TOKEN": ...
    expect(config.servers[0].line).toBe(3);
    const issues = await checkMcpEnv(config, '/project');
    const wrong = issues.find((i) => i.ruleId === 'mcp-env/wrong-syntax');
    expect(wrong!.line).toBe(6);
    expect(wrong!.fix).toEqual({
      file: '/x/.mcp.json',
      line: 6,
      column: 19,
      oldText: '${env:TOKEN}',
      newText: '${TOKEN}',
    });
    const sourceLine = config.content.split('\n')[5];
    expect(sourceLine.slice(18, 18 + '${env:TOKEN}'.length)).toBe('${env:TOKEN}');
  });

  it('anchors fixes for args and headers on their own lines', async () => {
    const config = parse(
      {
        mcpServers: {
          a: { command: 'srv', args: ['--x', '--key=${KEY}'] },
          b: { url: 'https://h.example.com/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } },
        },
      },
      '.cursor/mcp.json',
    );
    const issues = await checkMcpEnv(config, '/project');
    const fixes = issues.filter((i) => i.ruleId === 'mcp-env/wrong-syntax').map((i) => i.fix!);
    const lines = config.content.split('\n');
    expect(fixes).toHaveLength(2);
    for (const fix of fixes) {
      expect(lines[fix.line - 1].slice(fix.column! - 1)).toMatch(
        new RegExp('^' + escapeRe(fix.oldText)),
      );
    }
    expect(fixes.map((f) => f.newText)).toEqual(['${env:KEY}', '${env:TOKEN}']);
  });

  it('emits one ref-only fix per wrong reference, and they apply end to end', async () => {
    // A whole-value fix carried the literal beside the refs (here a key in a
    // query param) in its oldText. Each fix now names only its own ref, at
    // its own column, and both land on one line without claiming each other.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-env-fix-'));
    try {
      const file = path.join(dir, '.cursor', 'mcp.json');
      fs.mkdirSync(path.dirname(file));
      const value =
        'https://h.example.com/mcp?api_key=Qw9Er8Ty7Ui6Op5As4Df3Gh&ws=${WS}&r=${REGION}';
      const content = JSON.stringify({ mcpServers: { api: { url: value } } }, null, 2);
      fs.writeFileSync(file, content);
      const config = parseMcpContent(content, {
        filePath: file,
        relativePath: '.cursor/mcp.json',
        scope: 'project',
      });
      const issues = await checkMcpEnv(config, dir);
      const wrong = issues.filter((i) => i.ruleId === 'mcp-env/wrong-syntax');
      expect(wrong.map((i) => i.fix!.oldText)).toEqual(['${WS}', '${REGION}']);
      const lines = content.split('\n');
      for (const { fix } of wrong) {
        expect(lines[fix!.line - 1].slice(fix!.column! - 1)).toMatch(
          new RegExp('^' + escapeRe(fix!.oldText)),
        );
        expect(fix!.oldText).not.toContain('Qw9Er8');
      }

      const summary = applyFixes(
        { projectRoot: dir, files: [{ path: '.cursor/mcp.json', issues: wrong }] } as never,
        { quiet: true },
      );
      expect(summary.totalFixes).toBe(2);
      expect(JSON.parse(fs.readFileSync(file, 'utf-8')).mcpServers.api.url).toBe(
        'https://h.example.com/mcp?api_key=Qw9Er8Ty7Ui6Op5As4Df3Gh&ws=${env:WS}&r=${env:REGION}',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('omits the fix when the value cannot be located in the source', async () => {
    const config = makeConfig({
      content: '{}',
      servers: [
        {
          name: 'api',
          transport: 'stdio',
          command: 'npx',
          env: { T: '${env:T}' },
          line: 1,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpEnv(config, '/project');
    const wrong = issues.find((i) => i.ruleId === 'mcp-env/wrong-syntax');
    expect(wrong).toBeDefined();
    expect(wrong!.fix).toBeUndefined();
  });

  it("does not flag or rewrite Cursor's built-in variables", async () => {
    const config = parse(
      {
        mcpServers: {
          fs: {
            command: 'node',
            args: [
              '${workspaceFolder}/dist/index.js',
              '${userHome}${pathSeparator}notes',
              '${workspaceFolderBasename}',
            ],
          },
        },
      },
      '.cursor/mcp.json',
    );
    const issues = await checkMcpEnv(config, '/project');
    expect(issues).toEqual([]);
  });

  it("does not report VS Code's predefined variables as unset", async () => {
    const config = parse(
      { servers: { fs: { command: 'node', args: ['${workspaceFolder}/x.js', '${userHome}/y'] } } },
      '.vscode/mcp.json',
    );
    expect(await checkMcpEnv(config, '/project')).toEqual([]);
  });

  it('still treats ${workspaceFolder} as an env var in a Claude Code config', async () => {
    const config = parse(
      { mcpServers: { fs: { command: 'node', args: ['${workspaceFolder}/x.js'] } } },
      '.mcp.json',
    );
    const issues = await checkMcpEnv(config, '/project');
    expect(issues.map((i) => i.ruleId)).toEqual(['mcp-env/unset-variable']);
  });

  it('treats a ${VAR:-default} reference as satisfied', async () => {
    const config = parse(
      {
        mcpServers: {
          s: { command: 'srv', env: { PORT: '${UNLIKELY_CTXLINT_PORT_VAR:-8080}' } },
        },
      },
      '.mcp.json',
    );
    expect(await checkMcpEnv(config, '/project')).toEqual([]);
  });
});

describe('formatEnvRef', () => {
  it("emits each client's own reference syntax", () => {
    expect(formatEnvRef('claude-code', 'K')).toBe('${K}');
    expect(formatEnvRef('cursor', 'K')).toBe('${env:K}');
    expect(formatEnvRef('windsurf', 'K')).toBe('${env:K}');
    expect(formatEnvRef('vscode', 'K')).toBe('${env:K}');
    expect(formatEnvRef('continue', 'K')).toBe('${{ secrets.K }}');
  });

  it('returns null for clients that do not interpolate env references', () => {
    expect(formatEnvRef('claude-desktop', 'K')).toBeNull();
    expect(formatEnvRef('amazonq', 'K')).toBeNull();
  });
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
