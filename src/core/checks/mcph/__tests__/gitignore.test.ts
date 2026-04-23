import { describe, it, expect } from 'vitest';
import { checkMcphGitignore } from '../gitignore.js';
import type { ParsedMchpConfig } from '../../../types.js';

function makeConfig(overrides: Partial<ParsedMchpConfig> = {}): ParsedMchpConfig {
  return {
    filePath: '/project/.mcph.local.json',
    relativePath: '.mcph.local.json',
    scope: 'project-local',
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

describe('checkMcphGitignore', () => {
  it('fires local-file-not-gitignored on project-local file not covered by .gitignore', async () => {
    const config = makeConfig({ scope: 'project-local', isGitignored: false });
    const issues = await checkMcphGitignore(config, '/project');
    const issue = issues.find((i) => i.ruleId === 'mcph-config/local-file-not-gitignored');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('error');
    expect(issue!.message).toContain('.mcph.local.json');
    // No auto-fix: appending to a sibling .gitignore is a different-file
    // side effect the current line-in-place fixer can't safely express.
    expect(issue!.fix).toBeUndefined();
    expect(issue!.suggestion).toContain('.gitignore');
  });

  it('does not fire when project-local file is already gitignored', async () => {
    const config = makeConfig({ scope: 'project-local', isGitignored: true });
    const issues = await checkMcphGitignore(config, '/project');
    expect(issues).toHaveLength(0);
  });

  it('does not fire on global scope', async () => {
    const config = makeConfig({
      filePath: '/home/user/.mcph.json',
      relativePath: '.mcph.json',
      scope: 'global',
      isGitignored: false,
    });
    const issues = await checkMcphGitignore(config, '/project');
    expect(issues).toHaveLength(0);
  });

  it('does not fire on project scope', async () => {
    const config = makeConfig({
      filePath: '/project/.mcph.json',
      relativePath: '.mcph.json',
      scope: 'project',
      isGitignored: false,
    });
    const issues = await checkMcphGitignore(config, '/project');
    expect(issues).toHaveLength(0);
  });
});
