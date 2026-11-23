import type { LintIssue, SessionContext } from '../../types.js';
import { projectDirMatchesPath } from '../../session-parser.js';
import { jaccardSimilarityFromSets, toLineSet } from '../../../utils/similarity.js';

const MIN_TOKEN_LEN = 5;

/** Pairs at or above this Jaccard overlap are flagged. */
const OVERLAP_THRESHOLD = 0.6;

/** Memories shorter than this (trimmed) are too small to compare meaningfully. */
const MIN_CONTENT_CHARS = 50;

/**
 * Detect near-duplicate memory entries across different projects.
 * Memories with >60% line overlap are flagged for consolidation.
 *
 * Scoped to pairs where at least one side belongs to the current project —
 * otherwise every `ctxlint --session` invocation from any repo would
 * surface the same unrelated cross-project duplicates.
 *
 * Cost: the pair walk is current-project memories x the rest, not all N^2
 * pairs, and project membership is decided once per memory rather than per
 * pair. With no current-project memory nothing is read at all. Each pair is
 * then gated on line-set SIZE before any intersection: Jaccard |A n B| /
 * |A u B| is at most min/max of the two sizes, so a pair whose sizes differ
 * by more than that ratio cannot reach the threshold and is skipped. Line
 * sets are built lazily and memoized, so a memory never compared is never
 * tokenized.
 */
export async function checkDuplicateMemory(ctx: SessionContext): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];
  const memories = ctx.memories;

  // Membership per distinct projectDir, computed once.
  const currentByDir = new Map<string, boolean>();
  const isCurrent = (dir: string): boolean => {
    let v = currentByDir.get(dir);
    if (v === undefined) {
      v = projectDirMatchesPath(dir, ctx.currentProject);
      currentByDir.set(dir, v);
    }
    return v;
  };
  const currentIdx: number[] = [];
  for (let i = 0; i < memories.length; i++) {
    if (isCurrent(memories[i].projectDir)) currentIdx.push(i);
  }
  if (currentIdx.length === 0) return issues;

  const lineSets: Array<Set<string> | undefined> = new Array(memories.length);
  const getLineSet = (idx: number): Set<string> => {
    let ls = lineSets[idx];
    if (ls === undefined) {
      ls = toLineSet(memories[idx].content, MIN_TOKEN_LEN);
      lineSets[idx] = ls;
    }
    return ls;
  };
  // Trimmed length, memoized like the line sets (spec 2.5 step 3: leading or
  // trailing blank lines must not promote a trivially short memory).
  const lengths: Array<number | undefined> = new Array(memories.length);
  const longEnough = (idx: number): boolean => {
    let n = lengths[idx];
    if (n === undefined) {
      n = memories[idx].content.trim().length;
      lengths[idx] = n;
    }
    return n >= MIN_CONTENT_CHARS;
  };

  // Candidate pairs as (lower index, higher index), so a pair is visited once
  // whichever side is current and reported in the same A/B order as a full
  // i<j scan would.
  const pairs: Array<[number, number]> = [];
  const seenPair = new Set<string>();
  for (const c of currentIdx) {
    for (let o = 0; o < memories.length; o++) {
      if (o === c || memories[o].projectDir === memories[c].projectDir) continue;
      const i = Math.min(c, o);
      const j = Math.max(c, o);
      const key = `${i}:${j}`;
      if (seenPair.has(key)) continue;
      seenPair.add(key);
      pairs.push([i, j]);
    }
  }
  pairs.sort((x, y) => x[0] - y[0] || x[1] - y[1]);

  const reported = new Set<string>();
  for (const [i, j] of pairs) {
    if (!longEnough(i) || !longEnough(j)) continue;
    const a = memories[i];
    const b = memories[j];
    const setA = getLineSet(i);
    const setB = getLineSet(j);
    const small = Math.min(setA.size, setB.size);
    const large = Math.max(setA.size, setB.size);
    if (large > 0 && small / large < OVERLAP_THRESHOLD) continue;

    const overlap = jaccardSimilarityFromSets(setA, setB);
    if (overlap < OVERLAP_THRESHOLD) continue;

    // Avoid duplicate reports for the same pair of files
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
      ruleId: 'session-duplicate-memory/duplicate-memory',
      line: 0,
      message: `Memory "${nameA}" (${projA}) and "${nameB}" (${projB}) have ${Math.round(overlap * 100)}% overlap`,
      suggestion: `Consider consolidating into a shared memory or removing the duplicate`,
      detail: `Near-duplicate memories across projects waste context and may drift out of sync`,
    });
  }

  return issues;
}
