import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { LintIssue, SessionContext } from '../../types.js';

/**
 * Detect GitHub Actions workflows that exist in 2+ sibling repos but not in the current project.
 */
export async function checkMissingWorkflow(ctx: SessionContext): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];

  const currentWorkflowDir = join(ctx.currentProject, '.github', 'workflows');
  // If current project has no .github at all, skip — likely not a GitHub-deployed project
  if (!existsSync(join(ctx.currentProject, '.github'))) return issues;

  // Get current project's workflows
  const currentWorkflows = new Set<string>();
  if (existsSync(currentWorkflowDir)) {
    try {
      const files = await readdir(currentWorkflowDir);
      for (const f of files) {
        if (f.endsWith('.yml') || f.endsWith('.yaml')) currentWorkflows.add(f);
      }
    } catch {
      // can't read directory
    }
  }

  // Build map: workflow filename -> list of siblings that have it
  const workflowMap = new Map<string, string[]>();

  for (const sib of ctx.siblings) {
    const sibWorkflowDir = join(sib.path, '.github', 'workflows');
    if (!existsSync(sibWorkflowDir)) continue;

    try {
      const files = await readdir(sibWorkflowDir);
      for (const f of files) {
        if (!(f.endsWith('.yml') || f.endsWith('.yaml'))) continue;
        if (!workflowMap.has(f)) workflowMap.set(f, []);
        workflowMap.get(f)!.push(sib.name);
      }
    } catch {
      continue;
    }
  }

  // Flag workflows that 2+ siblings have but current project doesn't
  for (const [workflow, siblings] of workflowMap) {
    if (currentWorkflows.has(workflow)) continue;
    if (siblings.length < 2) continue;

    const sibNames = siblings.join(', ');
    issues.push({
      severity: 'warning',
      check: 'session-missing-workflow',
      ruleId: 'session/missing-workflow',
      line: 0,
      message: `GitHub Actions workflow "${workflow}" exists in ${siblings.length} sibling repos (${sibNames}) but not in this project`,
      suggestion: `Consider adding .github/workflows/${workflow} for consistency`,
      detail: `Sibling repos with this workflow: ${sibNames}`,
    });
  }

  return issues;
}
