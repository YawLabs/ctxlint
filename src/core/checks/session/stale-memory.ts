import { existsSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import type { LintIssue, SessionContext } from '../../types.js';

/**
 * Check Claude Code memory files for references to paths that no longer exist.
 */
export async function checkStaleMemory(ctx: SessionContext): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];
  const currentNorm = ctx.currentProject.replace(/\\/g, '/');

  // Only check memories belonging to the current project
  const projectMemories = ctx.memories.filter(
    (m) => m.projectDir.replace(/\\/g, '/') === currentNorm,
  );

  for (const mem of projectMemories) {
    const brokenPaths: string[] = [];

    for (const ref of mem.referencedPaths) {
      // Resolve path relative to project root
      const fullPath = isAbsolute(ref) ? ref : resolve(ctx.currentProject, ref);

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
