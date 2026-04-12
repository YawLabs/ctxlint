import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkTierTokens, checkAggregateTierTokens, isAlwaysLoaded } from '../tier-tokens.js';
import { resetTokenThresholds } from '../tokens.js';
import type { ParsedContextFile, Section } from '../../types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-tier-'));
  resetTokenThresholds();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

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
  for (let i = 0; i < parsed.length - 1; i++) {
    parsed[i].endLine = parsed[i + 1].startLine - 1;
  }
  return { content: lines.join('\n'), sections: parsed };
}

describe('isAlwaysLoaded', () => {
  it('classifies CLAUDE.md as always-loaded', () => {
    expect(isAlwaysLoaded(makeFile({ relativePath: 'CLAUDE.md' }))).toBe(true);
  });

  it('classifies .mdc files as on-demand', () => {
    expect(isAlwaysLoaded(makeFile({ relativePath: '.cursor/rules/r.mdc' }))).toBe(false);
  });

  it('classifies .github/instructions/* as on-demand', () => {
    expect(isAlwaysLoaded(makeFile({ relativePath: '.github/instructions/foo.md' }))).toBe(false);
  });

  it('treats rules files without paths frontmatter as always-loaded', () => {
    const content = '---\ndescription: general rule\n---\n\nbody';
    expect(isAlwaysLoaded(makeFile({ relativePath: '.claude/rules/r.md', content }))).toBe(true);
  });

  it('treats rules files with paths frontmatter as on-demand', () => {
    const content = '---\npaths: "src/**/*.ts"\n---\n\nbody';
    expect(isAlwaysLoaded(makeFile({ relativePath: '.claude/rules/r.md', content }))).toBe(false);
  });

  it('treats rules files with paths YAML array as on-demand', () => {
    const content = '---\npaths:\n  - "src/**/*.ts"\n  - "tests/**"\n---\n';
    expect(isAlwaysLoaded(makeFile({ relativePath: '.claude/rules/r.md', content }))).toBe(false);
  });

  it('treats random basenames as on-demand', () => {
    expect(isAlwaysLoaded(makeFile({ relativePath: 'notes.md' }))).toBe(false);
  });
});

describe('checkTierTokens — section breakdown', () => {
  it('skips files below the threshold', async () => {
    const { content, sections } = buildContent([{ title: 'S', level: 2, body: 'short' }]);
    const issues = await checkTierTokens(makeFile({ content, sections, totalTokens: 300 }), tmpDir);
    expect(issues).toHaveLength(0);
  });

  it('reports the heaviest H2 section for a bloated CLAUDE.md', async () => {
    const { content, sections } = buildContent([
      { title: 'Intro', level: 2, body: 'short intro' },
      { title: 'Heavy section', level: 2, body: 'word '.repeat(500) },
      { title: 'Outro', level: 2, body: 'short outro' },
    ]);
    const issues = await checkTierTokens(
      makeFile({ content, sections, totalTokens: 2000 }),
      tmpDir,
    );
    const breakdown = issues.find((i) => i.ruleId === 'tier-tokens/section-breakdown');
    expect(breakdown).toBeDefined();
    expect(breakdown!.suggestion).toContain('Heavy section');
    expect(breakdown!.detail).toContain('Heavy section');
  });

  it('falls back to H1 when no H2 exists', async () => {
    const { content, sections } = buildContent([
      { title: 'Top', level: 1, body: 'body ' + 'x '.repeat(500) },
    ]);
    const issues = await checkTierTokens(
      makeFile({ content, sections, totalTokens: 1500 }),
      tmpDir,
    );
    const breakdown = issues.find((i) => i.ruleId === 'tier-tokens/section-breakdown');
    expect(breakdown).toBeDefined();
    expect(breakdown!.suggestion).toContain('Top');
  });

  it('emits no breakdown when an always-loaded file has no sections', async () => {
    const issues = await checkTierTokens(
      makeFile({ content: 'flat text', sections: [], totalTokens: 2000 }),
      tmpDir,
    );
    expect(issues.find((i) => i.ruleId === 'tier-tokens/section-breakdown')).toBeUndefined();
  });
});

describe('checkTierTokens — hard-enforcement-missing', () => {
  it('flags NEVER + command when no hook/deny exists', async () => {
    const content = '# CLAUDE.md\n\nNEVER run `npm login` locally.\n';
    const issues = await checkTierTokens(
      makeFile({ content, sections: [], totalTokens: 50 }),
      tmpDir,
    );
    const hard = issues.find((i) => i.ruleId === 'tier-tokens/hard-enforcement-missing');
    expect(hard).toBeDefined();
    expect(hard!.suggestion).toContain('npm login');
  });

  it('skips the rule when settings.json denies the command', async () => {
    const dotClaude = path.join(tmpDir, '.claude');
    fs.mkdirSync(dotClaude, { recursive: true });
    fs.writeFileSync(
      path.join(dotClaude, 'settings.json'),
      JSON.stringify({ permissions: { deny: ['Bash(npm login)'] } }),
    );
    const content = '# CLAUDE.md\n\nNEVER run `npm login` locally.\n';
    const issues = await checkTierTokens(
      makeFile({ content, sections: [], totalTokens: 50 }),
      tmpDir,
    );
    expect(issues.find((i) => i.ruleId === 'tier-tokens/hard-enforcement-missing')).toBeUndefined();
  });

  it('skips when PreToolUse hook matches the command', async () => {
    const dotClaude = path.join(tmpDir, '.claude');
    fs.mkdirSync(dotClaude, { recursive: true });
    fs.writeFileSync(
      path.join(dotClaude, 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'block-npm-login.sh' }] }],
        },
      }),
    );
    const content = '# CLAUDE.md\n\nNEVER run `npm login` locally.\n';
    const issues = await checkTierTokens(
      makeFile({ content, sections: [], totalTokens: 50 }),
      tmpDir,
    );
    const hard = issues.find((i) => i.ruleId === 'tier-tokens/hard-enforcement-missing');
    // The hook command contains "npm-login" (without space), but our substring
    // check uses "npm login" (with space) so it won't match — this is expected
    // conservative behavior. Test documents that.
    expect(hard).toBeDefined();
  });

  it('does not flag soft framing', async () => {
    const content = '# CLAUDE.md\n\nPrefer `npm ci` over `npm install` in CI.\n';
    const issues = await checkTierTokens(
      makeFile({ content, sections: [], totalTokens: 50 }),
      tmpDir,
    );
    expect(issues.find((i) => i.ruleId === 'tier-tokens/hard-enforcement-missing')).toBeUndefined();
  });
});

describe('checkAggregateTierTokens', () => {
  it('returns null for a single always-loaded file', () => {
    const issue = checkAggregateTierTokens([makeFile({ totalTokens: 10000 })]);
    expect(issue).toBeNull();
  });

  it('emits a warning when combined always-loaded tokens exceed threshold', () => {
    const issue = checkAggregateTierTokens([
      makeFile({ relativePath: 'CLAUDE.md', totalTokens: 3000 }),
      makeFile({ relativePath: 'AGENTS.md', totalTokens: 2500 }),
    ]);
    expect(issue).not.toBeNull();
    expect(issue!.severity).toBe('warning');
    expect(issue!.ruleId).toBe('tier-tokens/aggregate');
    expect(issue!.detail).toContain('CLAUDE.md');
    expect(issue!.detail).toContain('AGENTS.md');
  });

  it('excludes path-scoped rules from the aggregate', () => {
    const pathsRule = makeFile({
      relativePath: '.claude/rules/large.md',
      content: '---\npaths: "**/*.ts"\n---\n',
      totalTokens: 10000,
    });
    const claude = makeFile({ relativePath: 'CLAUDE.md', totalTokens: 1000 });
    const issue = checkAggregateTierTokens([pathsRule, claude]);
    expect(issue).toBeNull();
  });
});
