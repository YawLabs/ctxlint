import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every `ruleId` a check emits must exist in a published catalog.
 *
 * catalog-schema.test.ts validates each catalog against ITSELF -- schema shape,
 * category cross-references, duplicate ids, the prefix invariant. Nothing
 * compared the catalogs to the ruleIds the checks actually emit, so the two
 * were free to drift indefinitely, and they did: at the time this test was
 * added, 11 of 72 emitted ids appeared in no catalog at all.
 *
 * Why that matters more than a naming nit: the catalogs are the published
 * contract downstream integrations filter and suppress on. An id that is
 * emitted but not published cannot be looked up; an id that is published but
 * never emitted silently matches nothing forever. Both are invisible without
 * this check.
 *
 * KNOWN_DIVERGENCES is a ratchet, not an excuse. It freezes the existing gap
 * so new drift fails immediately, while leaving the (breaking, published-API)
 * question of which side to correct for a deliberate decision. Entries should
 * only ever be REMOVED.
 */

const CATALOGS = [
  'context-lint-rules.json',
  'mcp-config-lint-rules.json',
  'agent-session-lint-rules.json',
  'agent-skill-lint-rules.json',
] as const;

const CHECKS_DIR = join(process.cwd(), 'src', 'core', 'checks');

/**
 * Emitted ids that are NOT in any catalog, as of the commit that added this
 * test. Do not add to this list -- fix the mismatch instead.
 *
 * Two clusters:
 *   1. ci-*: the catalog publishes `ci/no-release-docs` and
 *      `ci/undocumented-secret` (kept as legacy ids by an explicit allowlist
 *      in catalog-schema.test.ts, on the grounds that they are published API)
 *      while the checks emit `ci-coverage/...` and `ci-secrets/...`. Whatever
 *      the published API is, it is not what the catalog says.
 *   2. session-*: the catalog publishes eight `session/<slug>` ids under a
 *      single `session` category; the checks emit nine `session-<check>/<slug>`
 *      ids. Not a pure rename -- the catalog's `session/memory-index-overflow`
 *      is emitted as two distinct ids (line-overflow, byte-overflow), so
 *      reconciling needs a shape decision, not just a string swap.
 */
const KNOWN_DIVERGENCES = new Set([
  'ci-coverage/no-release-docs',
  'ci-secrets/undocumented-secret',
  'session-diverged-file/diverged-file',
  'session-duplicate-memory/duplicate-memory',
  'session-loop-detection/consecutive-repeat',
  'session-loop-detection/cyclic-pattern',
  'session-memory-index-overflow/byte-overflow',
  'session-memory-index-overflow/line-overflow',
  'session-missing-secret/missing-secret',
  'session-missing-workflow/missing-workflow',
  'session-stale-memory/stale-memory',
]);

function catalogRuleIds(): Set<string> {
  const ids = new Set<string>();
  for (const file of CATALOGS) {
    const catalog = JSON.parse(readFileSync(join(process.cwd(), file), 'utf-8')) as {
      rules: { id: string }[];
    };
    for (const rule of catalog.rules) ids.add(rule.id);
  }
  return ids;
}

/**
 * Scan the check sources for `ruleId: '<literal>'`. A static scan rather than a
 * runtime harness: it needs no fixtures and cannot be defeated by a check whose
 * trigger conditions the suite happens not to reproduce. The tradeoff is that a
 * computed ruleId is invisible here -- see the guard test below.
 */
function emittedRuleIds(): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      const src = readFileSync(full, 'utf-8');
      for (const m of src.matchAll(/ruleId:\s*'([^']+)'/g)) {
        found.set(m[1], full);
      }
    }
  };
  walk(CHECKS_DIR);
  return found;
}

describe('catalog <-> emitter parity', () => {
  it('every emitted ruleId exists in a published catalog', () => {
    const ids = catalogRuleIds();
    const offenders = [...emittedRuleIds()]
      .filter(([id]) => !ids.has(id) && !KNOWN_DIVERGENCES.has(id))
      .map(([id, file]) => `${id}  (${file})`);

    expect(
      offenders,
      'These ruleIds are emitted but published nowhere, so no downstream config can filter or ' +
        'suppress them. Add them to the matching catalog (or correct the emitter).',
    ).toEqual([]);
  });

  it('the known-divergence ratchet only shrinks', () => {
    // If a divergence gets fixed, its entry must come out of the list --
    // otherwise the ratchet quietly stops protecting that id and a future
    // regression under the same name would be waved through.
    const ids = catalogRuleIds();
    const emitted = new Set(emittedRuleIds().keys());
    const stale = [...KNOWN_DIVERGENCES].filter((id) => ids.has(id) || !emitted.has(id));

    expect(
      stale,
      'These ids are in KNOWN_DIVERGENCES but are no longer divergent (either published now, or ' +
        'no longer emitted). Remove them from the list.',
    ).toEqual([]);
  });

  it('finds a plausible number of emitted ids (guards the static scan itself)', () => {
    // The scan only sees single-quoted literals. If a refactor moves ruleIds
    // behind a constant or template, this count collapses and the parity test
    // above starts passing vacuously -- exactly the failure mode of a test that
    // asserts over an accidentally-empty set.
    expect(emittedRuleIds().size).toBeGreaterThan(50);
  });
});
