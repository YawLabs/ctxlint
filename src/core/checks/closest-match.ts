import levenshteinPkg from 'fast-levenshtein';

const levenshtein = levenshteinPkg.get;

export interface ClosestMatch {
  match: string;
  distance: number;
}

/**
 * The candidate with the smallest Levenshtein distance to `target` (the first
 * one wins a tie), or null when there is none within `maxDistance`. Shared by
 * the "Did you mean" pickers in commands.ts and paths.ts.
 *
 * |len(a) - len(b)| is a lower bound on the distance, so a candidate whose
 * length differs by at least the current best (or by more than the cap) is
 * skipped without computing it -- this keeps a scan over every project file
 * cheap.
 */
export function closestMatch(
  target: string,
  candidates: Iterable<string>,
  options: { maxDistance?: number; ignoreCase?: boolean } = {},
): ClosestMatch | null {
  const { maxDistance = Infinity, ignoreCase = false } = options;
  const t = ignoreCase ? target.toLowerCase() : target;
  let best: ClosestMatch | null = null;
  for (const c of candidates) {
    const lenDelta = Math.abs(t.length - c.length);
    if (lenDelta > maxDistance || (best && lenDelta >= best.distance)) continue;
    const d = levenshtein(t, ignoreCase ? c.toLowerCase() : c);
    if (d <= maxDistance && (!best || d < best.distance)) best = { match: c, distance: d };
  }
  return best;
}
