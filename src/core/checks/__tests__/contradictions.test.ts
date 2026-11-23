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
    expect(issues).toHaveLength(1);
    expect(issues[0].check).toBe('contradictions');
    expect(issues[0].message).toBe(
      'testing framework conflict: "Vitest" in CLAUDE.md vs "Jest" in AGENTS.md',
    );
  });

  it('detects package manager conflicts', () => {
    const files = [
      makeFile('CLAUDE.md', 'Always use pnpm as the package manager.'),
      makeFile('.cursorrules', 'Always use yarn as the package manager.'),
    ];

    const issues = checkContradictions(files);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toBe(
      'package manager conflict: "pnpm" in CLAUDE.md vs "yarn" in .cursorrules',
    );
  });

  it('detects indentation conflicts', () => {
    const files = [
      makeFile('CLAUDE.md', 'Use tabs for indentation.'),
      makeFile('AGENTS.md', 'Use 2-space indentation.'),
    ];

    const issues = checkContradictions(files);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('"tabs" in CLAUDE.md vs "2 spaces" in AGENTS.md');
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
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain(
      '"semicolons" in CLAUDE.md vs "no semicolons" in AGENTS.md',
    );
  });

  it('detects quote-style conflicts', () => {
    const files = [
      makeFile('CLAUDE.md', 'Use single quotes for strings.'),
      makeFile('AGENTS.md', 'Use double quotes throughout.'),
    ];
    const issues = checkContradictions(files);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('quote style');
    expect(issues[0].message).toContain(
      '"single quotes" in CLAUDE.md vs "double quotes" in AGENTS.md',
    );
  });

  it('detects naming-convention conflicts', () => {
    const files = [
      makeFile('CLAUDE.md', 'Use camelCase for variable names.'),
      makeFile('AGENTS.md', 'Use snake_case for variable names.'),
    ];
    const issues = checkContradictions(files);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('naming convention');
    expect(issues[0].message).toContain('"camelCase" in CLAUDE.md vs "snake_case" in AGENTS.md');
  });

  it('detects CSS-approach conflicts', () => {
    const files = [
      makeFile('CLAUDE.md', 'Use Tailwind for styling.'),
      makeFile('AGENTS.md', 'Use CSS Modules for styling.'),
    ];
    const issues = checkContradictions(files);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('CSS approach');
    expect(issues[0].message).toContain('"Tailwind" in CLAUDE.md vs "CSS Modules" in AGENTS.md');
  });

  it('detects state-management conflicts', () => {
    const files = [
      makeFile('CLAUDE.md', 'Use Redux for state.'),
      makeFile('AGENTS.md', 'Use Zustand for state.'),
    ];
    const issues = checkContradictions(files);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('"Redux" in CLAUDE.md vs "Zustand" in AGENTS.md');
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
    expect(fwIssues).toHaveLength(1);
    expect(fwIssues[0].message).toContain('"Jest" in CLAUDE.md vs "Vitest" in AGENTS.md');
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
    expect(pkgMgrIssues).toHaveLength(1);
    expect(pkgMgrIssues[0].message).toContain('"pnpm" in CLAUDE.md vs "yarn" in AGENTS.md');
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
    expect(pkgMgrIssues).toHaveLength(1);
    expect(pkgMgrIssues[0].message).toContain('"pnpm" in CLAUDE.md vs "bun" in AGENTS.md');
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
    expect(pkgMgrIssues).toHaveLength(1);
    expect(pkgMgrIssues[0].message).toContain('"pnpm" in CLAUDE.md vs "yarn" in AGENTS.md');
  });

  it('does not register when every same-line occurrence is negated', () => {
    const files = [
      makeFile('CLAUDE.md', "Don't use pnpm in CI and don't use pnpm locally."),
      makeFile('AGENTS.md', 'Always use yarn as the package manager.'),
    ];
    const issues = checkContradictions(files);
    expect(issues.filter((i) => i.message.includes('package manager'))).toHaveLength(0);
  });

  it('does not flag a file that LISTS multiple options in one category as conflicting', () => {
    // CLAUDE.md legitimately lists both quote styles (single in TS, double in
    // JSON) -> {single quotes, double quotes}. AGENTS.md picks one of them.
    // The lister is a superset of the picker, not a contradiction: the picker's
    // label is already present in the lister, so there is no TRUE cross-file
    // disagreement and no conflict must fire.
    const files = [
      makeFile('CLAUDE.md', 'Use single quotes for TS. Use double quotes for JSON config.'),
      makeFile('AGENTS.md', 'Prefer single quotes everywhere.'),
    ];
    const issues = checkContradictions(files);
    expect(issues.filter((i) => i.message.includes('quote style'))).toHaveLength(0);
  });

  it('still flags two files that each pick a DIFFERENT single option', () => {
    // Sanity: the multi-label guard must not suppress a genuine pick-vs-pick
    // disagreement.
    const files = [
      makeFile('CLAUDE.md', 'Use single quotes everywhere.'),
      makeFile('AGENTS.md', 'Use double quotes everywhere.'),
    ];
    const issues = checkContradictions(files);
    expect(issues.filter((i) => i.message.includes('quote style'))).toHaveLength(1);
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

  describe('complementary choices are not conflicts', () => {
    it('unit-test and e2e frameworks are separate categories', () => {
      const files = [
        makeFile('CLAUDE.md', 'Use Vitest for unit tests.'),
        makeFile('AGENTS.md', 'Use Playwright for e2e tests.'),
      ];
      expect(checkContradictions(files)).toHaveLength(0);
    });

    it('still flags two e2e frameworks', () => {
      const files = [
        makeFile('CLAUDE.md', 'Use Playwright for e2e tests.'),
        makeFile('AGENTS.md', 'Use Cypress for e2e tests.'),
      ];
      const issues = checkContradictions(files);
      expect(issues).toHaveLength(1);
      expect(issues[0].message).toBe(
        'e2e testing framework conflict: "Playwright" in CLAUDE.md vs "Cypress" in AGENTS.md',
      );
    });

    it('naming conventions for different objects do not conflict', () => {
      const files = [
        makeFile('CLAUDE.md', 'Use camelCase for variables.'),
        makeFile('AGENTS.md', 'Use PascalCase for React components.'),
      ];
      expect(checkContradictions(files)).toHaveLength(0);
    });

    it('kebab-case file names vs camelCase variables do not conflict', () => {
      const files = [
        makeFile('CLAUDE.md', 'Use kebab-case for file names.'),
        makeFile('AGENTS.md', 'Use camelCase for variables.'),
      ];
      expect(checkContradictions(files)).toHaveLength(0);
    });

    it('naming conventions for the same object (singular/plural, "names") still conflict', () => {
      const files = [
        makeFile('CLAUDE.md', 'Use camelCase for variables.'),
        makeFile('AGENTS.md', 'Use snake_case for variable names.'),
      ];
      const issues = checkContradictions(files);
      expect(issues).toHaveLength(1);
      expect(issues[0].message).toBe(
        'naming convention (variable) conflict: "camelCase" in CLAUDE.md vs "snake_case" in AGENTS.md',
      );
    });

    it('sibling package files are not compared', () => {
      const files = [
        makeFile('packages/a/CLAUDE.md', 'Use Jest for testing.'),
        makeFile('packages/b/CLAUDE.md', 'Use Vitest for testing.'),
      ];
      expect(checkContradictions(files)).toHaveLength(0);
    });

    it('a root file still conflicts with a nested one', () => {
      const files = [
        makeFile('CLAUDE.md', 'Use Jest for testing.'),
        makeFile('packages/b/CLAUDE.md', 'Use Vitest for testing.'),
      ];
      expect(checkContradictions(files)).toHaveLength(1);
    });

    it('tool config dirs (.cursor/rules) count as project-root scope', () => {
      const files = [
        makeFile('packages/a/CLAUDE.md', 'Use Jest for testing.'),
        makeFile('.cursor/rules/testing.mdc', 'Use Vitest for testing.'),
      ];
      expect(checkContradictions(files)).toHaveLength(1);
    });
  });

  describe('missed conflicts', () => {
    it('maps a negated "use semicolons" to the opposite label', () => {
      const files = [
        makeFile('CLAUDE.md', 'Use semicolons.'),
        makeFile('AGENTS.md', "Don't use semicolons."),
      ];
      const issues = checkContradictions(files);
      expect(issues).toHaveLength(1);
      expect(issues[0].message).toBe(
        'semicolons conflict: "semicolons" in CLAUDE.md vs "no semicolons" in AGENTS.md',
      );
    });

    it.each(['Never use semicolons.', 'Do not ever use semicolons.'])(
      'maps a directly negated "%s" to the opposite label',
      (text) => {
        const files = [makeFile('CLAUDE.md', 'Use semicolons.'), makeFile('AGENTS.md', text)];
        expect(checkContradictions(files)).toHaveLength(1);
      },
    );

    // A double negative endorses semicolons: no "no semicolons" directive.
    it.each(['Do not forget to use semicolons.', "Don't skip it, always use semicolons."])(
      'does not read "%s" as "no semicolons"',
      (text) => {
        const files = [
          makeFile('CLAUDE.md', text),
          makeFile('AGENTS.md', 'Always use semicolons.'),
        ];
        expect(checkContradictions(files)).toEqual([]);
      },
    );

    it('a scoped naming exception in another file does not conflict with a general rule', () => {
      // The more specific rule overrides the general one; splitting them across
      // files is normal polyglot layering, the same as writing both in one.
      const files = [
        makeFile('CLAUDE.md', 'Use camelCase.'),
        makeFile('AGENTS.md', 'Use snake_case for Python functions.'),
      ];
      expect(checkContradictions(files)).toHaveLength(0);
    });

    it('a general naming directive that agrees with the scoped one is not a conflict', () => {
      const files = [
        makeFile('CLAUDE.md', 'Use camelCase for variables.'),
        makeFile('AGENTS.md', 'Use camelCase.'),
      ];
      expect(checkContradictions(files)).toHaveLength(0);
    });

    it('a general-vs-general conflict is still reported alongside a scoped rule', () => {
      const files = [
        makeFile('CLAUDE.md', 'Use camelCase.'),
        makeFile('AGENTS.md', 'Use snake_case.'),
        makeFile('.cursorrules', 'Use camelCase for variables.'),
      ];
      expect(checkContradictions(files).map((i) => i.message)).toEqual([
        'naming convention conflict: "camelCase" in CLAUDE.md vs "snake_case" in AGENTS.md',
      ]);
    });

    it('detects "Indentation: 4 spaces" vs tabs', () => {
      const files = [
        makeFile('CLAUDE.md', 'Use tabs for indentation.'),
        makeFile('AGENTS.md', 'Indentation: 4 spaces.'),
      ];
      const issues = checkContradictions(files);
      expect(issues).toHaveLength(1);
      expect(issues[0].message).toContain('"tabs" in CLAUDE.md vs "4 spaces" in AGENTS.md');
    });

    it('detects "Use 2 spaces for indentation" vs tabs', () => {
      const files = [
        makeFile('CLAUDE.md', 'Use tabs for indentation.'),
        makeFile('AGENTS.md', 'Use 2 spaces for indentation.'),
      ];
      const issues = checkContradictions(files);
      expect(issues).toHaveLength(1);
      expect(issues[0].message).toContain('"tabs" in CLAUDE.md vs "2 spaces" in AGENTS.md');
    });
  });

  describe('false endorsements', () => {
    it('"no longer use" is a negation', () => {
      const files = [
        makeFile('CLAUDE.md', 'We no longer use yarn.'),
        makeFile('AGENTS.md', 'Use pnpm for installs.'),
      ];
      expect(checkContradictions(files)).toHaveLength(0);
    });

    it('"Never, ever use" is a negation', () => {
      const files = [
        makeFile('CLAUDE.md', 'Never, ever use yarn.'),
        makeFile('AGENTS.md', 'Use pnpm for installs.'),
      ];
      expect(checkContradictions(files)).toHaveLength(0);
    });

    it('`use npm-check-updates` does not register npm', () => {
      const files = [
        makeFile('CLAUDE.md', 'Use npm-check-updates to bump deps.'),
        makeFile('AGENTS.md', 'Use pnpm for installs.'),
      ];
      expect(checkContradictions(files)).toHaveLength(0);
    });

    it('ignores directives inside fenced code', () => {
      const files = [
        makeFile(
          'CLAUDE.md',
          'Example rule:\n\n```markdown\nAlways use yarn as the package manager.\n```\n',
        ),
        makeFile('AGENTS.md', 'Use pnpm for installs.'),
      ];
      expect(checkContradictions(files)).toHaveLength(0);
    });

    it('prose that merely mentions "2 spaces" or "4 spaces" is not an indentation directive', () => {
      const files = [
        makeFile('CLAUDE.md', 'Use tabs for indentation.'),
        makeFile(
          'AGENTS.md',
          'Leave 2 spaces after a sentence. The table pads columns with 4 spaces.',
        ),
      ];
      expect(checkContradictions(files)).toHaveLength(0);
    });

    it('pair conflicts only pair labels each file holds and the other lacks', () => {
      // Both files hold "2 spaces"; it must not pair with anything. Only the
      // labels unique to each side ("tabs" vs "4 spaces") disagree.
      const files = [
        makeFile('CLAUDE.md', 'Use tabs for indentation. Use 2-space indentation in YAML.'),
        makeFile('AGENTS.md', 'Use 2-space indentation. Use 4-space indentation in Python.'),
      ];
      const issues = checkContradictions(files);
      expect(issues).toHaveLength(1);
      expect(issues[0].message).toContain('"tabs" in CLAUDE.md vs "4 spaces" in AGENTS.md');
    });
  });
});
