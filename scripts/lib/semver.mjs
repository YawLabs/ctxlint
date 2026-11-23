/**
 * X.Y.Z parsing and comparison for the repo scripts, in one place.
 *
 * check-oam-floor.mjs, check-yaw-mcp-floor.mjs and verify-oam-floor.mjs used
 * to carry their own copies, and they had already drifted: verify-oam-floor's
 * parse was unanchored, so any text holding a version anywhere parsed as one.
 *
 * bin/ctxlint.mjs keeps its own copy on purpose: the launcher ships in the
 * package and must stay self-contained, and scripts/ is not published. Its
 * oam-specific parsing is checked against this module in launcher.test.ts.
 */

/**
 * `X.Y.Z` (an optional leading `v`, anything after the patch ignored: a
 * pre-release suffix truncates to its base version) -> [major, minor, patch],
 * or null when the text does not START with one.
 */
export function parseVersion(text) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(text).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** -1, 0 or 1 as `a` is older than, equal to or newer than `b`. */
export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** True when `v` is at least `min`; false for a null `v`. */
export function atLeast(v, min) {
  return v !== null && compareVersions(v, min) >= 0;
}

/**
 * `oam --version` output -> [major, minor, patch], or null when it is not
 * oam's. oam prints `oam X.Y.Z`, and its own self-update smoke test accepts a
 * binary only when stdout starts with "oam " -- so anything else (Node's
 * `v22.1.0`, an unrelated tool that happens to be called oam) is not an oam.
 */
export function parseOamVersionOutput(text) {
  const m = /^oam (\d+\.\d+\.\d+)(?:[-+\s]|$)/.exec(String(text).trim());
  return m ? parseVersion(m[1]) : null;
}
