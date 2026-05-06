import type { LintIssue, SessionContext } from '../../types.js';
import { projectDirMatchesPath } from '../../session-parser.js';
import { jaccardSimilarityFromSets, toLineSet } from '../../../utils/similarity.js';

const MIN_TOKEN_LEN = 5;

/**
 * Detect near-duplicate memory entries across different projects.
 * Memories with >60% line overlap are flagged for consolidation.
 *
 * Scoped to pairs where at least one side belongs to the current project —
 * otherwise every `ctxlint --session` invocation from any repo would
 * surface the same unrelated cross-project duplicates.
 *
 * Perf: precompute the line-set for each memory once and reuse across the
 * O(N^2) pair scan, mirroring `redundancy.ts:checkDuplicateContent`. The
 * naive `jaccardSimilarity(a, b)` call rebuilds two Sets per pair, which on
 * a populated `~/.claude/projects` (hundreds of memory files across dozens
 * of projects) burned O(N^2) Set allocations per audit.
 */
export async function checkDuplicateMemory(ctx: SessionContext): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];
  const reported = new Set<string>();

  // Precompute per-memory data once. We tokenize even short memories — the
  // length check below uses the original `content.length` (raw chars), not
  // the line-set size, so we can't skip tokenization just because the file
  // is short. The cost is amortized over N-1 pair comparisons either way.
  const lineSets = ctx.memories.map((m) => toLineSet(m.content, MIN_TOKEN_LEN));

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

      const overlap = jaccardSimilarityFromSets(lineSets[i], lineSets[j]);
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
