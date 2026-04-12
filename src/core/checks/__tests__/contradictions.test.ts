import { describe, it, expect } from 'vitest';
import { checkContradictions } from '../contradictions.js';
import type { ParsedContextFile } from '../../types.js';

function makeFile(relativePath: string, content: string): ParsedContextFile {
  return {
    filePath: `/project/${relativePath}`,
    relativePath,
    isSymlink: false,
    totalTokens: 0,
    totalLines: content.split('\n').length,
    content,
    sections: [],
    references: { paths: [], commands: [] },
  };
}

describe('checkContradictions', () => {
  it('detects testing framework conflicts across files', () => {
    const files = [
      makeFile('CLAUDE.md', 'Use Vitest for testing.'),
      makeFile('AGENTS.md', 'Use Jest for testing.'),
    ];

    const issues = checkContradictions(files);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].check).toBe('contradictions');
    expect(issues[0].message).toContain('testing framework');
  });

  it('detects package manager conflicts', () => {
    const files = [
      makeFile('CLAUDE.md', 'Always use pnpm as the package manager.'),
      makeFile('.cursorrules', 'Always use yarn as the package manager.'),
    ];

    const issues = checkContradictions(files);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].message).toContain('package manager');
  });

  it('detects indentation conflicts', () => {
    const files = [
      makeFile('CLAUDE.md', 'Use tabs for indentation.'),
      makeFile('AGENTS.md', 'Use 2-space indentation.'),
    ];

    const issues = checkContradictions(files);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].message).toContain('indentation');
  });

  it('returns no issues when files agree', () => {
    const files = [
      makeFile('CLAUDE.md', 'Use Vitest for testing.'),
      makeFile('AGENTS.md', 'Use Vitest for testing.'),
    ];

    const issues = checkContradictions(files);
    expect(issues.length).toBe(0);
  });

  it('returns no issues with single file', () => {
    const files = [makeFile('CLAUDE.md', 'Use Jest for testing.')];

    const issues = checkContradictions(files);
    expect(issues.length).toBe(0);
  });

  it('returns no issues with no directive matches', () => {
    const files = [
      makeFile('CLAUDE.md', 'This project is great.'),
      makeFile('AGENTS.md', 'Follow the coding standards.'),
    ];

    const issues = checkContradictions(files);
    expect(issues.length).toBe(0);
  });

  it('detects semicolon conflicts', () => {
    const files = [
      makeFile('CLAUDE.md', 'Always use semicolons at end of statements.'),
      makeFile('AGENTS.md', 'No semicolons please.'),
    ];
    const issues = checkContradictions(files);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].message).toContain('semicolons');
  });

  it('detects quote-style conflicts', () => {
    const files = [
      makeFile('CLAUDE.md', 'Use single quotes for strings.'),
      makeFile('AGENTS.md', 'Use double quotes throughout.'),
    ];
    const issues = checkContradictions(files);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].message).toContain('quote style');
  });

  it('detects naming-convention conflicts', () => {
    const files = [
      makeFile('CLAUDE.md', 'Use camelCase for variable names.'),
      makeFile('AGENTS.md', 'Use snake_case for variable names.'),
    ];
    const issues = checkContradictions(files);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].message).toContain('naming convention');
  });

  it('detects CSS-approach conflicts', () => {
    const files = [
      makeFile('CLAUDE.md', 'Use Tailwind for styling.'),
      makeFile('AGENTS.md', 'Use CSS Modules for styling.'),
    ];
    const issues = checkContradictions(files);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].message).toContain('CSS approach');
  });

  it('detects state-management conflicts', () => {
    const files = [
      makeFile('CLAUDE.md', 'Use Redux for state.'),
      makeFile('AGENTS.md', 'Use Zustand for state.'),
    ];
    const issues = checkContradictions(files);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].message).toContain('state management');
  });

  it('emits a single cluster issue for 3+ file conflict', () => {
    const files = [
      makeFile('CLAUDE.md', 'Always use pnpm as the package manager.'),
      makeFile('AGENTS.md', 'Always use yarn as the package manager.'),
      makeFile('.cursorrules', 'Always use bun as the package manager.'),
    ];
    const issues = checkContradictions(files);
    const pkgMgrIssues = issues.filter((i) => i.message.includes('package manager'));
    // Previously emitted C(3,2)=3 pairwise issues; now a single cluster issue.
    expect(pkgMgrIssues).toHaveLength(1);
    expect(pkgMgrIssues[0].message).toContain('3 files');
  });
});
