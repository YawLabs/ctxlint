import { describe, it, expect } from 'vitest';
import { checkFrontmatter } from '../frontmatter.js';
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

describe('checkFrontmatter', () => {
  describe('Cursor .mdc files', () => {
    it('warns when .mdc file has no frontmatter', async () => {
      const file = makeFile('.cursor/rules/test.mdc', 'No frontmatter here.');
      const issues = await checkFrontmatter(file, '/project');
      expect(issues.length).toBeGreaterThan(0);
      expect(issues[0].message).toContain('missing frontmatter');
    });

    it('warns when missing description field', async () => {
      const file = makeFile('.cursor/rules/test.mdc', '---\nalwaysApply: true\n---\nSome content.');
      const issues = await checkFrontmatter(file, '/project');
      const descIssue = issues.find((i) => i.message.includes('description'));
      expect(descIssue).toBeDefined();
    });

    it('errors on invalid alwaysApply value', async () => {
      const file = makeFile(
        '.cursor/rules/test.mdc',
        '---\ndescription: test\nalwaysApply: maybe\n---\nContent.',
      );
      const issues = await checkFrontmatter(file, '/project');
      const invalidIssue = issues.find((i) => i.severity === 'error');
      expect(invalidIssue).toBeDefined();
      expect(invalidIssue!.message).toContain('alwaysApply');
    });

    it('passes for valid .mdc frontmatter', async () => {
      const file = makeFile(
        '.cursor/rules/test.mdc',
        '---\ndescription: My rule\nglobs: ["src/**/*.ts"]\nalwaysApply: false\n---\nContent.',
      );
      const issues = await checkFrontmatter(file, '/project');
      expect(issues.length).toBe(0);
    });

    it('accepts a bare directory name in globs (no slash, no star)', async () => {
      const file = makeFile(
        '.cursor/rules/test.mdc',
        '---\ndescription: My rule\nglobs: src\nalwaysApply: false\n---\nContent.',
      );
      const issues = await checkFrontmatter(file, '/project');
      const globsIssue = issues.find((i) => i.message.toLowerCase().includes('globs'));
      expect(globsIssue).toBeUndefined();
    });

    it('accepts a glob pattern with slash and star in globs', async () => {
      const file = makeFile(
        '.cursor/rules/test.mdc',
        '---\ndescription: My rule\nglobs: src/**/*.ts\nalwaysApply: false\n---\nContent.',
      );
      const issues = await checkFrontmatter(file, '/project');
      const globsIssue = issues.find((i) => i.message.toLowerCase().includes('globs'));
      expect(globsIssue).toBeUndefined();
    });

    it('accepts a bare extension in globs', async () => {
      const file = makeFile(
        '.cursor/rules/test.mdc',
        '---\ndescription: My rule\nglobs: ts\nalwaysApply: false\n---\nContent.',
      );
      const issues = await checkFrontmatter(file, '/project');
      const globsIssue = issues.find((i) => i.message.toLowerCase().includes('globs'));
      expect(globsIssue).toBeUndefined();
    });

    it('flags globs with unmatched brackets', async () => {
      const file = makeFile(
        '.cursor/rules/test.mdc',
        '---\ndescription: My rule\nglobs: ["src/**/*.ts"\nalwaysApply: false\n---\nContent.',
      );
      const issues = await checkFrontmatter(file, '/project');
      const globsIssue = issues.find((i) => i.message.toLowerCase().includes('globs'));
      expect(globsIssue).toBeDefined();
      expect(globsIssue!.message).toContain('malformed');
    });

    it('flags globs with unmatched quotes', async () => {
      const file = makeFile(
        '.cursor/rules/test.mdc',
        '---\ndescription: My rule\nglobs: "src/**/*.ts\nalwaysApply: false\n---\nContent.',
      );
      const issues = await checkFrontmatter(file, '/project');
      const globsIssue = issues.find((i) => i.message.toLowerCase().includes('globs'));
      expect(globsIssue).toBeDefined();
    });
  });

  describe('Copilot instructions', () => {
    it('warns when missing applyTo field', async () => {
      const file = makeFile(
        '.github/instructions/test.md',
        '---\ndescription: test\n---\nContent.',
      );
      const issues = await checkFrontmatter(file, '/project');
      const applyToIssue = issues.find((i) => i.message.includes('applyTo'));
      expect(applyToIssue).toBeDefined();
    });

    it('info when no frontmatter at all', async () => {
      const file = makeFile('.github/instructions/test.md', 'Just content, no frontmatter.');
      const issues = await checkFrontmatter(file, '/project');
      expect(issues.length).toBeGreaterThan(0);
      expect(issues[0].severity).toBe('info');
    });
  });

  describe('Windsurf rules', () => {
    it('errors on invalid trigger value', async () => {
      const file = makeFile('.windsurf/rules/test.md', '---\ntrigger: sometimes\n---\nContent.');
      const issues = await checkFrontmatter(file, '/project');
      const triggerIssue = issues.find((i) => i.severity === 'error');
      expect(triggerIssue).toBeDefined();
      expect(triggerIssue!.message).toContain('trigger');
    });

    it('passes for valid trigger', async () => {
      const file = makeFile('.windsurf/rules/test.md', '---\ntrigger: always_on\n---\nContent.');
      const issues = await checkFrontmatter(file, '/project');
      expect(issues.length).toBe(0);
    });

    it('warns when missing trigger field', async () => {
      const file = makeFile('.windsurf/rules/test.md', '---\nname: test\n---\nContent.');
      const issues = await checkFrontmatter(file, '/project');
      const triggerIssue = issues.find((i) => i.message.includes('trigger'));
      expect(triggerIssue).toBeDefined();
    });
  });

  describe('non-frontmatter files', () => {
    it('skips files that do not require frontmatter', async () => {
      const file = makeFile('CLAUDE.md', '# Project\nSome content.');
      const issues = await checkFrontmatter(file, '/project');
      expect(issues.length).toBe(0);
    });
  });

  describe('unclosed frontmatter', () => {
    it('errors on unclosed .mdc frontmatter (no other frontmatter findings)', async () => {
      // Opening fence present, no closing fence — host treats the file as
      // having no frontmatter at all, so we don't want to also emit
      // "missing description" / "no activation" findings on top of the
      // primary diagnosis.
      const file = makeFile(
        '.cursor/rules/test.mdc',
        '---\ndescription: My rule\nalwaysApply: true\n\nBody text without close.\n',
      );
      const issues = await checkFrontmatter(file, '/project');
      expect(issues.length).toBe(1);
      expect(issues[0].severity).toBe('error');
      expect(issues[0].ruleId).toBe('frontmatter/unclosed');
    });

    it('errors on unclosed Copilot instructions frontmatter', async () => {
      const file = makeFile('.github/instructions/test.md', '---\napplyTo: "**/*.ts"\n\nBody.');
      const issues = await checkFrontmatter(file, '/project');
      expect(issues.length).toBe(1);
      expect(issues[0].ruleId).toBe('frontmatter/unclosed');
    });

    it('errors on unclosed Windsurf rule frontmatter', async () => {
      const file = makeFile('.windsurf/rules/test.md', '---\ntrigger: always_on\n\nBody.');
      const issues = await checkFrontmatter(file, '/project');
      expect(issues.length).toBe(1);
      expect(issues[0].ruleId).toBe('frontmatter/unclosed');
    });

    it('still treats a properly closed frontmatter as found', async () => {
      // Sanity: the unclosed signal must not fire when the close fence is
      // present, even if other validation issues exist.
      const file = makeFile(
        '.cursor/rules/test.mdc',
        '---\ndescription: ok\nalwaysApply: maybe\n---\nBody.',
      );
      const issues = await checkFrontmatter(file, '/project');
      const unclosed = issues.find((i) => i.ruleId === 'frontmatter/unclosed');
      expect(unclosed).toBeUndefined();
      const invalid = issues.find((i) => i.ruleId === 'frontmatter/invalid-value');
      expect(invalid).toBeDefined();
    });
  });
});
