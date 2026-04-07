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
});
