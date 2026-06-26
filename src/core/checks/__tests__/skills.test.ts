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
  it('flags a SKILL.md with no frontmatter', () => {
    writeSkill('nofm', 'just a body, no frontmatter');
    const issues = run();
    expect(
      issues.some((i) => i.ruleId === 'skill/missing-frontmatter' && i.severity === 'error'),
    ).toBe(true);
  });

  it('flags a missing description field', () => {
    writeSkill('nodesc', '---\nname: nodesc\n---\nbody');
    const issues = run();
    const fm = issues.filter((i) => i.ruleId === 'skill/missing-frontmatter');
    expect(fm).toHaveLength(1);
    expect(fm[0].message).toContain('description');
    expect(fm[0].severity).toBe('warning');
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

  it('does not apply the tool check to skills (only agents)', () => {
    writeSkill('s', '---\nname: s\ndescription: x\ntools: Frobnicate\n---\nbody');
    const issues = run({ ...ALL, frontmatter: false, brokenRef: false });
    expect(issues.filter((i) => i.ruleId === 'skill/dead-tool-restriction')).toEqual([]);
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
