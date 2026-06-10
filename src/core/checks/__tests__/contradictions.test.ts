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

  it('does not falsely match "test ... deploy with <fw>" prose as a framework directive', () => {
    // The unbounded `test.*with jest` pattern used to match this sentence
    // (the `.*` spanned "suite and then deploy"), which — paired with a real
    // Vitest directive elsewhere — emitted a spurious testing-framework
    // conflict. The bounded `test\w*\s+with` no longer matches.
    const files = [
      makeFile('CLAUDE.md', 'Use Vitest for testing.'),
      makeFile('AGENTS.md', 'Run our test suite and then deploy with jest.'),
    ];
    const issues = checkContradictions(files);
    const fwIssues = issues.filter((i) => i.message.includes('testing framework'));
    expect(fwIssues).toHaveLength(0);
  });

  it('still detects tight "test with <fw>" framework directives', () => {
    const files = [
      makeFile('CLAUDE.md', 'test with jest'),
      makeFile('AGENTS.md', 'Run tests with vitest'),
    ];
    const issues = checkContradictions(files);
    const fwIssues = issues.filter((i) => i.message.includes('testing framework'));
    expect(fwIssues.length).toBeGreaterThan(0);
  });

  it('does not count a negated mention as an endorsement (false-conflict shape)', () => {
    // "Never use yarn" agrees with "Use pnpm" -- it must not register a yarn
    // directive and emit a spurious package-manager conflict.
    const files = [
      makeFile('CLAUDE.md', 'Never use yarn in this repo.'),
      makeFile('AGENTS.md', 'Use pnpm for installs.'),
    ];
    const issues = checkContradictions(files);
    expect(issues.filter((i) => i.message.includes('package manager'))).toHaveLength(0);
  });

  it('ignores "do not use X" phrasings as well', () => {
    const files = [
      makeFile('CLAUDE.md', 'Do not use npm here.'),
      makeFile('AGENTS.md', 'Use pnpm for installs.'),
    ];
    const issues = checkContradictions(files);
    expect(issues.filter((i) => i.message.includes('package manager'))).toHaveLength(0);
  });

  it('reports no conflict when files agree but ban different tools', () => {
    const files = [
      makeFile('CLAUDE.md', 'Never use yarn. Use pnpm.'),
      makeFile('AGENTS.md', "Don't use bun. Use pnpm."),
    ];
    const issues = checkContradictions(files);
    expect(issues).toHaveLength(0);
  });

  it('still detects a real conflict that a negated mention used to suppress', () => {
    // Pre-guard, A's "Never use yarn" registered a yarn label, making B's
    // labels a subset of A's; the cluster filter then dropped B and the
    // genuine pnpm-vs-yarn conflict vanished.
    const files = [
      makeFile('CLAUDE.md', 'Never use yarn. Use pnpm.'),
      makeFile('AGENTS.md', 'Always use yarn as the package manager.'),
    ];
    const issues = checkContradictions(files);
    const pkgMgrIssues = issues.filter((i) => i.message.includes('package manager'));
    expect(pkgMgrIssues.length).toBeGreaterThan(0);
    expect(pkgMgrIssues[0].message).toContain('pnpm');
    expect(pkgMgrIssues[0].message).toContain('yarn');
  });

  it('registers an endorsement that follows a negated clause on the same line', () => {
    // The negation window stops at clause punctuation: "Never use yarn; use
    // pnpm" endorses pnpm.
    const files = [
      makeFile('CLAUDE.md', 'Never use yarn; use pnpm.'),
      makeFile('AGENTS.md', 'Always use bun as the package manager.'),
    ];
    const issues = checkContradictions(files);
    const pkgMgrIssues = issues.filter((i) => i.message.includes('package manager'));
    expect(pkgMgrIssues.length).toBeGreaterThan(0);
    expect(pkgMgrIssues[0].message).toContain('pnpm');
  });

  it('registers an endorsement when an earlier same-pattern occurrence is negated', () => {
    // "Don't use pnpm in CI, use pnpm locally." — the first "use pnpm" is
    // negated, but the comma ends the negation's clause, so the second is a
    // live endorsement. A first-match-only scan stopped at the negated
    // occurrence and suppressed this real cross-file conflict.
    const files = [
      makeFile('CLAUDE.md', "Don't use pnpm in CI, use pnpm locally."),
      makeFile('AGENTS.md', 'Always use yarn as the package manager.'),
    ];
    const issues = checkContradictions(files);
    const pkgMgrIssues = issues.filter((i) => i.message.includes('package manager'));
    expect(pkgMgrIssues.length).toBeGreaterThan(0);
    expect(pkgMgrIssues[0].message).toContain('pnpm');
    expect(pkgMgrIssues[0].message).toContain('yarn');
  });

  it('does not register when every same-line occurrence is negated', () => {
    const files = [
      makeFile('CLAUDE.md', "Don't use pnpm in CI and don't use pnpm locally."),
      makeFile('AGENTS.md', 'Always use yarn as the package manager.'),
    ];
    const issues = checkContradictions(files);
    expect(issues.filter((i) => i.message.includes('package manager'))).toHaveLength(0);
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
