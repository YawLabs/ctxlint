import * as fs from 'node:fs';
import * as path from 'node:path';
import { claudeConfigDir, homeDir as resolveHome } from '../utils/claude-home.js';
import { stripBom } from '../utils/fs.js';
import type { SkillContext, SkillFile } from './types.js';

/**
 * How a config-dir path is shown. The default location reads as `~/.claude`;
 * a `CLAUDE_CONFIG_DIR` override is shown as the real path, since `~/.claude`
 * would point the user at a directory that was never scanned.
 */
function displayRoot(claudeDir: string): string {
  const home = resolveHome();
  if (home && path.resolve(claudeDir) === path.resolve(home, '.claude')) return '~/.claude';
  return claudeDir.replace(/\\/g, '/');
}

/**
 * Discover Claude Code skill + agent definition files (fourth pillar, v1).
 *
 * v1 scope is deliberately Claude-Code-only:
 *   - skills:  ~/.claude/skills/<name>/SKILL.md
 *   - agents:  ~/.claude/agents/*.md
 *
 * `~/.claude` is Claude Code's config dir: `CLAUDE_CONFIG_DIR` when set (see
 * `utils/claude-home.ts`). An explicit `homeDir` pins it to `<homeDir>/.claude`.
 *
 * A skills/<name>/ directory with NO SKILL.md is reported as orphaned (the
 * directory exists but Claude Code has nothing to load).
 */
export function scanSkillFiles(homeDir?: string): SkillContext {
  const files: SkillFile[] = [];
  const orphanedSkillDirs: { name: string; displayPath: string }[] = [];

  const claudeDir = claudeConfigDir(homeDir);
  // No home and no override: joining onto '' would scan cwd-relative
  // `skills/` and `agents/` directories as if they were the user's.
  if (!claudeDir) return { files, orphanedSkillDirs };
  const root = homeDir !== undefined ? '~/.claude' : displayRoot(claudeDir);

  // --- Skills: ~/.claude/skills/<name>/SKILL.md ---
  const skillsRoot = path.join(claudeDir, 'skills');
  for (const name of safeReadDir(skillsRoot, 'dir')) {
    const skillMd = path.join(skillsRoot, name, 'SKILL.md');
    const content = safeRead(skillMd);
    if (content === null) {
      orphanedSkillDirs.push({ name, displayPath: `${root}/skills/${name}/` });
      continue;
    }
    files.push({
      filePath: skillMd,
      displayPath: `${root}/skills/${name}/SKILL.md`,
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
      displayPath: `${root}/agents/${fileName}`,
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
    .filter((e) => {
      if (want === 'dir' ? e.isDirectory() : e.isFile()) return true;
      // Dirents report symlinks (and Windows junctions) as isSymbolicLink()
      // only — isDirectory()/isFile() are false. Dotfiles setups commonly
      // symlink skill dirs and agent files into ~/.claude, and Claude Code
      // follows the links when loading, so classify by the link target.
      if (!e.isSymbolicLink()) return false;
      try {
        const target = fs.statSync(path.join(dir, e.name));
        return want === 'dir' ? target.isDirectory() : target.isFile();
      } catch {
        return false; // broken link — nothing for Claude Code to load
      }
    })
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
