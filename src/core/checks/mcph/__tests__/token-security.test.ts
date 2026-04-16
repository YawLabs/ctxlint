import { describe, it, expect } from 'vitest';
import { checkMcphTokenSecurity } from '../token-security.js';
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

describe('checkMcphTokenSecurity', () => {
  it('fires token-in-project-scope on git-tracked project file with token', async () => {
    const config = makeConfig({
      scope: 'project',
      isGitTracked: true,
      raw: { token: 'mcp_pat_abc123' },
      positions: { token: { line: 3, column: 5, endLine: 3, endColumn: 12 } },
    });
    const issues = await checkMcphTokenSecurity(config, '/project');
    const leak = issues.find((i) => i.ruleId === 'mcph-config/token-in-project-scope');
    expect(leak).toBeDefined();
    expect(leak!.severity).toBe('error');
    expect(leak!.line).toBe(3);
    expect(leak!.suggestion).toContain('ROTATE');
    expect(leak!.suggestion).toContain('MCPH_TOKEN');
  });

  it('does not fire token-in-project-scope on non-tracked file', async () => {
    const config = makeConfig({
      scope: 'project',
      isGitTracked: false,
      raw: { token: 'mcp_pat_abc123' },
      positions: { token: { line: 3, column: 5, endLine: 3, endColumn: 12 } },
    });
    const issues = await checkMcphTokenSecurity(config, '/project');
    expect(issues.find((i) => i.ruleId === 'mcph-config/token-in-project-scope')).toBeUndefined();
  });

  it('does not fire token-in-project-scope on global scope', async () => {
    const config = makeConfig({
      scope: 'global',
      isGitTracked: false,
      raw: { token: 'mcp_pat_abc123' },
      positions: { token: { line: 2, column: 5, endLine: 2, endColumn: 12 } },
    });
    const issues = await checkMcphTokenSecurity(config, '/project');
    expect(issues.find((i) => i.ruleId === 'mcph-config/token-in-project-scope')).toBeUndefined();
  });

  it('fires invalid-token-format when pattern fails', async () => {
    const config = makeConfig({
      raw: { token: 'not-a-valid-pat' },
      positions: { token: { line: 3, column: 5, endLine: 3, endColumn: 12 } },
    });
    const issues = await checkMcphTokenSecurity(config, '/project');
    const bad = issues.find((i) => i.ruleId === 'mcph-config/invalid-token-format');
    expect(bad).toBeDefined();
    expect(bad!.severity).toBe('error');
  });

  it('fires prefer-env-token on global-scope file with valid token (warning)', async () => {
    const config = makeConfig({
      scope: 'global',
      raw: { token: 'mcp_pat_abc123' },
      positions: { token: { line: 2, column: 5, endLine: 2, endColumn: 12 } },
    });
    const issues = await checkMcphTokenSecurity(config, '/project');
    const pref = issues.find((i) => i.ruleId === 'mcph-config/prefer-env-token');
    expect(pref).toBeDefined();
    expect(pref!.severity).toBe('warning');
    expect(pref!.suggestion).toContain('MCPH_TOKEN');
    expect(pref!.suggestion).toContain('PowerShell');
  });

  it('upgrades prefer-env-token to error under strictEnvToken', async () => {
    const config = makeConfig({
      scope: 'global',
      raw: { token: 'mcp_pat_abc123' },
      positions: { token: { line: 2, column: 5, endLine: 2, endColumn: 12 } },
    });
    const issues = await checkMcphTokenSecurity(config, '/project', { strictEnvToken: true });
    const pref = issues.find((i) => i.ruleId === 'mcph-config/prefer-env-token');
    expect(pref!.severity).toBe('error');
  });

  it('does not double-report prefer-env-token when project-scope leak fires', async () => {
    const config = makeConfig({
      scope: 'project',
      isGitTracked: true,
      raw: { token: 'mcp_pat_abc123' },
      positions: { token: { line: 3, column: 5, endLine: 3, endColumn: 12 } },
    });
    const issues = await checkMcphTokenSecurity(config, '/project');
    expect(issues.filter((i) => i.ruleId === 'mcph-config/token-in-project-scope')).toHaveLength(1);
    expect(issues.filter((i) => i.ruleId === 'mcph-config/prefer-env-token')).toHaveLength(0);
  });

  it('returns no issues when token is absent', async () => {
    const config = makeConfig({ raw: { apiBase: 'https://mcp.hosting' }, positions: {} });
    const issues = await checkMcphTokenSecurity(config, '/project');
    expect(issues).toHaveLength(0);
  });
});
