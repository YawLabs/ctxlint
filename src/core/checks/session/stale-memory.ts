import { existsSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import type { LintIssue, SessionContext } from '../../types.js';
import { projectDirMatchesPath } from '../../session-parser.js';

/**
 * Resolve a reference to an absolute filesystem path for existence checking.
 * Handles the cases:
 *   `~/path`           → expand to $HOME (POSIX node doesn't expand `~`)
 *   `/abs/path`        → absolute
 *   `./rel` / `rel.md` → project-root-relative
 */
function resolveRef(ref: string, projectRoot: string): string | null {
  if (ref.startsWith('~/') || ref === '~') {
    const home = process.env.HOME || process.env.USERPROFILE;
    if (!home) return null;
    return ref === '~' ? home : resolve(home, ref.slice(2));
  }
  if (isAbsolute(ref)) return ref;
  return resolve(projectRoot, ref);
}

/**
 * Check Claude Code memory files for references to paths that no longer exist.
 */
export async function checkStaleMemory(ctx: SessionContext): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];

  // Only check memories belonging to the current project
  const projectMemories = ctx.memories.filter((m) =>
    projectDirMatchesPath(m.projectDir, ctx.currentProject),
  );

  for (const mem of projectMemories) {
    const brokenPaths: string[] = [];

    for (const ref of mem.referencedPaths) {
      const fullPath = resolveRef(ref, ctx.currentProject);
      if (!fullPath) continue; // unresolvable (no HOME) — skip silently

      if (!existsSync(fullPath)) {
        brokenPaths.push(ref);
      }
    }

    if (brokenPaths.length > 0) {
      const name = mem.name || mem.filePath.split(/[/\\]/).pop() || 'unknown';
      issues.push({
        severity: 'info',
        check: 'session-stale-memory',
        ruleId: 'session/stale-memory',
        line: 0,
        message: `Memory "${name}" references ${brokenPaths.length} path(s) that no longer exist: ${brokenPaths.join(', ')}`,
        suggestion: `Update or remove the memory file: ${mem.filePath}`,
        detail: `Memory files with broken path references may cause the AI agent to follow stale instructions`,
      });
    }
  }

  return issues;
}
