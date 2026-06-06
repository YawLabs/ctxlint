import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  checkTierTokens,
  checkAggregateTierTokens,
  isAlwaysLoaded,
  resetSettingsCache,
} from '../tier-tokens.js';
import type { ParsedContextFile, Section } from '../../types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-tier-'));
  resetSettingsCache();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  resetSettingsCache();
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

  it('matches .junie/guidelines.md but not docs/api/guidelines.md', () => {
    expect(isAlwaysLoaded(makeFile({ relativePath: '.junie/guidelines.md' }))).toBe(true);
    expect(isAlwaysLoaded(makeFile({ relativePath: 'docs/api/guidelines.md' }))).toBe(false);
    expect(isAlwaysLoaded(makeFile({ relativePath: 'guidelines.md' }))).toBe(false);
  });

  it('matches .goose/instructions.md but not docs/api/instructions.md', () => {
    expect(isAlwaysLoaded(makeFile({ relativePath: '.goose/instructions.md' }))).toBe(true);
    expect(isAlwaysLoaded(makeFile({ relativePath: 'docs/api/instructions.md' }))).toBe(false);
    expect(isAlwaysLoaded(makeFile({ relativePath: 'instructions.md' }))).toBe(false);
  });

  it('matches .github/copilot-instructions.md', () => {
    expect(isAlwaysLoaded(makeFile({ relativePath: '.github/copilot-instructions.md' }))).toBe(
      true,
    );
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

  it('ignores user-global ~/.claude/settings.json unless includeGlobal is set', async () => {
    // Only a PERSONAL global settings.json denies the command; the project has none.
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-home-'));
    fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(fakeHome, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { deny: ['Bash(npm login)'] } }),
    );
    const origHome = process.env.HOME;
    const origProfile = process.env.USERPROFILE;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    try {
      const content = '# CLAUDE.md\n\nNEVER run `npm login` locally.\n';
      const file = () => makeFile({ content, sections: [], totalTokens: 50 });

      // Default run (includeGlobal=false): personal global deny is NOT consulted,
      // so the finding still fires — it can't be suppressed by another machine's
      // private settings.
      resetSettingsCache();
      const without = await checkTierTokens(file(), tmpDir);
      expect(
        without.find((i) => i.ruleId === 'tier-tokens/hard-enforcement-missing'),
      ).toBeDefined();

      // Opt-in (includeGlobal=true): the global deny is consulted and suppresses it.
      resetSettingsCache();
      const withGlobal = await checkTierTokens(file(), tmpDir, undefined, true);
      expect(
        withGlobal.find((i) => i.ruleId === 'tier-tokens/hard-enforcement-missing'),
      ).toBeUndefined();
    } finally {
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
      if (origProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = origProfile;
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('skips when a hyphenated PreToolUse hook script name matches the command', async () => {
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
    // `npm login` (rule's canonical form) should match the hyphenated script
    // name `block-npm-login.sh`. The matcher allows `[\s\-_]+` between command
    // tokens precisely to bridge the CLI-form ↔ script-name-form gap.
    expect(issues.find((i) => i.ruleId === 'tier-tokens/hard-enforcement-missing')).toBeUndefined();
  });

  it('skips when an underscored PreToolUse hook script name matches the command', async () => {
    const dotClaude = path.join(tmpDir, '.claude');
    fs.mkdirSync(dotClaude, { recursive: true });
    fs.writeFileSync(
      path.join(dotClaude, 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'block_npm_login.py' }] }],
        },
      }),
    );
    const content = '# CLAUDE.md\n\nNEVER run `npm login` locally.\n';
    const issues = await checkTierTokens(
      makeFile({ content, sections: [], totalTokens: 50 }),
      tmpDir,
    );
    expect(issues.find((i) => i.ruleId === 'tier-tokens/hard-enforcement-missing')).toBeUndefined();
  });

  it('still flags when no hook genuinely protects the command', async () => {
    const dotClaude = path.join(tmpDir, '.claude');
    fs.mkdirSync(dotClaude, { recursive: true });
    fs.writeFileSync(
      path.join(dotClaude, 'settings.json'),
      JSON.stringify({
        hooks: {
          // A hook that protects an unrelated command — should NOT bypass
          // the rule for `npm login`.
          PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'block-git-push.sh' }] }],
        },
      }),
    );
    const content = '# CLAUDE.md\n\nNEVER run `npm login` locally.\n';
    const issues = await checkTierTokens(
      makeFile({ content, sections: [], totalTokens: 50 }),
      tmpDir,
    );
    const hard = issues.find((i) => i.ruleId === 'tier-tokens/hard-enforcement-missing');
    expect(hard).toBeDefined();
    expect(hard!.suggestion).toContain('npm login');
  });

  it('does not match an unrelated command that shares a single token (npm vs pnpm)', async () => {
    const dotClaude = path.join(tmpDir, '.claude');
    fs.mkdirSync(dotClaude, { recursive: true });
    fs.writeFileSync(
      path.join(dotClaude, 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'block-pnpm-login.sh' }] }],
        },
      }),
    );
    const content = '# CLAUDE.md\n\nNEVER run `npm login` locally.\n';
    const issues = await checkTierTokens(
      makeFile({ content, sections: [], totalTokens: 50 }),
      tmpDir,
    );
    // `\bnpm` requires a word boundary before `npm`; `pnpm` has none, so the
    // rule should still fire — the hook protects pnpm, not npm.
    const hard = issues.find((i) => i.ruleId === 'tier-tokens/hard-enforcement-missing');
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

  it('warns only ONCE for a malformed settings.json across many always-loaded files', async () => {
    const dotClaude = path.join(tmpDir, '.claude');
    fs.mkdirSync(dotClaude, { recursive: true });
    // Trailing comma — JSON.parse throws.
    fs.writeFileSync(
      path.join(dotClaude, 'settings.json'),
      '{ "permissions": { "deny": ["Bash(npm login)"], } }',
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Simulate the audit calling checkTierTokens once per always-loaded file.
      const content = '# CLAUDE.md\n\nNEVER run `npm login` locally.\n';
      for (let i = 0; i < 4; i++) {
        await checkTierTokens(makeFile({ content, sections: [], totalTokens: 50 }), tmpDir);
      }
      const parseWarns = warnSpy.mock.calls.filter((c) => String(c[0]).includes('could not parse'));
      expect(parseWarns).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
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
