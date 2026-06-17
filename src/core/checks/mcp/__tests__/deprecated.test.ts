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
    // oldText is the full matched type pair (not a bare '"sse"'), so the
    // fixer's replaceAll is anchored to the real `"type": "sse"` and can't
    // clobber an unrelated '"sse"' token sharing the line.
    expect(issues[0].fix!.oldText).toBe('"type": "sse"');
    expect(issues[0].fix!.newText).toBe('"type": "http"');
  });

  it('does not rewrite a description value "sse" sharing the type line', async () => {
    // The `"type": "sse"` pair and a description value '"sse"' live on the
    // same minified line. A bare-'"sse"' oldText would replaceAll both; the
    // full-pair oldText rewrites only the transport type.
    const config = makeConfig({
      content:
        '{\n  "mcpServers": {\n    "old": {\n      "type": "sse", "description": "speaks sse" }\n  }\n}',
      servers: [
        {
          name: 'old',
          transport: 'sse',
          line: 3,
          raw: { type: 'sse', description: 'speaks sse' },
        },
      ],
    });
    const issues = await checkMcpDeprecated(config, '/project');
    expect(issues).toHaveLength(1);
    expect(issues[0].fix).toBeDefined();
    expect(issues[0].fix!.oldText).toBe('"type": "sse"');
    expect(issues[0].fix!.newText).toBe('"type": "http"');
    // The fix string must not be a bare '"sse"' that would also catch the
    // description's '"sse"' substring.
    expect(issues[0].fix!.oldText).not.toBe('"sse"');
  });

  it('preserves original whitespace in the matched type pair', async () => {
    // Non-canonical spacing around the colon must round-trip into oldText so
    // the fixer can locate it verbatim on disk.
    const config = makeConfig({
      content:
        '{\n  "mcpServers": {\n    "old": {\n      "type"   :   "sse",\n      "url": "https://old.example.com/sse"\n    }\n  }\n}',
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
    expect(issues[0].fix!.oldText).toBe('"type"   :   "sse"');
    expect(issues[0].fix!.newText).toBe('"type"   :   "http"');
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

  it('locates the right line when an earlier line contains both "type" and "sse" as separate substrings', async () => {
    // Reproduces the prior bug: the old `.includes('"type"') && .includes('"sse"')`
    // check would fire on line 4 (which has both substrings as part of an
    // unrelated metadata object), not on the real `"type": "sse"` at line 5.
    const config = makeConfig({
      content:
        '{\n  "mcpServers": {\n    "old": {\n      "metadata": { "type": "x", "fallback": "sse" },\n      "type": "sse",\n      "url": "https://old.example.com/sse"\n    }\n  }\n}',
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
    expect(issues[0].line).toBe(5);
  });

  it('anchors at the server line when the name collides with a top-level key', async () => {
    // A name-based scan from line 0 would anchor on the top-level "settings"
    // object (line 2), leave it at depth 0, return null, and fall back to the
    // server line -- where the '"sse"' fix oldText doesn't exist. Anchoring at
    // the parser-attributed server line finds the real type line.
    const config = makeConfig({
      content: [
        '{',
        '  "settings": { "theme": "dark" },',
        '  "mcpServers": {',
        '    "settings": {',
        '      "type": "sse",',
        '      "url": "https://old.example.com/sse"',
        '    }',
        '  }',
        '}',
      ].join('\n'),
      servers: [
        {
          name: 'settings',
          transport: 'sse',
          url: 'https://old.example.com/sse',
          line: 4,
          raw: { type: 'sse', url: 'https://old.example.com/sse' },
        },
      ],
    });
    const issues = await checkMcpDeprecated(config, '/project');
    expect(issues).toHaveLength(1);
    expect(issues[0].line).toBe(5);
  });

  it("does not attribute an earlier server's type line when names collide with a scalar top-level key", async () => {
    // A scan anchored on the top-level scalar "version" (line 2) would track
    // braces through the whole mcpServers block and return server a's
    // "type": "sse" line for server "version".
    const config = makeConfig({
      content: [
        '{',
        '  "version": "2.0",',
        '  "mcpServers": {',
        '    "a": {',
        '      "type": "sse",',
        '      "url": "https://a.example.com/sse"',
        '    },',
        '    "version": {',
        '      "type": "sse",',
        '      "url": "https://v.example.com/sse"',
        '    }',
        '  }',
        '}',
      ].join('\n'),
      servers: [
        {
          name: 'a',
          transport: 'sse',
          url: 'https://a.example.com/sse',
          line: 4,
          raw: { type: 'sse', url: 'https://a.example.com/sse' },
        },
        {
          name: 'version',
          transport: 'sse',
          url: 'https://v.example.com/sse',
          line: 8,
          raw: { type: 'sse', url: 'https://v.example.com/sse' },
        },
      ],
    });
    const issues = await checkMcpDeprecated(config, '/project');
    expect(issues.map((i) => i.line)).toEqual([5, 9]);
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
