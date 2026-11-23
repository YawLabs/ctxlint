/**
 * Jaccard similarity over non-trivial lines. Returns |A intersect B| / |A union B|
 * in [0, 1], where 1 means identical sets. Lines are trimmed and filtered by
 * `minLengthExclusive` (default 5) to drop trivial boilerplate that would
 * otherwise dominate the union (blank lines, single-character separators, short
 * markup). The bound is an EXCLUSIVE character length of the trimmed line: a
 * line survives only when `line.length > minLengthExclusive`, so the default
 * keeps lines of 6+ characters. It is a line length, not a token count.
 *
 * Earlier check-local variants used "matches / max(|A|, |B|)" which was both
 * asymmetric (one side an array, the other a set) and inflated/deflated the
 * score based on file size rather than actual shared content. The Jaccard
 * formulation matches the user-facing message ("content overlap") and is what
 * three separate checks now share.
 *
 * Empty-input handling:
 *  - When `bothEmptyIsIdentical` is false (default), an empty side returns 0.
 *  - When `bothEmptyIsIdentical` is true, two empty sides return 1 (used by
 *    diverged-file: two empty canonical files are trivially "in sync"); a
 *    single empty side still returns 0.
 */
export function jaccardSimilarity(
  a: string,
  b: string,
  opts: { minLengthExclusive?: number; bothEmptyIsIdentical?: boolean } = {},
): number {
  const minLengthExclusive = opts.minLengthExclusive ?? 5;
  const linesA = toLineSet(a, minLengthExclusive);
  const linesB = toLineSet(b, minLengthExclusive);
  return jaccardSimilarityFromSets(linesA, linesB, {
    bothEmptyIsIdentical: opts.bothEmptyIsIdentical,
  });
}

/**
 * Jaccard over precomputed line sets. Use this when you have many pairs to
 * compare over the same files (e.g. checking N files against each other in
 * O(N^2) pairs) — build each set once and reuse, instead of having
 * `jaccardSimilarity` rebuild them on every call.
 */
export function jaccardSimilarityFromSets(
  a: Set<string>,
  b: Set<string>,
  opts: { bothEmptyIsIdentical?: boolean } = {},
): number {
  const bothEmptyIsIdentical = opts.bothEmptyIsIdentical ?? false;

  if (a.size === 0 && b.size === 0) {
    return bothEmptyIsIdentical ? 1 : 0;
  }
  if (a.size === 0 || b.size === 0) return 0;

  // Iterate over the smaller side to minimise hash lookups in the larger one.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const line of small) {
    if (large.has(line)) intersection++;
  }
  const unionSize = a.size + b.size - intersection;
  return intersection / unionSize;
}

/**
 * Set of trimmed lines whose length is strictly greater than
 * `minLengthExclusive` (see jaccardSimilarity).
 */
export function toLineSet(text: string, minLengthExclusive: number): Set<string> {
  return new Set(
    text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > minLengthExclusive),
  );
}
