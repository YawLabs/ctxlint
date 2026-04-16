import { describe, it, expect } from 'vitest';
import { checkMcphApibase } from '../apibase.js';
import type { ParsedMchpConfig } from '../../../types.js';

function makeConfig(overrides: Partial<ParsedMchpConfig> = {}): ParsedMchpConfig {
  return {
    filePath: '/project/.mcph.json',
    relativePath: '.mcph.json',
    scope: 'project',
    content: '{}',
    parseErrors: [],
    isGitTracked: false,
    isGitignored: false,
    raw: {},
    positions: {},
    listEntries: { servers: [], blocked: [] },
    unknownFields: [],
    ...overrides,
  };
}

describe('checkMcphApibase', () => {
  it('fires invalid-apibase when URL is malformed', async () => {
    const config = makeConfig({
      raw: { apiBase: 'not a url' },
      positions: { apiBase: { line: 2, column: 5, endLine: 2, endColumn: 15 } },
    });
    const issues = await checkMcphApibase(config, '/project');
    const bad = issues.find((i) => i.ruleId === 'mcph-config/invalid-apibase');
    expect(bad).toBeDefined();
    expect(bad!.severity).toBe('error');
    expect(bad!.line).toBe(2);
  });

  it('fires insecure-apibase on public HTTP host', async () => {
    const config = makeConfig({
      raw: { apiBase: 'http://mcp.hosting' },
      positions: { apiBase: { line: 2, column: 5, endLine: 2, endColumn: 25 } },
    });
    const issues = await checkMcphApibase(config, '/project');
    const insecure = issues.find((i) => i.ruleId === 'mcph-config/insecure-apibase');
    expect(insecure).toBeDefined();
    expect(insecure!.severity).toBe('warning');
    expect(insecure!.message).toContain('mcp.hosting');
  });

  it('does not fire insecure-apibase on https', async () => {
    const config = makeConfig({
      raw: { apiBase: 'https://mcp.hosting' },
      positions: { apiBase: { line: 2, column: 5, endLine: 2, endColumn: 26 } },
    });
    const issues = await checkMcphApibase(config, '/project');
    expect(issues).toHaveLength(0);
  });

  it('does not fire on http://localhost', async () => {
    const config = makeConfig({
      raw: { apiBase: 'http://localhost:3000' },
      positions: { apiBase: { line: 2, column: 5, endLine: 2, endColumn: 28 } },
    });
    const issues = await checkMcphApibase(config, '/project');
    expect(issues.find((i) => i.ruleId === 'mcph-config/insecure-apibase')).toBeUndefined();
  });

  it('does not fire on http://127.0.0.1', async () => {
    const config = makeConfig({
      raw: { apiBase: 'http://127.0.0.1:8080' },
      positions: { apiBase: { line: 2, column: 5, endLine: 2, endColumn: 28 } },
    });
    const issues = await checkMcphApibase(config, '/project');
    expect(issues.find((i) => i.ruleId === 'mcph-config/insecure-apibase')).toBeUndefined();
  });

  it('does not fire on RFC1918 10.x', async () => {
    const config = makeConfig({
      raw: { apiBase: 'http://10.0.0.5' },
      positions: { apiBase: { line: 2, column: 5, endLine: 2, endColumn: 22 } },
    });
    const issues = await checkMcphApibase(config, '/project');
    expect(issues.find((i) => i.ruleId === 'mcph-config/insecure-apibase')).toBeUndefined();
  });

  it('does not fire on *.local', async () => {
    const config = makeConfig({
      raw: { apiBase: 'http://myserver.local' },
      positions: { apiBase: { line: 2, column: 5, endLine: 2, endColumn: 28 } },
    });
    const issues = await checkMcphApibase(config, '/project');
    expect(issues.find((i) => i.ruleId === 'mcph-config/insecure-apibase')).toBeUndefined();
  });

  it('does not fire on *.internal', async () => {
    const config = makeConfig({
      raw: { apiBase: 'http://mcp.internal' },
      positions: { apiBase: { line: 2, column: 5, endLine: 2, endColumn: 26 } },
    });
    const issues = await checkMcphApibase(config, '/project');
    expect(issues.find((i) => i.ruleId === 'mcph-config/insecure-apibase')).toBeUndefined();
  });

  it('returns no issues when apiBase is absent', async () => {
    const config = makeConfig({ raw: { token: 'mcp_pat_abc' }, positions: {} });
    const issues = await checkMcphApibase(config, '/project');
    expect(issues).toHaveLength(0);
  });

  it('returns no issues when there are parse errors', async () => {
    const config = makeConfig({
      parseErrors: ['unexpected token'],
      raw: { apiBase: 'http://public.example.com' },
      positions: { apiBase: { line: 2, column: 5, endLine: 2, endColumn: 30 } },
    });
    const issues = await checkMcphApibase(config, '/project');
    expect(issues).toHaveLength(0);
  });
});
