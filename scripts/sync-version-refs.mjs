/**
 * Keeps the version strings that pin a SPECIFIC ctxlint release in step with
 * package.json. release.sh step 4 calls it with the version being released;
 * the version-refs vitest test runs it in --check mode.
 *
 * Usage:
 *   node scripts/sync-version-refs.mjs <X.Y.Z>   # rewrite every ref to X.Y.Z
 *   node scripts/sync-version-refs.mjs --check   # exit 1 unless every ref
 *                                                # matches package.json
 *
 * Why a script and not another `node -e` block in release.sh: the rewrite used
 * to live inline there for .pre-commit-hooks.yaml only, so README.md was never
 * touched and its pre-commit `rev:` pinned v0.9.10 from April 2026 until a hand
 * bump just before 0.25.0 (#63) -- which was stale again by 0.25.3. Every
 * pattern here is also checked by the test suite, so a README edit that
 * breaks one fails `npm test` at commit time instead of step 4 of a release.
 *
 * Each ref must match at least once, or nothing is written and the script
 * exits 1: a pattern that silently matches nothing is exactly how a pinned
 * version rots. Refs already at the target version are not an error, which
 * keeps a resumed release (package.json bumped by an earlier run) idempotent.
 */
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every pattern captures the text in front of the version as group 1, so the
 * rewrite is `prefix + version` for all of them. Exported for the unit tests.
 */
export const VERSION_REFS = [
  {
    file: '.pre-commit-hooks.yaml',
    label: 'npx entry pin (@yawlabs/ctxlint@X.Y.Z)',
    pattern: /(@yawlabs\/ctxlint@)\d+\.\d+\.\d+/g,
  },
  {
    // Anchored to the ctxlint repo line so a `rev:` belonging to some other
    // hook in a future example is never rewritten. The tag is `vX.Y.Z`.
    file: 'README.md',
    label: 'pre-commit framework `rev: vX.Y.Z`',
    pattern:
      /(repo: https:\/\/github\.com\/yawlabs\/ctxlint[ \t]*\r?\n[ \t]*rev: v)\d+\.\d+\.\d+/gi,
  },
  {
    file: 'README.md',
    label: 'Example Output banner `ctxlint vX.Y.Z`',
    pattern: /^(ctxlint v)\d+\.\d+\.\d+(?=[ \t]*\r?$)/gm,
  },
];

export const SEMVER = /^\d+\.\d+\.\d+$/;

/**
 * Rewrites every occurrence of each ref's pattern in `src` to `version`.
 * Returns the new text and the labels of refs that matched nothing.
 */
export function applyVersionRefs(src, refs, version) {
  let next = src;
  const missing = [];
  for (const { label, pattern } of refs) {
    let count = 0;
    // A replacer function so each match is counted: a ref matching nothing fails.
    next = next.replace(pattern, (_match, prefix) => {
      count++;
      return prefix + version;
    });
    if (count === 0) missing.push(label);
  }
  return { next, missing };
}

/** One entry per file named in `refs`, read from `root`. */
export function computeTargets(version, root = ROOT, refs = VERSION_REFS) {
  const files = [...new Set(refs.map((r) => r.file))];
  return files.map((file) => {
    const path = join(root, file);
    const current = readFileSync(path, 'utf-8');
    const { next, missing } = applyVersionRefs(
      current,
      refs.filter((r) => r.file === file),
      version,
    );
    return { file, path, current, next, missing };
  });
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const version = check
    ? JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).version
    : args.find((a) => !a.startsWith('--'));

  if (!version || !SEMVER.test(version)) {
    console.error('Usage: node scripts/sync-version-refs.mjs <X.Y.Z> | --check');
    process.exit(1);
  }

  const targets = computeTargets(version);
  const missing = targets.flatMap((t) => t.missing.map((label) => `  ${t.file}: ${label}`));
  if (missing.length > 0) {
    console.error('sync-version-refs: pattern not found, nothing written:');
    for (const line of missing) console.error(line);
    process.exit(1);
  }

  const outOfSync = targets.filter((t) => t.current !== t.next);
  if (check) {
    if (outOfSync.length > 0) {
      console.error(
        `Pinned version refs do not match package.json (${version}). Run: node scripts/sync-version-refs.mjs ${version}`,
      );
      for (const t of outOfSync) console.error('  ' + t.file);
      process.exit(1);
    }
    console.log(`Pinned version refs match package.json (${version}).`);
    return;
  }

  for (const t of outOfSync) {
    writeFileSync(t.path, t.next, 'utf-8');
    console.log(`synced ${t.file} to ${version}`);
  }
  if (outOfSync.length === 0) console.log(`Pinned version refs already at ${version}.`);
}

// Only run main when invoked directly, not when imported by the test. Both
// sides go through realpath: node resolves the ESM entry's import.meta.url
// through symlinks but leaves argv[1] as typed, so a checkout reached through a
// symlink or junction would otherwise skip main and exit 0 -- a release that
// silently syncs nothing.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main();
}
