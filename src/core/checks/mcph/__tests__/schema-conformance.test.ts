import { describe, it, expect } from 'vitest';
import { checkMcphSchemaConformance } from '../schema-conformance.js';
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

describe('checkMcphSchemaConformance', () => {
  it('fires unknown-field on typo', async () => {
    const config = makeConfig({
      raw: { tokens: 'x' },
      unknownFields: [
        { name: 'tokens', position: { line: 2, column: 3, endLine: 2, endColumn: 11 } },
      ],
    });
    const issues = await checkMcphSchemaConformance(config, '/project');
    const u = issues.find((i) => i.ruleId === 'mcph-config/unknown-field');
    expect(u).toBeDefined();
    expect(u!.severity).toBe('warning');
    expect(u!.message).toContain('tokens');
    expect(u!.line).toBe(2);
  });

  it('fires multiple unknown-field issues for multiple typos', async () => {
    const config = makeConfig({
      unknownFields: [
        { name: 'tokens', position: { line: 2, column: 3, endLine: 2, endColumn: 11 } },
        { name: 'blockList', position: { line: 4, column: 3, endLine: 4, endColumn: 14 } },
      ],
    });
    const issues = await checkMcphSchemaConformance(config, '/project');
    expect(issues.filter((i) => i.ruleId === 'mcph-config/unknown-field')).toHaveLength(2);
  });

  it('fires stale-version when version < 1', async () => {
    const config = makeConfig({
      raw: { version: 0 },
      positions: { version: { line: 3, column: 5, endLine: 3, endColumn: 15 } },
    });
    const issues = await checkMcphSchemaConformance(config, '/project');
    const s = issues.find((i) => i.ruleId === 'mcph-config/stale-version');
    expect(s).toBeDefined();
    expect(s!.severity).toBe('info');
    expect(s!.line).toBe(3);
  });

  it('does not fire stale-version at current version', async () => {
    const config = makeConfig({
      raw: { version: 1 },
      positions: { version: { line: 3, column: 5, endLine: 3, endColumn: 15 } },
    });
    const issues = await checkMcphSchemaConformance(config, '/project');
    expect(issues.find((i) => i.ruleId === 'mcph-config/stale-version')).toBeUndefined();
  });

  it('does not fire stale-version when version is absent', async () => {
    const config = makeConfig({ raw: {}, positions: {} });
    const issues = await checkMcphSchemaConformance(config, '/project');
    expect(issues.find((i) => i.ruleId === 'mcph-config/stale-version')).toBeUndefined();
  });

  it('returns no issues when there are parse errors', async () => {
    const config = makeConfig({
      parseErrors: ['bad json'],
      unknownFields: [
        { name: 'tokens', position: { line: 2, column: 3, endLine: 2, endColumn: 11 } },
      ],
    });
    const issues = await checkMcphSchemaConformance(config, '/project');
    expect(issues).toHaveLength(0);
  });
});
