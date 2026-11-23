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

  it('treats Windsurf glob-trigger rules as on-demand', () => {
    const content = '---\ntrigger: glob\nglobs: "**/*.ts"\n---\n\nbody';
    expect(isAlwaysLoaded(makeFile({ relativePath: '.windsurf/rules/r.md', content }))).toBe(false);
  });

  it('treats Windsurf manual-trigger rules (no globs) as on-demand', () => {
    const content = '---\ntrigger: manual\n---\n\nbody';
    expect(isAlwaysLoaded(makeFile({ relativePath: '.windsurf/rules/r.md', content }))).toBe(false);
  });

  it('treats Windsurf always_on rules as always-loaded', () => {
    const content = '---\ntrigger: always_on\n---\n\nbody';
    expect(isAlwaysLoaded(makeFile({ relativePath: '.windsurf/rules/r.md', content }))).toBe(true);
  });

  it('treats Cursor .md rules with globs frontmatter as on-demand', () => {
    const content = '---\nglobs: "src/**/*.ts"\n---\n\nbody';
    expect(isAlwaysLoaded(makeFile({ relativePath: '.cursor/rules/r.md', content }))).toBe(false);
  });

  it('treats Cursor .md rules without scoping frontmatter as always-loaded', () => {
    const content = '---\ndescription: general rule\n---\n\nbody';
    expect(isAlwaysLoaded(makeFile({ relativePath: '.cursor/rules/r.md', content }))).toBe(true);
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

  // Cursor .mdc rules are path-scoped by default, but `alwaysApply: true`
  // attaches them to every request.
  it('treats a Cursor .mdc rule with alwaysApply: true as always-loaded', () => {
    const content = '---\ndescription: house style\nalwaysApply: true\n---\n\nbody';
    expect(isAlwaysLoaded(makeFile({ relativePath: '.cursor/rules/r.mdc', content }))).toBe(true);
  });

  it('treats a Cursor .mdc rule with alwaysApply: false as on-demand', () => {
    const content = '---\nalwaysApply: false\nglobs: "**/*.ts"\n---\n\nbody';
    expect(isAlwaysLoaded(makeFile({ relativePath: '.cursor/rules/r.mdc', content }))).toBe(false);
  });

  it('does not treat an arbitrary rules/ directory as an agent rules dir', () => {
    expect(isAlwaysLoaded(makeFile({ relativePath: 'docs/rules/naming.md' }))).toBe(false);
    expect(isAlwaysLoaded(makeFile({ relativePath: 'src/lint/rules/no-any.md' }))).toBe(false);
  });

  // An indented `---` is YAML content, not the closing fence (the rule
  // frontmatter.ts applies), so the `paths:` below it is still frontmatter.
  it('does not close frontmatter on an indented ---', () => {
    const content = '---\ndescription: |\n  ---\npaths: "src/**"\n---\n\nbody';
    expect(isAlwaysLoaded(makeFile({ relativePath: '.claude/rules/r.md', content }))).toBe(false);
  });

  it('reads a scalar field past an indented --- (alwaysApply / trigger)', () => {
    const mdc = '---\ndescription: |\n  ---\nalwaysApply: true\n---\n\nbody';
    expect(isAlwaysLoaded(makeFile({ relativePath: '.cursor/rules/r.mdc', content: mdc }))).toBe(
      true,
    );
    const ws = '---\ndescription: |\n  ---\ntrigger: manual\n---\n\nbody';
    expect(isAlwaysLoaded(makeFile({ relativePath: '.windsurf/rules/r.md', content: ws }))).toBe(
      false,
    );
  });

  it('closes frontmatter on a --- with trailing whitespace', () => {
    const content = '---\ndescription: x\n---  \npaths: "src/**"\n\nbody';
    expect(isAlwaysLoaded(makeFile({ relativePath: '.claude/rules/r.md', content }))).toBe(true);
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

  it('keeps H1 as the top level when a file organised by H1 has one stray H2', async () => {
    const { content, sections } = buildContent([
      { title: 'Setup', level: 1, body: 'word '.repeat(300) },
      { title: 'Stray', level: 2, body: 'short' },
      { title: 'Testing', level: 1, body: 'word '.repeat(200) },
      { title: 'Release', level: 1, body: 'word '.repeat(100) },
    ]);
    const issues = await checkTierTokens(
      makeFile({ content, sections, totalTokens: 2000 }),
      tmpDir,
    );
    const breakdown = issues.find((i) => i.ruleId === 'tier-tokens/section-breakdown');
    expect(breakdown).toBeDefined();
    expect(breakdown!.detail).toContain('Setup');
    expect(breakdown!.detail).toContain('Testing');
    expect(breakdown!.detail).not.toContain('Stray');
  });

  it('uses H2 under a single H1 title', async () => {
    const { content, sections } = buildContent([
      { title: 'Project', level: 1, body: 'intro' },
      { title: 'Heavy', level: 2, body: 'word '.repeat(400) },
      { title: 'Light', level: 2, body: 'short' },
    ]);
    const issues = await checkTierTokens(
      makeFile({ content, sections, totalTokens: 2000 }),
      tmpDir,
    );
    const breakdown = issues.find((i) => i.ruleId === 'tier-tokens/section-breakdown');
    expect(breakdown!.suggestion).toContain('Heavy');
    expect(breakdown!.detail).not.toContain('Project');
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
    // The pattern's `(?<![A-Za-z0-9])` lookbehind rejects a letter before
    // `npm`, so `pnpm` does not match and the rule still fires — the hook
    // protects pnpm, not npm.
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

  // A directive can only be written in PROSE. A fenced block SHOWING the
  // reader what such a rule looks like is an illustration, and reporting it as
  // this repo's own unenforced policy is a pure false positive. The reference
  // extractors already track fences; this check scans raw content, so it has
  // to as well.
  it('does not flag inviolable framing inside a fenced code block', async () => {
    const content =
      '# CLAUDE.md\n\nExample of a rule you might write:\n\n```markdown\nNEVER run `terraform apply` without review.\n```\n\nThat is only an illustration.\n';
    const issues = await checkTierTokens(
      makeFile({ content, sections: [], totalTokens: 50 }),
      tmpDir,
    );
    expect(issues.find((i) => i.ruleId === 'tier-tokens/hard-enforcement-missing')).toBeUndefined();
  });

  // Regression pair for the comment mask. Both of these lost a REAL finding
  // before the mask learned to (a) ignore comment markers inside code spans
  // and (b) treat a self-contained comment as an annotation rather than as
  // grounds for discarding the whole line.
  it('still flags a rule after a line that merely mentions `<!--` in a code span', async () => {
    const content =
      '# CLAUDE.md\n\nUse `<!--` to start an HTML comment.\n\nNEVER run `terraform apply` without review.\n';
    const issues = await checkTierTokens(
      makeFile({ content, sections: [], totalTokens: 50 }),
      tmpDir,
    );
    expect(issues.find((i) => i.ruleId === 'tier-tokens/hard-enforcement-missing')).toBeDefined();
  });

  it('still flags a rule carrying a trailing self-contained HTML comment', async () => {
    const content =
      '# CLAUDE.md\n\nNEVER run `terraform apply` without review. <!-- reviewed 2026-08 -->\n';
    const issues = await checkTierTokens(
      makeFile({ content, sections: [], totalTokens: 50 }),
      tmpDir,
    );
    expect(issues.find((i) => i.ruleId === 'tier-tokens/hard-enforcement-missing')).toBeDefined();
  });

  // ...but the comment's OWN text must not be read as an instruction.
  it('does not flag framing that exists only inside a self-contained comment', async () => {
    const content = '# CLAUDE.md\n\nBuild notes. <!-- NEVER run `terraform apply` -->\n';
    const issues = await checkTierTokens(
      makeFile({ content, sections: [], totalTokens: 50 }),
      tmpDir,
    );
    expect(issues.find((i) => i.ruleId === 'tier-tokens/hard-enforcement-missing')).toBeUndefined();
  });

  // The split case: framing in PROSE but the only backticked command inside a
  // comment. Blanking the comment removes the span, so findInviolableCommand
  // finds no command to name and stays silent rather than reaching past it to
  // an unrelated span. Currently an accidental interaction of two functions;
  // pinned so it stays deliberate.
  it('does not flag prose framing whose only command sits inside a comment', async () => {
    const content = '# CLAUDE.md\n\nNEVER run <!-- `terraform apply` --> in prod.\n';
    const issues = await checkTierTokens(
      makeFile({ content, sections: [], totalTokens: 50 }),
      tmpDir,
    );
    expect(issues.find((i) => i.ruleId === 'tier-tokens/hard-enforcement-missing')).toBeUndefined();
  });

  it('does not flag inviolable framing inside an HTML comment', async () => {
    const content =
      '# CLAUDE.md\n\n<!--\nNEVER run `terraform apply` without review.\n-->\n\nNothing to enforce here.\n';
    const issues = await checkTierTokens(
      makeFile({ content, sections: [], totalTokens: 50 }),
      tmpDir,
    );
    expect(issues.find((i) => i.ruleId === 'tier-tokens/hard-enforcement-missing')).toBeUndefined();
  });

  // Control for the two above: the same sentence as prose still fires, so the
  // fence/comment mask is what suppressed them and not a broken matcher.
  it('still flags the same sentence when it is prose, not fenced', async () => {
    const content = '# CLAUDE.md\n\nNEVER run `terraform apply` without review.\n';
    const issues = await checkTierTokens(
      makeFile({ content, sections: [], totalTokens: 50 }),
      tmpDir,
    );
    const hard = issues.find((i) => i.ruleId === 'tier-tokens/hard-enforcement-missing');
    expect(hard).toBeDefined();
    expect(hard!.suggestion).toContain('terraform apply');
  });

  // A prose directive that FOLLOWS a closed fence must still fire -- the mask
  // has to toggle off, not latch.
  it('flags prose after a closed fence (mask toggles off)', async () => {
    const content = '# CLAUDE.md\n\n```bash\nnpm ci\n```\n\nNEVER run `npm login` locally.\n';
    const issues = await checkTierTokens(
      makeFile({ content, sections: [], totalTokens: 50 }),
      tmpDir,
    );
    expect(issues.find((i) => i.ruleId === 'tier-tokens/hard-enforcement-missing')).toBeDefined();
  });

  it('treats a permissions.ask entry as enforcement (human prompt is a hard gate)', async () => {
    const dotClaude = path.join(tmpDir, '.claude');
    fs.mkdirSync(dotClaude, { recursive: true });
    fs.writeFileSync(
      path.join(dotClaude, 'settings.json'),
      JSON.stringify({ permissions: { ask: ['Bash(npm login)'] } }),
    );
    const content = '# CLAUDE.md\n\nNEVER run `npm login` locally.\n';
    const issues = await checkTierTokens(
      makeFile({ content, sections: [], totalTokens: 50 }),
      tmpDir,
    );
    expect(issues.find((i) => i.ruleId === 'tier-tokens/hard-enforcement-missing')).toBeUndefined();
  });

  it('credits a Stop hook as enforcement (the shape the ALWAYS suggestion offers)', async () => {
    // The ALWAYS-branch suggestion says "add a PreToolUse or Stop hook" —
    // adding exactly that Stop hook must suppress the finding, otherwise
    // following the suggestion leaves it firing forever.
    const dotClaude = path.join(tmpDir, '.claude');
    fs.mkdirSync(dotClaude, { recursive: true });
    fs.writeFileSync(
      path.join(dotClaude, 'settings.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'npm test' }] }] } }),
    );
    const content = '# CLAUDE.md\n\nALWAYS run `npm test` before declaring done.\n';
    const issues = await checkTierTokens(
      makeFile({ content, sections: [], totalTokens: 50 }),
      tmpDir,
    );
    expect(issues.find((i) => i.ruleId === 'tier-tokens/hard-enforcement-missing')).toBeUndefined();
  });

  it('suggests an enforcing hook (not a deny/block) for ALWAYS-framed rules', async () => {
    const content = '# CLAUDE.md\n\nALWAYS run `npm test` before pushing.\n';
    const issues = await checkTierTokens(
      makeFile({ content, sections: [], totalTokens: 50 }),
      tmpDir,
    );
    const hard = issues.find((i) => i.ruleId === 'tier-tokens/hard-enforcement-missing');
    expect(hard).toBeDefined();
    expect(hard!.suggestion).toContain('npm test');
    // "Block the command" is inverted polarity for an ALWAYS rule — the fix
    // is a hook that runs/verifies it, not one that denies it.
    expect(hard!.suggestion).not.toContain('physically blocked');
  });

  it('reads a settings.json with a trailing comma (same leniency as hook-coverage)', async () => {
    const dotClaude = path.join(tmpDir, '.claude');
    fs.mkdirSync(dotClaude, { recursive: true });
    // jsonc with allowTrailingComma — the identical file hook-coverage can
    // read must not be treated as absent here.
    fs.writeFileSync(
      path.join(dotClaude, 'settings.json'),
      '{ "permissions": { "deny": ["Bash(npm login)"], } }',
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const content = '# CLAUDE.md\n\nNEVER run `npm login` locally.\n';
      const issues = await checkTierTokens(
        makeFile({ content, sections: [], totalTokens: 50 }),
        tmpDir,
      );
      expect(
        issues.find((i) => i.ruleId === 'tier-tokens/hard-enforcement-missing'),
      ).toBeUndefined();
      const parseWarns = warnSpy.mock.calls.filter((c) => String(c[0]).includes('could not parse'));
      expect(parseWarns).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('picks up a settings.json edit between runs without a manual cache reset', async () => {
    const content = '# CLAUDE.md\n\nNEVER run `npm login` locally.\n';
    // First run: no settings — the finding fires (and the empty state is cached).
    const first = await checkTierTokens(
      makeFile({ content, sections: [], totalTokens: 50 }),
      tmpDir,
    );
    expect(first.find((i) => i.ruleId === 'tier-tokens/hard-enforcement-missing')).toBeDefined();

    // The user adds the suggested deny entry and re-audits in the SAME
    // process (MCP server / --watch shape) with NO resetSettingsCache().
    const dotClaude = path.join(tmpDir, '.claude');
    fs.mkdirSync(dotClaude, { recursive: true });
    fs.writeFileSync(
      path.join(dotClaude, 'settings.json'),
      JSON.stringify({ permissions: { deny: ['Bash(npm login)'] } }),
    );
    const second = await checkTierTokens(
      makeFile({ content, sections: [], totalTokens: 50 }),
      tmpDir,
    );
    expect(second.find((i) => i.ruleId === 'tier-tokens/hard-enforcement-missing')).toBeUndefined();
  });

  it('warns only ONCE for a malformed settings.json across many always-loaded files', async () => {
    const dotClaude = path.join(tmpDir, '.claude');
    fs.mkdirSync(dotClaude, { recursive: true });
    // Genuinely malformed (unterminated) — even the lenient jsonc parse errors.
    fs.writeFileSync(
      path.join(dotClaude, 'settings.json'),
      '{ "permissions": { "deny": ["Bash(npm login)"',
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

  // --- Factual/mapping-prose regressions (each string observed verbatim in a
  // real repo's always-loaded files, where the rule misfired). ---

  it('does not fire on lowercase temporal "always" in a factual mapping line', async () => {
    // "the specs have always lived in `e2e/`" is descriptive prose; the old
    // case-insensitive scan read the adverb as inviolable framing and
    // nominated the DIRECTORY `e2e/` for hook enforcement.
    const content =
      '# CLAUDE.md\n\n' +
      '  - **`e2e.yml`** (Playwright) → the Phase-1 GUI test suite in `e2e/` + ' +
      '`scripts/run-gui-tests-local.sh`. Run from a non-Yaw shell only (per ' +
      '`feedback_no_e2e_from_inside_yaw.md`) -- the runner hard-refuses otherwise, detecting ' +
      'the `YAW_VERSION` env var that a packaged yaw exports into every PTY shell. (There is ' +
      'no `tests/gui/` directory; the specs have always lived in `e2e/`.)\n';
    const issues = await checkTierTokens(
      makeFile({ content, sections: [], totalTokens: 50 }),
      tmpDir,
    );
    expect(issues.find((i) => i.ruleId === 'tier-tokens/hard-enforcement-missing')).toBeUndefined();
  });

  it('does not fire on a hyphenated compound ("the always-on summary")', async () => {
    const content =
      '# CLAUDE.md\n\n' +
      "Yaw Mode's default is ASCII output to the user's terminal. When `terminal-output.md` " +
      'is loaded it expands the rationale and the full substitution table; this section is ' +
      'the always-on summary so the discipline survives a session-limit downshift (which ' +
      'drops `terminal-output.md` from the overlay).\n';
    const issues = await checkTierTokens(
      makeFile({ content, sections: [], totalTokens: 50 }),
      tmpDir,
    );
    expect(issues.find((i) => i.ruleId === 'tier-tokens/hard-enforcement-missing')).toBeUndefined();
  });

  it('does not fire on a framing word inside an inline code span', async () => {
    // "always" here lives INSIDE `applies-when.always === true`. The old
    // single-regex scan matched it and then captured the PROSE between that
    // code span and the next one as "the command".
    const content =
      '# CLAUDE.md\n\n' +
      'At overlay-build time `combineClaudeMd` (src/yaw-mode.ts) reads `rules/manifest.json` ' +
      'and filters this list down to the rules whose `applies-when.always === true` -- plus ' +
      "the active overlay profile's force-load set -- those load every turn, injected on " +
      'demand by the `rule-trigger-load.js` UserPromptSubmit hook\n';
    const issues = await checkTierTokens(
      makeFile({ content, sections: [], totalTokens: 50 }),
      tmpDir,
    );
    expect(issues.find((i) => i.ruleId === 'tier-tokens/hard-enforcement-missing')).toBeUndefined();
  });

  it('does not treat an UPPERCASE framing word inside a code span as framing', async () => {
    // Pins the code-span masking on its own: the token is uppercase (so the
    // case gate alone would not stop it) but sits inside backticks.
    const content =
      '# CLAUDE.md\n\nThe `applies-when.ALWAYS` key gates loading of `manifest.json` entries.\n';
    const issues = await checkTierTokens(
      makeFile({ content, sections: [], totalTokens: 50 }),
      tmpDir,
    );
    expect(issues.find((i) => i.ruleId === 'tier-tokens/hard-enforcement-missing')).toBeUndefined();
  });

  it('still fires on a capitalized "Never" bullet (genuine inviolable rule)', async () => {
    const content =
      '# CLAUDE.md\n\n' +
      '- Never calling `process.kill()` on Windows ConPTY shells (write `\\x03\\nexit\\r\\n`)\n';
    const issues = await checkTierTokens(
      makeFile({ content, sections: [], totalTokens: 50 }),
      tmpDir,
    );
    const hard = issues.find((i) => i.ruleId === 'tier-tokens/hard-enforcement-missing');
    expect(hard).toBeDefined();
    expect(hard!.suggestion).toContain('process.kill()');
  });

  it('still fires on sentence-initial "Always use" (directive, not prose)', async () => {
    const content = '# CLAUDE.md\n\nAlways use `./deploy.sh` to ship.\n';
    const issues = await checkTierTokens(
      makeFile({ content, sections: [], totalTokens: 50 }),
      tmpDir,
    );
    const hard = issues.find((i) => i.ruleId === 'tier-tokens/hard-enforcement-missing');
    expect(hard).toBeDefined();
    expect(hard!.suggestion).toContain('./deploy.sh');
    // ALWAYS polarity: suggest a hook that runs/verifies, not a deny.
    expect(hard!.suggestion).not.toContain('physically blocked');
  });

  it('still fires on emphasized mixed-case framing ("must NOT")', async () => {
    const content =
      '# CLAUDE.md\n\nThe release flow must NOT invoke `npm publish` from a laptop.\n';
    const issues = await checkTierTokens(
      makeFile({ content, sections: [], totalTokens: 50 }),
      tmpDir,
    );
    const hard = issues.find((i) => i.ruleId === 'tier-tokens/hard-enforcement-missing');
    expect(hard).toBeDefined();
    expect(hard!.suggestion).toContain('npm publish');
  });

  it('does not manufacture "do ... not" framing across a masked code span', async () => {
    // Masking `x` with spaces would turn "do `x` not" into "do     not" and
    // match `do\s+not`; the non-space filler prevents that.
    const content = '# CLAUDE.md\n\nWhat you do `x` not withstanding, run `npm test` often.\n';
    const issues = await checkTierTokens(
      makeFile({ content, sections: [], totalTokens: 50 }),
      tmpDir,
    );
    expect(issues.find((i) => i.ruleId === 'tier-tokens/hard-enforcement-missing')).toBeUndefined();
  });
});

describe('checkTierTokens — hard-enforcement-missing: what the span is and what enforces it', () => {
  const hardFor = async (content: string) =>
    (await checkTierTokens(makeFile({ content, sections: [], totalTokens: 50 }), tmpDir)).find(
      (i) => i.ruleId === 'tier-tokens/hard-enforcement-missing',
    );

  function writeSettings(settings: object): void {
    const dotClaude = path.join(tmpDir, '.claude');
    fs.mkdirSync(dotClaude, { recursive: true });
    fs.writeFileSync(path.join(dotClaude, 'settings.json'), JSON.stringify(settings));
  }

  it('does not call an identifier a command', async () => {
    const hard = await hardFor('# CLAUDE.md\n\nNever use `any` in TypeScript code.\n');
    expect(hard).toBeDefined();
    expect(hard!.suggestion).not.toContain('physically blocked');
    expect(hard!.suggestion).not.toContain('command');
    expect(hard!.suggestion).toContain('Edit');
  });

  it('suggests a file-scoped deny for a file name', async () => {
    const hard = await hardFor('# CLAUDE.md\n\nDo NOT edit `package-lock.json` by hand.\n');
    expect(hard).toBeDefined();
    expect(hard!.suggestion).not.toContain('command');
    expect(hard!.suggestion).toContain('Edit(package-lock.json)');
  });

  it('credits a permissions.deny Edit(...) entry for a file rule', async () => {
    writeSettings({ permissions: { deny: ['Edit(package-lock.json)'] } });
    expect(
      await hardFor('# CLAUDE.md\n\nDo NOT edit `package-lock.json` by hand.\n'),
    ).toBeUndefined();
  });

  it('keeps the prohibited flag in the suggestion', async () => {
    const hard = await hardFor('# CLAUDE.md\n\nNEVER run `git push --force` on main.\n');
    expect(hard).toBeDefined();
    expect(hard!.suggestion).toContain('`git push --force`');
  });

  it('credits a deny on the flagged form', async () => {
    writeSettings({ permissions: { deny: ['Bash(git push --force:*)'] } });
    expect(await hardFor('# CLAUDE.md\n\nNEVER run `git push --force` on main.\n')).toBeUndefined();
  });

  // A deny on plain `git push` blocks `git push --force` too: broader enforces narrower.
  it('credits a broader deny for a flagged rule', async () => {
    writeSettings({ permissions: { deny: ['Bash(git push:*)'] } });
    expect(await hardFor('# CLAUDE.md\n\nNEVER run `git push --force` on main.\n')).toBeUndefined();
  });

  // ...but a deny on `git push --force` leaves plain `git push` runnable.
  it('does not credit a narrower deny for a broader rule', async () => {
    writeSettings({ permissions: { deny: ['Bash(git push --force:*)'] } });
    expect(await hardFor('# CLAUDE.md\n\nNEVER run `git push` from CI.\n')).toBeDefined();
  });

  it('does not credit a deny on a different flag', async () => {
    writeSettings({ permissions: { deny: ['Bash(git push --tags:*)'] } });
    expect(await hardFor('# CLAUDE.md\n\nNEVER run `git push --force` on main.\n')).toBeDefined();
  });

  // A tool-name matcher says which tool the hook sees, not which command it blocks.
  it('does not credit a Bash matcher as enforcing the bash command', async () => {
    writeSettings({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'audit-log.sh' }] }] },
    });
    expect(await hardFor('# CLAUDE.md\n\nNEVER use `bash -c` for scripts.\n')).toBeDefined();
  });

  it('credits a case-exact tool-name matcher for a tool-name rule', async () => {
    writeSettings({
      hooks: { PreToolUse: [{ matcher: 'WebFetch|WebSearch', hooks: [{ command: 'deny.sh' }] }] },
    });
    expect(await hardFor('# CLAUDE.md\n\nNEVER use `WebFetch` here.\n')).toBeUndefined();
  });

  it('does not credit a tool-name matcher that differs in case', async () => {
    writeSettings({
      hooks: { PreToolUse: [{ matcher: 'webfetch', hooks: [{ command: 'deny.sh' }] }] },
    });
    expect(await hardFor('# CLAUDE.md\n\nNEVER use `WebFetch` here.\n')).toBeDefined();
  });

  it('credits a generic hook script whose contents block the command', async () => {
    const hooks = path.join(tmpDir, '.claude', 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(
      path.join(hooks, 'bash-guard.sh'),
      '#!/bin/sh\ncase "$CMD" in\n  *"npm login"*) exit 2 ;;\nesac\n',
    );
    writeSettings({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/bash-guard.sh' }],
          },
        ],
      },
    });
    expect(await hardFor('# CLAUDE.md\n\nNEVER run `npm login` locally.\n')).toBeUndefined();
  });

  it('does not credit a generic hook script that never mentions the command', async () => {
    const hooks = path.join(tmpDir, '.claude', 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(path.join(hooks, 'bash-guard.sh'), '#!/bin/sh\nexit 0\n');
    writeSettings({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'bash .claude/hooks/bash-guard.sh' }] }],
      },
    });
    expect(await hardFor('# CLAUDE.md\n\nNEVER run `npm login` locally.\n')).toBeDefined();
  });

  // `bash` here is the interpreter that runs the hook, not a command it blocks.
  it('does not credit the interpreter that launches a hook script', async () => {
    writeSettings({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'bash .claude/hooks/missing.sh' }] }],
      },
    });
    expect(await hardFor('# CLAUDE.md\n\nNEVER use `bash -c` for scripts.\n')).toBeDefined();
  });

  // A formatter hook that cleans up with `rm -f` neither sees Bash calls nor
  // blocks `rm -rf`: using a command is not enforcing a ban on it.
  it('does not credit a non-Bash hook script that merely uses the command', async () => {
    const hooks = path.join(tmpDir, '.claude', 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(
      path.join(hooks, 'fmt.sh'),
      '#!/bin/sh\nTMP=$(mktemp)\nnpx prettier --write "$FILE"\nrm -f "$TMP"\n',
    );
    writeSettings({
      hooks: {
        PreToolUse: [{ matcher: 'Edit|Write', hooks: [{ command: 'bash .claude/hooks/fmt.sh' }] }],
      },
    });
    expect(await hardFor('# CLAUDE.md\n\nNEVER run `rm -rf /`.\n')).toBeDefined();
  });

  it('does not credit a Bash hook script that uses the bare head without the banned flags', async () => {
    const hooks = path.join(tmpDir, '.claude', 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(path.join(hooks, 'log.sh'), '#!/bin/sh\nrm -f "$LOG.tmp"\nexit 0\n');
    writeSettings({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'bash .claude/hooks/log.sh' }] }],
      },
    });
    expect(await hardFor('# CLAUDE.md\n\nNEVER run `rm -rf /`.\n')).toBeDefined();
  });

  it('credits a Bash hook script that names the command with its banned flags', async () => {
    const hooks = path.join(tmpDir, '.claude', 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(
      path.join(hooks, 'guard.sh'),
      '#!/bin/sh\ncase "$CMD" in\n  *"rm -rf"*) exit 2 ;;\nesac\n',
    );
    writeSettings({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'bash .claude/hooks/guard.sh' }] }],
      },
    });
    expect(await hardFor('# CLAUDE.md\n\nNEVER run `rm -rf /`.\n')).toBeUndefined();
  });

  // A one-word span outside COMMAND_HEADS is still a command when the rule says "run".
  it('credits a Bash deny for a single-word command not in the known heads', async () => {
    writeSettings({ permissions: { deny: ['Bash(pytest:*)'] } });
    expect(await hardFor('# CLAUDE.md\n\nNEVER run `pytest`.\n')).toBeUndefined();
  });

  it('credits an exact Bash deny for the identical single-word command', async () => {
    writeSettings({ permissions: { deny: ['Bash(vitest)'] } });
    expect(await hardFor('# CLAUDE.md\n\nNEVER run `vitest`.\n')).toBeUndefined();
  });

  it('suggests blocking the command for "run `<word>`"', async () => {
    const hard = await hardFor('# CLAUDE.md\n\nNEVER run `pytest`.\n');
    expect(hard).toBeDefined();
    expect(hard!.suggestion).toContain('physically blocked');
    expect(hard!.suggestion).not.toContain('Edit|Write');
  });

  // An exact entry (no `:*` / ` *`) blocks that exact command only.
  it('does not credit an exact deny for the same command with extra flags', async () => {
    writeSettings({ permissions: { deny: ['Bash(git push)'] } });
    expect(await hardFor('# CLAUDE.md\n\nNEVER run `git push --force` on main.\n')).toBeDefined();
  });

  it('credits an exact deny for the identical command', async () => {
    writeSettings({ permissions: { deny: ['Bash(npm publish)'] } });
    expect(await hardFor('# CLAUDE.md\n\nNEVER run `npm publish` locally.\n')).toBeUndefined();
  });

  // A dotted identifier is code, not a file: no `Edit(console.log)` suggestion.
  it.each(['console.log', 'JSON.parse', 'process.env', 'np.sum', '_.sum'])(
    'classifies the dotted identifier `%s` as code',
    async (span) => {
      const hard = await hardFor(`# CLAUDE.md\n\nNever use \`${span}\` in production code.\n`);
      expect(hard).toBeDefined();
      expect(hard!.suggestion).not.toContain(`Edit(${span})`);
      expect(hard!.suggestion).not.toContain('file cannot be changed');
      expect(hard!.suggestion).toContain('rejects edits introducing it');
    },
  );

  it.each(['.env', '.env.local', 'app.log', 'src/generated', 'tsconfig.json'])(
    'still classifies `%s` as a file',
    async (span) => {
      const hard = await hardFor(`# CLAUDE.md\n\nDo NOT edit \`${span}\` by hand.\n`);
      expect(hard).toBeDefined();
      expect(hard!.suggestion).toContain(`Edit(${span})`);
    },
  );

  // Lockfiles and manifests whose extension is not a common source type.
  it.each(['go.sum', 'go.mod', 'bun.lockb', 'Gemfile.lock', 'App.csproj'])(
    'classifies the lockfile/manifest `%s` as a file and credits Edit(%s)',
    async (span) => {
      const hard = await hardFor(`# CLAUDE.md\n\nDo NOT edit \`${span}\` by hand.\n`);
      expect(hard).toBeDefined();
      expect(hard!.suggestion).toContain(`Edit(${span})`);
      writeSettings({ permissions: { deny: [`Edit(${span})`] } });
      expect(await hardFor(`# CLAUDE.md\n\nDo NOT edit \`${span}\` by hand.\n`)).toBeUndefined();
    },
  );

  it('credits an Edit(...) deny for a dotted span with an unlisted extension', async () => {
    writeSettings({ permissions: { deny: ['Edit(schema.prisma2)'] } });
    expect(await hardFor('# CLAUDE.md\n\nNever edit `schema.prisma2` by hand.\n')).toBeUndefined();
  });

  function writeHookScript(name: string, body: string, matcher: string, event = 'PreToolUse') {
    const hooks = path.join(tmpDir, '.claude', 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(path.join(hooks, name), body);
    writeSettings({
      hooks: { [event]: [{ matcher, hooks: [{ command: `bash .claude/hooks/${name}` }] }] },
    });
  }

  // `any` inside "company" is not a mention of `any`.
  it('does not credit a code span found only inside a longer word', async () => {
    writeHookScript('guard.sh', '#!/bin/sh\n# company policy\ngrep -q "as unknown" "$F"\n', '');
    expect(await hardFor('# CLAUDE.md\n\nNever use `any` in TypeScript code.\n')).toBeDefined();
  });

  it('does not credit a Bash-only hook that names the code span', async () => {
    writeHookScript('guard.sh', '#!/bin/sh\ngrep -q ": any" "$F" && exit 2\n', 'Bash');
    expect(await hardFor('# CLAUDE.md\n\nNever use `any` in TypeScript code.\n')).toBeDefined();
  });

  it('credits an Edit|Write hook that names the code span as a word', async () => {
    writeHookScript('guard.sh', '#!/bin/sh\ngrep -q ": any" "$F" && exit 2\n', 'Edit|Write');
    expect(await hardFor('# CLAUDE.md\n\nNever use `any` in TypeScript code.\n')).toBeUndefined();
  });

  it('credits a Stop hook (no matcher) that names the code span', async () => {
    writeHookScript('check.sh', '#!/bin/sh\ngrep -rq "console.log" src && exit 2\n', '', 'Stop');
    expect(
      await hardFor('# CLAUDE.md\n\nNever use `console.log` in production code.\n'),
    ).toBeUndefined();
  });

  it('does not credit a Bash-only hook that names the file span', async () => {
    writeHookScript('guard.sh', '#!/bin/sh\necho package-lock.json\n', 'Bash');
    expect(
      await hardFor('# CLAUDE.md\n\nDo NOT edit `package-lock.json` by hand.\n'),
    ).toBeDefined();
  });

  it('credits an Edit hook that names the file span', async () => {
    writeHookScript(
      'guard.sh',
      '#!/bin/sh\ncase "$F" in *package-lock.json) exit 2;; esac\n',
      'Edit',
    );
    expect(
      await hardFor('# CLAUDE.md\n\nDo NOT edit `package-lock.json` by hand.\n'),
    ).toBeUndefined();
  });

  it('matches a curly-apostrophe "Don’t"', async () => {
    const hard = await hardFor('# CLAUDE.md\n\nDon’t run `npm login` locally.\n');
    expect(hard).toBeDefined();
  });

  it('does not treat "e.g." as a sentence boundary', async () => {
    const hard = await hardFor(
      '# CLAUDE.md\n\nNEVER run a destructive command, e.g. `rm -rf /`.\n',
    );
    expect(hard).toBeDefined();
    expect(hard!.suggestion).toContain('rm -rf /');
  });

  it('still treats a real sentence end as a boundary', async () => {
    expect(await hardFor('# CLAUDE.md\n\nNEVER guess. Run `npm test` first.\n')).toBeUndefined();
  });

  it('quotes the directive, not the whole line, in the message', async () => {
    const hard = await hardFor(
      '# CLAUDE.md\n\nPREAMBLE_MARKER context that runs on for a while, but NEVER run `npm login` ' +
        'locally, TRAILING_MARKER because the long tail of this sentence is irrelevant.\n',
    );
    expect(hard).toBeDefined();
    expect(hard!.message).toContain('NEVER run `npm login`');
    expect(hard!.message).not.toContain('PREAMBLE_MARKER');
    expect(hard!.message).not.toContain('TRAILING_MARKER');
  });

  it('caps a very long command in the message', async () => {
    const long = 'curl ' + 'x'.repeat(200);
    const hard = await hardFor(`# CLAUDE.md\n\nNEVER run \`${long}\`.\n`);
    expect(hard).toBeDefined();
    expect(hard!.message.length).toBeLessThan(160);
  });
});

describe('checkAggregateTierTokens', () => {
  it('returns null for a single always-loaded file', () => {
    const issue = checkAggregateTierTokens([makeFile({ totalTokens: 10000 })]);
    expect(issue).toBeNull();
  });

  it("emits a warning when one tool's always-loaded files together exceed threshold", () => {
    const issue = checkAggregateTierTokens([
      makeFile({ relativePath: 'CLAUDE.md', totalTokens: 3000 }),
      makeFile({ relativePath: '.claude/rules/style.md', totalTokens: 2500 }),
    ]);
    expect(issue).not.toBeNull();
    expect(issue!.severity).toBe('warning');
    expect(issue!.ruleId).toBe('tier-tokens/aggregate');
    expect(issue!.message).toContain('Claude Code');
    expect(issue!.message).toContain('5,500');
    expect(issue!.detail).toContain('CLAUDE.md');
    expect(issue!.detail).toContain('.claude/rules/style.md');
  });

  // No session loads CLAUDE.md, AGENTS.md, GEMINI.md and .cursorrules
  // together: each tool reads its own file, so the totals are per tool.
  it('does not sum files that different tools load', () => {
    const issue = checkAggregateTierTokens([
      makeFile({ relativePath: 'CLAUDE.md', totalTokens: 3000 }),
      makeFile({ relativePath: 'AGENTS.md', totalTokens: 2500 }),
      makeFile({ relativePath: 'GEMINI.md', totalTokens: 2500 }),
      makeFile({ relativePath: '.cursorrules', totalTokens: 2500 }),
    ]);
    expect(issue).toBeNull();
  });

  // Subdirectory CLAUDE.md files load on demand (when Claude works in that
  // subtree), so a monorepo's packages/*/CLAUDE.md is not every-session cost.
  it('counts only root-level always-loaded files', () => {
    const issue = checkAggregateTierTokens([
      makeFile({ relativePath: 'CLAUDE.md', totalTokens: 1500 }),
      makeFile({ relativePath: 'packages/a/CLAUDE.md', totalTokens: 2000 }),
      makeFile({ relativePath: 'packages/b/CLAUDE.md', totalTokens: 2000 }),
    ]);
    expect(issue).toBeNull();
  });

  it('skips a symlink whose target is another counted file', () => {
    const issue = checkAggregateTierTokens([
      makeFile({ relativePath: 'CLAUDE.md', totalTokens: 3000 }),
      makeFile({
        relativePath: 'CLAUDE.local.md',
        totalTokens: 3000,
        isSymlink: true,
        symlinkTarget: 'CLAUDE.md',
      }),
    ]);
    expect(issue).toBeNull();
  });

  it('reports the heaviest tool when several exceed the threshold', () => {
    const issue = checkAggregateTierTokens([
      makeFile({ relativePath: 'CLAUDE.md', totalTokens: 3000 }),
      makeFile({ relativePath: 'CLAUDE.local.md', totalTokens: 2000 }),
      makeFile({ relativePath: '.windsurfrules', totalTokens: 4000 }),
      makeFile({ relativePath: '.windsurf/rules/r.md', totalTokens: 3000 }),
    ]);
    expect(issue).not.toBeNull();
    expect(issue!.message).toContain('Windsurf');
    expect(issue!.message).toContain('7,000');
    expect(issue!.detail).not.toContain('CLAUDE.md');
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

describe('CRLF line endings', () => {
  // Windows checkouts with core.autocrlf=true hand the check CRLF content.
  // Each case is the byte-for-byte CRLF twin of an LF case above. Rows 0, 2
  // and 3 and the paths-scoped hard-enforcement case failed before the CRLF
  // fix (`.` does not match the trailing `\r`, so the field value never
  // matched); rows 1, 4 and 5 and the CLAUDE.md case passed already and stay
  // as parity checks.
  const crlf = (s: string) => s.replace(/\n/g, '\r\n');

  it.each([
    ['.claude/rules/r.md', '---\npaths: "src/**/*.ts"\n---\n\nbody'],
    ['.claude/rules/r.md', '---\npaths:\n  - "src/**/*.ts"\n  - "tests/**"\n---\n'],
    ['.cursor/rules/r.md', '---\nglobs: "src/**/*.ts"\n---\n\nbody'],
    ['.windsurf/rules/r.md', '---\ntrigger: manual\n---\n\nbody'],
    ['.windsurf/rules/r.md', '---\ntrigger: always_on\n---\n\nbody'],
    ['.claude/rules/r.md', '---\ndescription: general rule\n---\n\nbody'],
  ])('classifies CRLF %s identically to its LF twin (%#)', (relativePath, lf) => {
    const lfResult = isAlwaysLoaded(makeFile({ relativePath, content: lf }));
    const crlfResult = isAlwaysLoaded(makeFile({ relativePath, content: crlf(lf) }));
    expect(crlfResult).toBe(lfResult);
  });

  it('does not flag hard-enforcement-missing on a CRLF paths-scoped rule', async () => {
    const lf = '---\npaths: "src/**"\n---\n\nNEVER run `npm login` locally.\n';
    const lfIssues = await checkTierTokens(
      makeFile({ relativePath: '.claude/rules/r.md', content: lf, totalTokens: 50 }),
      tmpDir,
    );
    const crlfIssues = await checkTierTokens(
      makeFile({ relativePath: '.claude/rules/r.md', content: crlf(lf), totalTokens: 50 }),
      tmpDir,
    );
    expect(lfIssues).toEqual([]);
    expect(crlfIssues).toEqual(lfIssues);
  });

  it('reports identical hard-enforcement-missing issues for CRLF and LF CLAUDE.md', async () => {
    const lf =
      '# CLAUDE.md\n\nNEVER run `npm login` locally.\n\n```bash\nNEVER run `npm publish`\n```\n';
    const lfIssues = await checkTierTokens(makeFile({ content: lf, totalTokens: 50 }), tmpDir);
    const crlfIssues = await checkTierTokens(
      makeFile({ content: crlf(lf), totalTokens: 50 }),
      tmpDir,
    );
    expect(lfIssues).toHaveLength(1);
    expect(crlfIssues).toEqual(lfIssues);
  });
});
