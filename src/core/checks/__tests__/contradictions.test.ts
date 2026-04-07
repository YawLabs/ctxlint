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
});
