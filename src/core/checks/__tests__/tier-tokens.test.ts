import { describe, it, expect } from 'vitest';
import { checkTierTokens } from '../tier-tokens.js';
import type { ParsedContextFile, Section } from '../../types.js';

function makeFile(overrides: Partial<ParsedContextFile> = {}): ParsedContextFile {
  return {
    filePath: '/test/CLAUDE.md',
    relativePath: 'CLAUDE.md',
    isSymlink: false,
    totalTokens: 2000,
    totalLines: 100,
    content: '',
    sections: [],
    references: { paths: [], commands: [] },
    ...overrides,
  };
}

function buildContent(sections: { title: string; level: number; body: string }[]): {
  content: string;
  sections: Section[];
} {
  const lines: string[] = [];
  const parsed: Section[] = [];
  for (const s of sections) {
    const headingLine = lines.length + 1;
    lines.push(`${'#'.repeat(s.level)} ${s.title}`);
    const bodyLines = s.body.split('\n');
    lines.push(...bodyLines);
    parsed.push({
      title: s.title,
      startLine: headingLine,
      endLine: lines.length,
      level: s.level,
    });
  }
  // Fix endLine chaining so each section closes where the next begins (minus 1)
  for (let i = 0; i < parsed.length - 1; i++) {
    parsed[i].endLine = parsed[i + 1].startLine - 1;
  }
  return { content: lines.join('\n'), sections: parsed };
}

describe('checkTierTokens', () => {
  it('skips files below the threshold', async () => {
    const { content, sections } = buildContent([{ title: 'Small', level: 2, body: 'short' }]);
    const issues = await checkTierTokens(makeFile({ content, sections, totalTokens: 300 }));
    expect(issues).toHaveLength(0);
  });

  it('skips path-scoped rules files (on-demand tier)', async () => {
    const { content, sections } = buildContent([
      { title: 'Large', level: 2, body: 'x '.repeat(3000) },
    ]);
    const issues = await checkTierTokens(
      makeFile({
        relativePath: '.claude/rules/some-rule.md',
        content,
        sections,
        totalTokens: 2000,
      }),
    );
    expect(issues).toHaveLength(0);
  });

  it('skips files outside the always-loaded basename list', async () => {
    const { content, sections } = buildContent([
      { title: 'Large', level: 2, body: 'x '.repeat(3000) },
    ]);
    const issues = await checkTierTokens(
      makeFile({
        relativePath: 'random.md',
        content,
        sections,
        totalTokens: 2000,
      }),
    );
    expect(issues).toHaveLength(0);
  });

  it('reports the heaviest H2 section for a bloated CLAUDE.md', async () => {
    const { content, sections } = buildContent([
      { title: 'Intro', level: 2, body: 'short intro' },
      {
        title: 'Heavy section',
        level: 2,
        body: 'word '.repeat(500),
      },
      { title: 'Outro', level: 2, body: 'short outro' },
    ]);
    const issues = await checkTierTokens(makeFile({ content, sections, totalTokens: 2000 }));
    expect(issues).toHaveLength(1);
    const [issue] = issues;
    expect(issue.severity).toBe('info');
    expect(issue.check).toBe('tier-tokens');
    expect(issue.ruleId).toBe('tier-tokens/section-breakdown');
    expect(issue.suggestion).toContain('Heavy section');
    expect(issue.detail).toContain('Heavy section');
    // Heavy section is listed first in detail (sorted by tokens desc)
    const heavyIdx = issue.detail!.indexOf('Heavy section');
    const introIdx = issue.detail!.indexOf('Intro');
    expect(heavyIdx).toBeLessThan(introIdx);
  });

  it('falls back to H1 sections when no H2 exists', async () => {
    const { content, sections } = buildContent([
      { title: 'Top', level: 1, body: 'body ' + 'x '.repeat(500) },
    ]);
    const issues = await checkTierTokens(makeFile({ content, sections, totalTokens: 1500 }));
    expect(issues).toHaveLength(1);
    expect(issues[0].suggestion).toContain('Top');
  });

  it('emits nothing when an always-loaded file has no sections', async () => {
    const issues = await checkTierTokens(
      makeFile({ content: 'flat text, no headings', sections: [], totalTokens: 2000 }),
    );
    expect(issues).toHaveLength(0);
  });

  it('recognizes AGENTS.md as always-loaded', async () => {
    const { content, sections } = buildContent([
      { title: 'A', level: 2, body: 'word '.repeat(500) },
    ]);
    const issues = await checkTierTokens(
      makeFile({
        relativePath: 'AGENTS.md',
        content,
        sections,
        totalTokens: 1500,
      }),
    );
    expect(issues).toHaveLength(1);
  });
});
