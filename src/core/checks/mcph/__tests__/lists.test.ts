import { describe, it, expect } from 'vitest';
import { checkMcphLists } from '../lists.js';
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

function entry(value: string, line: number) {
  return { value, position: { line, column: 5, endLine: line, endColumn: 5 + value.length + 2 } };
}

describe('checkMcphLists', () => {
  it('fires allowlist-denylist-conflict when namespace is in both lists', async () => {
    const config = makeConfig({
      listEntries: {
        servers: [entry('foo', 5)],
        blocked: [entry('foo', 10)],
      },
    });
    const issues = await checkMcphLists(config, '/project');
    const conflict = issues.find((i) => i.ruleId === 'mcph-config/allowlist-denylist-conflict');
    expect(conflict).toBeDefined();
    expect(conflict!.severity).toBe('warning');
    expect(conflict!.line).toBe(5);
    expect(conflict!.message).toContain('foo');
  });

  it('does not fire conflict when no overlap', async () => {
    const config = makeConfig({
      listEntries: {
        servers: [entry('foo', 5)],
        blocked: [entry('bar', 10)],
      },
    });
    const issues = await checkMcphLists(config, '/project');
    expect(issues.find((i) => i.ruleId === 'mcph-config/allowlist-denylist-conflict')).toBeUndefined();
  });

  it('fires duplicate-entries for repeated servers entry', async () => {
    const config = makeConfig({
      listEntries: {
        servers: [entry('foo', 5), entry('foo', 7)],
        blocked: [],
      },
    });
    const issues = await checkMcphLists(config, '/project');
    const dup = issues.find((i) => i.ruleId === 'mcph-config/duplicate-entries');
    expect(dup).toBeDefined();
    expect(dup!.severity).toBe('info');
    expect(dup!.line).toBe(7);
    expect(dup!.message).toContain('line 5');
    expect(dup!.message).toContain('servers');
  });

  it('fires duplicate-entries for repeated blocked entry', async () => {
    const config = makeConfig({
      listEntries: {
        servers: [],
        blocked: [entry('bar', 3), entry('bar', 9)],
      },
    });
    const issues = await checkMcphLists(config, '/project');
    const dup = issues.find((i) => i.ruleId === 'mcph-config/duplicate-entries');
    expect(dup).toBeDefined();
    expect(dup!.message).toContain('blocked');
  });

  it('returns no issues on disjoint, unique lists', async () => {
    const config = makeConfig({
      listEntries: {
        servers: [entry('a', 2), entry('b', 3)],
        blocked: [entry('c', 7)],
      },
    });
    const issues = await checkMcphLists(config, '/project');
    expect(issues).toHaveLength(0);
  });

  it('returns no issues when there are parse errors', async () => {
    const config = makeConfig({
      parseErrors: ['bad'],
      listEntries: {
        servers: [entry('foo', 5)],
        blocked: [entry('foo', 10)],
      },
    });
    const issues = await checkMcphLists(config, '/project');
    expect(issues).toHaveLength(0);
  });
});
