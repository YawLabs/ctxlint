import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { scanSkillFiles } from '../skill-scanner.js';

let homeDir: string;
let outsideDir: string;

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-sklscan-'));
  outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-sklscan-real-'));
});

afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
  fs.rmSync(outsideDir, { recursive: true, force: true });
});

// Dir links use type 'junction': Windows junctions need no privileges (plain
// dir symlinks require Developer Mode or elevation); POSIX ignores the type
// argument and creates a regular symlink. File symlinks DO need privileges on
// Windows, so those cases probe capability and skip when creation is denied.
const canLinkDirs = (() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-lnkprobe-'));
  try {
    const target = path.join(base, 't');
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(base, 'l'), 'junction');
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
})();

const canLinkFiles = (() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-lnkprobe-'));
  try {
    const target = path.join(base, 't.md');
    fs.writeFileSync(target, 'x');
    fs.symlinkSync(target, path.join(base, 'l.md'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
})();

function mkSkillsRoot(): string {
  const skillsRoot = path.join(homeDir, '.claude', 'skills');
  fs.mkdirSync(skillsRoot, { recursive: true });
  return skillsRoot;
}

describe('scanSkillFiles symlinked entries', () => {
  it.skipIf(!canLinkDirs)('discovers a skill whose dir is a symlink into skills/', () => {
    const realSkill = path.join(outsideDir, 'dotfiles-skill');
    fs.mkdirSync(realSkill);
    fs.writeFileSync(
      path.join(realSkill, 'SKILL.md'),
      '---\nname: linked\ndescription: d\n---\nbody',
    );
    fs.symlinkSync(realSkill, path.join(mkSkillsRoot(), 'linked'), 'junction');

    const ctx = scanSkillFiles(homeDir);

    expect(ctx.files.map((f) => f.name)).toContain('linked');
    expect(ctx.orphanedSkillDirs).toEqual([]);
  });

  it.skipIf(!canLinkDirs)('reports a symlinked skill dir with no SKILL.md as orphaned', () => {
    const realDir = path.join(outsideDir, 'empty-skill');
    fs.mkdirSync(realDir);
    fs.symlinkSync(realDir, path.join(mkSkillsRoot(), 'empty-linked'), 'junction');

    const ctx = scanSkillFiles(homeDir);

    expect(ctx.orphanedSkillDirs.map((o) => o.name)).toContain('empty-linked');
  });

  it.skipIf(!canLinkFiles)('discovers an agent .md that is a symlink into agents/', () => {
    const realAgent = path.join(outsideDir, 'reviewer.md');
    fs.writeFileSync(realAgent, '---\nname: reviewer\ndescription: d\n---\nbody');
    const agentsRoot = path.join(homeDir, '.claude', 'agents');
    fs.mkdirSync(agentsRoot, { recursive: true });
    fs.symlinkSync(realAgent, path.join(agentsRoot, 'reviewer.md'), 'file');

    const ctx = scanSkillFiles(homeDir);

    const agent = ctx.files.find((f) => f.kind === 'agent' && f.name === 'reviewer');
    expect(agent).toBeDefined();
    expect(agent?.content).toContain('name: reviewer');
  });

  it.skipIf(!canLinkDirs)('ignores broken links without throwing', () => {
    const skillsRoot = mkSkillsRoot();
    const realDir = path.join(outsideDir, 'vanishing');
    fs.mkdirSync(realDir);
    fs.symlinkSync(realDir, path.join(skillsRoot, 'dangling'), 'junction');
    fs.rmdirSync(realDir); // leaves the link dangling

    const ctx = scanSkillFiles(homeDir);

    expect(ctx.files.map((f) => f.name)).not.toContain('dangling');
    expect(ctx.orphanedSkillDirs.map((o) => o.name)).not.toContain('dangling');
  });

  it('still discovers plain (non-symlinked) skills and agents', () => {
    const skillDir = path.join(mkSkillsRoot(), 'plain');
    fs.mkdirSync(skillDir);
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: plain\ndescription: d\n---\nb');
    const agentsRoot = path.join(homeDir, '.claude', 'agents');
    fs.mkdirSync(agentsRoot, { recursive: true });
    fs.writeFileSync(path.join(agentsRoot, 'helper.md'), '---\nname: helper\n---\nb');

    const ctx = scanSkillFiles(homeDir);

    expect(ctx.files.map((f) => f.name).sort()).toEqual(['helper', 'plain']);
  });
});

describe('scanSkillFiles config-dir resolution', () => {
  const KEYS = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR'] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('scans CLAUDE_CONFIG_DIR, not ~/.claude, when the override is set', () => {
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    const configDir = path.join(outsideDir, 'custom-claude');
    process.env.CLAUDE_CONFIG_DIR = configDir;
    fs.mkdirSync(path.join(configDir, 'skills', 'over'), { recursive: true });
    fs.writeFileSync(path.join(configDir, 'skills', 'over', 'SKILL.md'), '---\nname: over\n---\nb');
    // A decoy under ~/.claude that must NOT be picked up.
    fs.mkdirSync(path.join(homeDir, '.claude', 'skills', 'decoy'), { recursive: true });
    fs.writeFileSync(path.join(homeDir, '.claude', 'skills', 'decoy', 'SKILL.md'), 'x');

    const ctx = scanSkillFiles();

    expect(ctx.files.map((f) => f.name)).toEqual(['over']);
    // The display path names the directory actually scanned.
    expect(ctx.files[0].displayPath).toBe(`${configDir.replace(/\\/g, '/')}/skills/over/SKILL.md`);
  });

  it('reads <home>/.claude and labels it ~/.claude without the override', () => {
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    delete process.env.CLAUDE_CONFIG_DIR;
    fs.mkdirSync(path.join(homeDir, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(homeDir, '.claude', 'agents', 'a.md'), '---\nname: a\n---\nb');

    const ctx = scanSkillFiles();

    expect(ctx.files.map((f) => f.displayPath)).toEqual(['~/.claude/agents/a.md']);
  });
});
