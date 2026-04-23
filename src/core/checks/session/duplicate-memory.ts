import type { LintIssue, SessionContext } from '../../types.js';
import { projectDirMatchesPath } from '../../session-parser.js';

/**
 * Jaccard similarity over non-trivial lines. Returns |A ∩ B| / |A ∪ B|.
 * Earlier "matches / max(|A|, |B|)" was asymmetric because linesA was an
 * array (duplicates counted) and linesB was a set (deduplicated).
 */
function calculateLineOverlap(a: string, b: string): number {
  const linesA = new Set(
    a
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 5),
  );
  const linesB = new Set(
    b
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 5),
  );

  if (linesA.size === 0 || linesB.size === 0) return 0;

  let intersection = 0;
  for (const line of linesA) {
    if (linesB.has(line)) intersection++;
  }
  const unionSize = linesA.size + linesB.size - intersection;
  return intersection / unionSize;
}

/**
 * Detect near-duplicate memory entries across different projects.
 * Memories with >60% line overlap are flagged for consolidation.
 *
 * Scoped to pairs where at least one side belongs to the current project —
 * otherwise every `ctxlint --session` invocation from any repo would
 * surface the same unrelated cross-project duplicates.
 */
export async function checkDuplicateMemory(ctx: SessionContext): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];
  const reported = new Set<string>();

  for (let i = 0; i < ctx.memories.length; i++) {
    for (let j = i + 1; j < ctx.memories.length; j++) {
      const a = ctx.memories[i];
      const b = ctx.memories[j];

      // Only compare memories from different projects (projectDir is an encoded dir name)
      if (a.projectDir === b.projectDir) continue;

      // Require at least one side to belong to the current project.
      const aIsCurrent = projectDirMatchesPath(a.projectDir, ctx.currentProject);
      const bIsCurrent = projectDirMatchesPath(b.projectDir, ctx.currentProject);
      if (!aIsCurrent && !bIsCurrent) continue;

      // Skip very short memories (not meaningful to compare)
      if (a.content.length < 50 || b.content.length < 50) continue;

      const overlap = calculateLineOverlap(a.content, b.content);
      if (overlap < 0.6) continue;

      // Avoid duplicate reports for the same pair
      const pairKey = [a.filePath, b.filePath].sort().join('::');
      if (reported.has(pairKey)) continue;
      reported.add(pairKey);

      const nameA = a.name || a.filePath.split(/[/\\]/).pop() || 'unknown';
      const nameB = b.name || b.filePath.split(/[/\\]/).pop() || 'unknown';
      const projA = a.projectDir.split(/[/\\]/).pop() || a.projectDir;
      const projB = b.projectDir.split(/[/\\]/).pop() || b.projectDir;

      issues.push({
        severity: 'info',
        check: 'session-duplicate-memory',
        ruleId: 'session/duplicate-memory',
        line: 0,
        message: `Memory "${nameA}" (${projA}) and "${nameB}" (${projB}) have ${Math.round(overlap * 100)}% overlap`,
        suggestion: `Consider consolidating into a shared memory or removing the duplicate`,
        detail: `Near-duplicate memories across projects waste context and may drift out of sync`,
      });
    }
  }

  return issues;
}
