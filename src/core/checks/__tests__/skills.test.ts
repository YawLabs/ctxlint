import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { scanSkillFiles } from '../../skill-scanner.js';
import { checkSkills, type SkillCheckSelection } from '../skills.js';

let homeDir: string;

const ALL: SkillCheckSelection = {
  frontmatter: true,
  brokenRef: true,
  triggerCollision: true,
  orphaned: true,
  deadToolRestriction: true,
};

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-skills-'));
});

afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
});

function writeSkill(name: string, body: string): string {
  const dir = path.join(homeDir, '.claude', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'SKILL.md');
  fs.writeFileSync(p, body);
  return dir;
}

function writeAgent(name: string, body: string): void {
  const dir = path.join(homeDir, '.claude', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), body);
}

function run(sel: SkillCheckSelection = ALL) {
  return checkSkills(scanSkillFiles(homeDir), sel);
}

describe('skill scanner', () => {
  it('discovers skills and agents, and reports orphaned skill dirs', () => {
    writeSkill('good', '---\nname: good\ndescription: does a thing\n---\nbody');
    // orphaned: dir with no SKILL.md
    fs.mkdirSync(path.join(homeDir, '.claude', 'skills', 'empty'), { recursive: true });
    writeAgent('reviewer', '---\nname: reviewer\ndescription: reviews\n---\nbody');
    const ctx = scanSkillFiles(homeDir);
    expect(ctx.files.map((f) => f.name).sort()).toEqual(['good', 'reviewer']);
    expect(ctx.orphanedSkillDirs.map((o) => o.name)).toEqual(['empty']);
  });
});

describe('skill/missing-frontmatter', () => {
  // Claude Code skills: every frontmatter field is optional. `name` defaults
  // to the directory name and a missing `description` falls back to the
  // first non-empty body line (code.claude.com/docs/en/skills). Agents still
  // require both (code.claude.com/docs/en/sub-agents).
  it('reports a SKILL.md with no frontmatter as info, not an error', () => {
    writeSkill('nofm', 'just a body, no frontmatter');
    const fm = run().filter((i) => i.ruleId === 'skill/missing-frontmatter');
    expect(fm).toHaveLength(1);
    expect(fm[0].severity).toBe('info');
    expect(fm[0].suggestion).toContain('first non-empty line');
  });

  it('still errors on an agent with no frontmatter', () => {
    writeAgent('nofm', 'just a body, no frontmatter');
    const fm = run().filter((i) => i.ruleId === 'skill/missing-frontmatter');
    expect(fm).toHaveLength(1);
    expect(fm[0].severity).toBe('error');
  });

  it('does not require name on a skill (it defaults to the directory name)', () => {
    writeSkill('noname', '---\ndescription: does a thing\n---\nbody');
    expect(run().filter((i) => i.ruleId === 'skill/missing-frontmatter')).toEqual([]);
  });

  it('reports a skill without a description as info (recommended, not required)', () => {
    writeSkill('nodesc', '---\nname: nodesc\n---\nbody');
    const fm = run().filter((i) => i.ruleId === 'skill/missing-frontmatter');
    expect(fm).toHaveLength(1);
    expect(fm[0].message).toContain('description');
    expect(fm[0].severity).toBe('info');
    expect(fm[0].suggestion).not.toContain('never selected');
  });

  it('keeps the warning for an agent missing a required field', () => {
    writeAgent('nodesc', '---\nname: nodesc\n---\nbody');
    const fm = run().filter((i) => i.ruleId === 'skill/missing-frontmatter');
    expect(fm).toHaveLength(1);
    expect(fm[0].message).toContain('description');
    expect(fm[0].severity).toBe('warning');
  });

  it('parses CRLF frontmatter', () => {
    writeAgent('crlf', '---\r\nname: crlf\r\ndescription: does a thing\r\n---\r\nbody\r\n');
    expect(run().filter((i) => i.ruleId === 'skill/missing-frontmatter')).toEqual([]);
  });

  it('accepts a block-scalar description', () => {
    writeAgent(
      'block',
      '---\nname: block\ndescription: >-\n  Reviews code\n  for bugs.\n---\nbody',
    );
    expect(run().filter((i) => i.ruleId === 'skill/missing-frontmatter')).toEqual([]);
  });

  it('does not flag a complete skill', () => {
    writeSkill('ok', '---\nname: ok\ndescription: complete\n---\nbody');
    const issues = run({ ...ALL, brokenRef: false });
    expect(issues.filter((i) => i.ruleId === 'skill/missing-frontmatter')).toEqual([]);
  });
});

describe('skill/broken-ref', () => {
  it('flags a relative ref that does not exist', () => {
    writeSkill(
      'refs',
      '---\nname: refs\ndescription: x\n---\nSee ./helpers/missing.md for details.',
    );
    const issues = run({ ...ALL, frontmatter: false });
    const br = issues.filter((i) => i.ruleId === 'skill/broken-ref');
    expect(br).toHaveLength(1);
    expect(br[0].message).toContain('./helpers/missing.md');
  });

  it('does not flag a relative ref that exists', () => {
    const dir = writeSkill('refs2', '---\nname: refs2\ndescription: x\n---\nSee ./notes.md');
    fs.writeFileSync(path.join(dir, 'notes.md'), 'notes');
    const issues = run({ ...ALL, frontmatter: false });
    expect(issues.filter((i) => i.ruleId === 'skill/broken-ref')).toEqual([]);
  });

  it('does not flag bare prose tokens (only ./ and ../)', () => {
    writeSkill(
      'prose',
      '---\nname: prose\ndescription: x\n---\nWe support and/or logic in src/foo handling.',
    );
    const issues = run({ ...ALL, frontmatter: false });
    expect(issues.filter((i) => i.ruleId === 'skill/broken-ref')).toEqual([]);
  });

  it('does not flag a ./script.sh inside a shell code fence', () => {
    writeSkill(
      'shellex',
      '---\nname: shellex\ndescription: x\n---\nRun it:\n\n```bash\n./release.sh 1.2.3\n```\n',
    );
    const issues = run({ ...ALL, frontmatter: false });
    expect(issues.filter((i) => i.ruleId === 'skill/broken-ref')).toEqual([]);
  });

  it('does not resolve command invocations in inline code', () => {
    writeSkill(
      'cmds',
      '---\nname: cmds\ndescription: x\n---\nRun `./gradlew build` from the repo root.\nThen `cd ../other-repo` and run `./gradlew` again.',
    );
    const issues = run({ ...ALL, frontmatter: false });
    expect(issues.filter((i) => i.ruleId === 'skill/broken-ref')).toEqual([]);
  });

  it('still resolves a path-shaped inline-code span', () => {
    writeSkill('spanref', '---\nname: spanref\ndescription: x\n---\nSee `./helpers/missing.md`.');
    const br = run({ ...ALL, frontmatter: false }).filter((i) => i.ruleId === 'skill/broken-ref');
    expect(br).toHaveLength(1);
    expect(br[0].message).toContain('./helpers/missing.md');
  });

  it('recognises ~~~ fences', () => {
    writeSkill('tilde', '---\nname: tilde\ndescription: x\n---\n~~~\n./run.sh 1.2.3\n~~~\n');
    const issues = run({ ...ALL, frontmatter: false });
    expect(issues.filter((i) => i.ruleId === 'skill/broken-ref')).toEqual([]);
  });

  it('does not let a 3-backtick line inside a 4-backtick fence flip fence state', () => {
    writeSkill(
      'nested',
      '---\nname: nested\ndescription: x\n---\n````\n```\n./inside-a.sh\n```\n./inside-b.sh\n````\nSee ./after-fence-missing.md\n',
    );
    const br = run({ ...ALL, frontmatter: false }).filter((i) => i.ruleId === 'skill/broken-ref');
    expect(br.map((i) => i.message)).toEqual([expect.stringContaining('./after-fence-missing.md')]);
  });

  it('reads the language of a fence that opens on the line after another closes', () => {
    // The ts fence must not inherit the text fence's language: its import
    // example is skipped, while the text fence's missing ref is still reported.
    writeSkill(
      'adjacent',
      "---\nname: adjacent\ndescription: x\n---\n```text\n./text-missing.md\n```\n```ts\nimport x from './ts-example.ts';\n```\n",
    );
    const br = run({ ...ALL, frontmatter: false }).filter((i) => i.ruleId === 'skill/broken-ref');
    expect(br.map((i) => i.message)).toEqual([expect.stringContaining('./text-missing.md')]);
  });

  it('scans prose after a fence that opens on the line after another closes', () => {
    writeSkill(
      'adjacent2',
      '---\nname: adjacent2\ndescription: x\n---\n```bash\n./a.sh\n```\n```bash\n./b.sh\n```\nSee ./after-missing.md\n',
    );
    const br = run({ ...ALL, frontmatter: false }).filter((i) => i.ruleId === 'skill/broken-ref');
    expect(br.map((i) => i.message)).toEqual([expect.stringContaining('./after-missing.md')]);
  });

  it('does not flag a ./script.sh inside an unlabeled code fence', () => {
    // A bare ``` fence is the most common way authors paste shell snippets;
    // an invocation example inside one must not resolve against the skill dir.
    writeSkill(
      'barefence',
      '---\nname: barefence\ndescription: x\n---\nRun it:\n\n```\n./run.sh 1.2.3\n```\n',
    );
    const issues = run({ ...ALL, frontmatter: false });
    expect(issues.filter((i) => i.ruleId === 'skill/broken-ref')).toEqual([]);
  });
});

describe('skill/trigger-collision', () => {
  it('flags two skills sharing a quoted trigger phrase', () => {
    writeSkill(
      'a',
      '---\nname: a\ndescription: Use when the user says "ship it" to deploy.\n---\nbody',
    );
    writeSkill('b', '---\nname: b\ndescription: Trigger on "ship it" for releases.\n---\nbody');
    const issues = run({ ...ALL, brokenRef: false, frontmatter: false });
    const tc = issues.filter((i) => i.ruleId === 'skill/trigger-collision');
    expect(tc).toHaveLength(1);
    expect(tc[0].message.toLowerCase()).toContain('ship it');
  });

  it('does not flag unique triggers', () => {
    writeSkill('a', '---\nname: a\ndescription: Use when "deploy prod".\n---\nbody');
    writeSkill('b', '---\nname: b\ndescription: Use when "run tests".\n---\nbody');
    const issues = run({ ...ALL, brokenRef: false, frontmatter: false });
    expect(issues.filter((i) => i.ruleId === 'skill/trigger-collision')).toEqual([]);
  });

  it('does not extract phantom triggers from apostrophes in prose', () => {
    // A naive ["'] class pairs the apostrophes in "user's ... can't" and
    // extracts "s branch can" as a trigger; two skills sharing such
    // boilerplate then collide on a prose fragment.
    writeSkill(
      'a',
      "---\nname: a\ndescription: Use when the user's branch can't merge cleanly.\n---\nbody",
    );
    writeSkill(
      'b',
      "---\nname: b\ndescription: Use when the user's branch can't merge cleanly.\n---\nbody",
    );
    const issues = run({ ...ALL, brokenRef: false, frontmatter: false });
    expect(issues.filter((i) => i.ruleId === 'skill/trigger-collision')).toEqual([]);
  });

  it('still detects single-quoted trigger collisions', () => {
    writeSkill('a', "---\nname: a\ndescription: Use when 'ship it' is requested.\n---\nbody");
    writeSkill('b', "---\nname: b\ndescription: Trigger on 'ship it' for releases.\n---\nbody");
    const issues = run({ ...ALL, brokenRef: false, frontmatter: false });
    const tc = issues.filter((i) => i.ruleId === 'skill/trigger-collision');
    expect(tc).toHaveLength(1);
    expect(tc[0].message.toLowerCase()).toContain('ship it');
  });

  it('unescapes a double-quoted description before extracting triggers', () => {
    // Raw, the escaped quotes produced phantom triggers ("use when the user
    // says \\" and "now.") that collided between any two such skills.
    writeSkill(
      'a',
      '---\nname: a\ndescription: "Use when the user says \\"ship it\\" now."\n---\nbody',
    );
    writeSkill(
      'b',
      '---\nname: b\ndescription: "Use when the user says \\"run tests\\" now."\n---\nbody',
    );
    const issues = run({ ...ALL, brokenRef: false, frontmatter: false });
    expect(issues.filter((i) => i.ruleId === 'skill/trigger-collision')).toEqual([]);
  });

  it('finds single-quoted triggers inside a double-quoted description', () => {
    writeSkill('a', `---\nname: a\ndescription: "Use on 'ship it' to deploy."\n---\nbody`);
    writeSkill('b', `---\nname: b\ndescription: "Trigger on 'ship it' too."\n---\nbody`);
    const tc = run({ ...ALL, brokenRef: false, frontmatter: false }).filter(
      (i) => i.ruleId === 'skill/trigger-collision',
    );
    expect(tc).toHaveLength(1);
    expect(tc[0].message).toContain('"ship it"');
  });

  it('extracts triggers from block-scalar descriptions', () => {
    writeSkill(
      'a',
      '---\nname: a\ndescription: >-\n  Use when the user says\n  "ship it".\n---\nbody',
    );
    writeSkill('b', '---\nname: b\ndescription: |\n  Trigger on "ship it".\n---\nbody');
    const tc = run({ ...ALL, brokenRef: false, frontmatter: false }).filter(
      (i) => i.ruleId === 'skill/trigger-collision',
    );
    expect(tc).toHaveLength(1);
    expect(tc[0].message).toContain('"ship it"');
  });

  it('folds an indented plain-scalar continuation line into the description', () => {
    writeSkill(
      'a',
      '---\nname: a\ndescription: Use when the user says\n  "ship it" to deploy.\n---\nbody',
    );
    writeSkill('b', '---\nname: b\ndescription: Trigger on "ship it".\n---\nbody');
    const tc = run({ ...ALL, brokenRef: false, frontmatter: false }).filter(
      (i) => i.ruleId === 'skill/trigger-collision',
    );
    expect(tc).toHaveLength(1);
  });

  it('does not count a negated quoted phrase as a trigger', () => {
    writeSkill(
      'a',
      '---\nname: a\ndescription: Answers docs questions. Not for "general questions".\n---\nbody',
    );
    writeSkill(
      'b',
      '---\nname: b\ndescription: Do not use for "general questions" either.\n---\nbody',
    );
    const issues = run({ ...ALL, brokenRef: false, frontmatter: false });
    expect(issues.filter((i) => i.ruleId === 'skill/trigger-collision')).toEqual([]);
  });

  it('reads CRLF descriptions', () => {
    writeSkill('a', '---\r\nname: a\r\ndescription: Use on "ship it".\r\n---\r\nbody');
    writeSkill('b', '---\r\nname: b\r\ndescription: Trigger on "ship it".\r\n---\r\nbody');
    const tc = run({ ...ALL, brokenRef: false, frontmatter: false }).filter(
      (i) => i.ruleId === 'skill/trigger-collision',
    );
    expect(tc).toHaveLength(1);
  });

  it('extracts a double-quoted trigger that follows a contraction', () => {
    // The naive class paired the contraction's apostrophe with the opening
    // double quote ('s wrong. Use on ") and swallowed the real trigger.
    writeSkill(
      'a',
      '---\nname: a\ndescription: Reviews what\'s wrong. Use on "review my changes".\n---\nbody',
    );
    writeSkill('b', '---\nname: b\ndescription: Use on "review my changes" please.\n---\nbody');
    const issues = run({ ...ALL, brokenRef: false, frontmatter: false });
    const tc = issues.filter((i) => i.ruleId === 'skill/trigger-collision');
    expect(tc).toHaveLength(1);
    expect(tc[0].message).toContain('review my changes');
  });
});

describe('skill/orphaned', () => {
  it('flags a skill dir with no SKILL.md', () => {
    fs.mkdirSync(path.join(homeDir, '.claude', 'skills', 'ghost'), { recursive: true });
    const issues = run();
    const orphan = issues.filter((i) => i.ruleId === 'skill/orphaned');
    expect(orphan).toHaveLength(1);
    expect(orphan[0].message).toContain('ghost');
  });
});

describe('skill/dead-tool-restriction', () => {
  it('flags an agent restricting to an unknown tool', () => {
    writeAgent('r', '---\nname: r\ndescription: x\ntools: Read, Frobnicate, Bash\n---\nbody');
    const issues = run({ ...ALL, frontmatter: false });
    const dead = issues.filter((i) => i.ruleId === 'skill/dead-tool-restriction');
    expect(dead).toHaveLength(1);
    expect(dead[0].message).toContain('Frobnicate');
    // A PascalCase unknown may be a built-in newer than KNOWN_TOOLS (the
    // list drifts stale across CC versions), so it reports as info.
    expect(dead[0].severity).toBe('info');
  });

  it('keeps warning severity for non-PascalCase unknown tools (likely typos)', () => {
    writeAgent('r3', '---\nname: r3\ndescription: x\ntools: bash, Web_Fetch\n---\nbody');
    const issues = run({ ...ALL, frontmatter: false });
    const dead = issues.filter((i) => i.ruleId === 'skill/dead-tool-restriction');
    expect(dead).toHaveLength(2);
    for (const d of dead) expect(d.severity).toBe('warning');
  });

  it('accepts current built-ins like AskUserQuestion and StructuredOutput', () => {
    writeAgent(
      'r4',
      '---\nname: r4\ndescription: x\ntools: AskUserQuestion, StructuredOutput, ToolSearch\n---\nbody',
    );
    const issues = run({ ...ALL, frontmatter: false });
    expect(issues.filter((i) => i.ruleId === 'skill/dead-tool-restriction')).toEqual([]);
  });

  it('does not flag known tools or MCP-namespaced tools', () => {
    writeAgent(
      'r2',
      '---\nname: r2\ndescription: x\ntools: Read, Bash, mcp__github__search\n---\nbody',
    );
    const issues = run({ ...ALL, frontmatter: false });
    expect(issues.filter((i) => i.ruleId === 'skill/dead-tool-restriction')).toEqual([]);
  });

  it('ignores a `tools:` key on a skill (skills restrict via allowed-tools)', () => {
    writeSkill('s', '---\nname: s\ndescription: x\ntools: Frobnicate\n---\nbody');
    const issues = run({ ...ALL, frontmatter: false, brokenRef: false });
    expect(issues.filter((i) => i.ruleId === 'skill/dead-tool-restriction')).toEqual([]);
  });

  it("checks a skill's allowed-tools (space- or comma-separated)", () => {
    writeSkill(
      's2',
      '---\nname: s2\ndescription: x\nallowed-tools: Read Grep Bash(git add *) Frobnicate\n---\nbody',
    );
    const dead = run({ ...ALL, frontmatter: false, brokenRef: false }).filter(
      (i) => i.ruleId === 'skill/dead-tool-restriction',
    );
    expect(dead).toHaveLength(1);
    expect(dead[0].message).toContain('"Frobnicate"');
  });

  it("does not check an agent's allowed-tools key (agents use tools / disallowedTools)", () => {
    writeAgent('r5', '---\nname: r5\ndescription: x\nallowed-tools: Frobnicate\n---\nbody');
    const issues = run({ ...ALL, frontmatter: false });
    expect(issues.filter((i) => i.ruleId === 'skill/dead-tool-restriction')).toEqual([]);
  });

  it("checks an agent's disallowedTools", () => {
    writeAgent(
      'r6',
      '---\nname: r6\ndescription: x\ndisallowedTools: Write, Frobnicate\n---\nbody',
    );
    const dead = run({ ...ALL, frontmatter: false }).filter(
      (i) => i.ruleId === 'skill/dead-tool-restriction',
    );
    expect(dead).toHaveLength(1);
    expect(dead[0].message).toContain('"Frobnicate"');
  });

  it('handles quoted values, trailing comments and commas inside parentheses', () => {
    writeAgent('q1', '---\nname: q1\ndescription: x\ntools: "Read, Grep, Glob"\n---\nbody');
    writeAgent('q2', '---\nname: q2\ndescription: x\ntools: Read, Grep # read-only\n---\nbody');
    writeAgent(
      'q3',
      '---\nname: q3\ndescription: x\ntools: Bash(git add, git commit), Read\n---\nbody',
    );
    const issues = run({ ...ALL, frontmatter: false });
    expect(issues.filter((i) => i.ruleId === 'skill/dead-tool-restriction')).toEqual([]);
  });

  it('accepts current built-ins from the tools reference', () => {
    writeAgent(
      'r7',
      '---\nname: r7\ndescription: x\ntools: LS, NotebookRead, TaskOutput, EnterPlanMode, Monitor, PowerShell, LSP\n---\nbody',
    );
    const issues = run({ ...ALL, frontmatter: false });
    expect(issues.filter((i) => i.ruleId === 'skill/dead-tool-restriction')).toEqual([]);
  });

  it('suggests the matching built-in for a case typo instead of printing every tool', () => {
    writeAgent('r8', '---\nname: r8\ndescription: x\ntools: webfetch\n---\nbody');
    const dead = run({ ...ALL, frontmatter: false }).filter(
      (i) => i.ruleId === 'skill/dead-tool-restriction',
    );
    expect(dead).toHaveLength(1);
    expect(dead[0].suggestion).toContain('Did you mean "WebFetch"?');
    expect(dead[0].suggestion).not.toContain('AskUserQuestion');
  });
});

describe('selection gating', () => {
  it('runs nothing when no checks are selected', () => {
    writeSkill('x', 'no frontmatter at all');
    const issues = checkSkills(scanSkillFiles(homeDir), {
      frontmatter: false,
      brokenRef: false,
      triggerCollision: false,
      orphaned: false,
      deadToolRestriction: false,
    });
    expect(issues).toEqual([]);
  });
});
