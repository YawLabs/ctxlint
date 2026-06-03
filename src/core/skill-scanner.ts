import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { stripBom } from '../utils/fs.js';
import type { SkillContext, SkillFile } from './types.js';

/**
 * Resolve the user home dir the same way the session pillar does
 * (env-first, OS fallback) so HOME/USERPROFILE overrides in tests/CI apply
 * consistently across both home-scoped pillars.
 */
function defaultHome(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

/**
 * Discover Claude Code skill + agent definition files (fourth pillar, v1).
 *
 * v1 scope is deliberately Claude-Code-only:
 *   - skills:  ~/.claude/skills/<name>/SKILL.md
 *   - agents:  ~/.claude/agents/*.md
 *
 * A skills/<name>/ directory with NO SKILL.md is reported as orphaned (the
 * directory exists but Claude Code has nothing to load).
 */
export function scanSkillFiles(homeDir: string = defaultHome()): SkillContext {
  const files: SkillFile[] = [];
  const orphanedSkillDirs: { name: string; displayPath: string }[] = [];

  const claudeDir = path.join(homeDir, '.claude');

  // --- Skills: ~/.claude/skills/<name>/SKILL.md ---
  const skillsRoot = path.join(claudeDir, 'skills');
  for (const name of safeReadDir(skillsRoot, 'dir')) {
    const skillMd = path.join(skillsRoot, name, 'SKILL.md');
    const content = safeRead(skillMd);
    if (content === null) {
      orphanedSkillDirs.push({ name, displayPath: `~/.claude/skills/${name}/` });
      continue;
    }
    files.push({
      filePath: skillMd,
      displayPath: `~/.claude/skills/${name}/SKILL.md`,
      kind: 'skill',
      name,
      content,
    });
  }

  // --- Agents: ~/.claude/agents/*.md ---
  const agentsRoot = path.join(claudeDir, 'agents');
  for (const fileName of safeReadDir(agentsRoot, 'file')) {
    if (!fileName.endsWith('.md')) continue;
    const agentMd = path.join(agentsRoot, fileName);
    const content = safeRead(agentMd);
    if (content === null) continue;
    files.push({
      filePath: agentMd,
      displayPath: `~/.claude/agents/${fileName}`,
      kind: 'agent',
      name: fileName.replace(/\.md$/, ''),
      content,
    });
  }

  return { files, orphanedSkillDirs };
}

function safeReadDir(dir: string, want: 'dir' | 'file'): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // missing dir is expected
  }
  return entries
    .filter((e) => (want === 'dir' ? e.isDirectory() : e.isFile()))
    .map((e) => e.name)
    .sort();
}

function safeRead(file: string): string | null {
  try {
    return stripBom(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}
