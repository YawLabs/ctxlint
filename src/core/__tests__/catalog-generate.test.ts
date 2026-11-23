import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { CATALOGS, REPO_ROOT, type CatalogMeta } from '../catalog-meta.js';
import { specCoverageGaps, specDocumentedRuleIds, specOrphanRuleIds } from '../catalog-generate.js';
// @ts-expect-error generate-catalog-prose.mjs is plain JS with no type declarations
import { applyCountsToSpec, specCountHeaders } from '../../../scripts/generate-catalog-prose.mjs';

/**
 * CI gate (item 3): the catalog-derived prose (spec count headers + README
 * family-table counts) must be in sync with the catalogs, and every catalog
 * rule must be documented in its spec.
 */

describe('generate-from-catalog', () => {
  it('checked-in spec/README counts are in sync with the catalogs', () => {
    // Runs the same script build.mjs runs, in --check mode. Exit 0 == in sync;
    // exit 1 throws here with the script's stderr listing the drifted files.
    const script = path.join(REPO_ROOT, 'scripts', 'generate-catalog-prose.mjs');
    expect(() =>
      execFileSync(process.execPath, [script, '--check'], { cwd: REPO_ROOT, stdio: 'pipe' }),
    ).not.toThrow();
  });

  for (const meta of CATALOGS) {
    if (!meta.spec) continue;
    it(`${meta.spec} documents every rule ID in ${meta.catalog}`, () => {
      const gaps = specCoverageGaps(meta);
      expect(gaps, `rule IDs missing from ${meta.spec}: ${gaps.join(', ')}`).toEqual([]);
    });

    it(`${meta.catalog} declares every rule ID ${meta.spec} documents`, () => {
      const orphans = specOrphanRuleIds(meta);
      expect(
        orphans,
        `rule IDs in ${meta.spec} but not the catalog: ${orphans.join(', ')}`,
      ).toEqual([]);
    });
  }
});

describe('specDocumentedRuleIds', () => {
  it('reads table first cells and **Rule ID** field rows, not prose mentions', () => {
    const body = [
      '| `paths/not-found` | error | x |',
      '| **Rule ID**  | `session/missing-secret` |',
      'See `session/other` for the dynamic half.',
      '| Field | `not/first-cell` |',
    ].join('\n');
    expect(specDocumentedRuleIds(body).sort()).toEqual([
      'paths/not-found',
      'session/missing-secret',
    ]);
  });
});

describe('specCoverageGaps token-bounded matching', () => {
  // Fixtures live under REPO_ROOT because specCoverageGaps resolves meta.catalog
  // and meta.spec relative to it. A temp subdir keeps them out of the way.
  const fixtureDir = path.join('src', 'core', '__tests__', '.coverage-fixtures');
  const absFixtureDir = path.join(REPO_ROOT, fixtureDir);

  afterEach(() => {
    fs.rmSync(absFixtureDir, { recursive: true, force: true });
  });

  function writeFixture(rules: string[], specBody: string): CatalogMeta {
    fs.mkdirSync(absFixtureDir, { recursive: true });
    const catalogRel = path.join(fixtureDir, 'cat.json');
    const specRel = path.join(fixtureDir, 'spec.md');
    fs.writeFileSync(
      path.join(REPO_ROOT, catalogRel),
      JSON.stringify({ rules: rules.map((id) => ({ id })) }),
    );
    fs.writeFileSync(path.join(REPO_ROOT, specRel), specBody);
    return {
      key: 'fixture',
      catalog: catalogRel,
      spec: specRel,
      label: 'Fixture',
    };
  }

  it('reports a shorter ID hidden behind a documented longer superstring as a gap', () => {
    // The spec documents `tier-tokens/aggregate` but NOT the bare
    // `tokens/aggregate`. A raw substring scan would see `tokens/aggregate`
    // inside `tier-tokens/aggregate` and wrongly call it covered; the
    // token-bounded test must flag it.
    const meta = writeFixture(
      ['tokens/aggregate', 'tier-tokens/aggregate'],
      'The `tier-tokens/aggregate` rule sums always-loaded context tokens.\n',
    );
    expect(specCoverageGaps(meta)).toEqual(['tokens/aggregate']);
  });

  it('treats an ID documented as its own token as covered', () => {
    const meta = writeFixture(
      ['tokens/aggregate', 'tier-tokens/aggregate'],
      'Rules: `tokens/aggregate` and `tier-tokens/aggregate` both apply.\n',
    );
    expect(specCoverageGaps(meta)).toEqual([]);
  });
});

describe('applyCountsToSpec per-category guard', () => {
  it('rewrites the header count for any catalog', () => {
    const out = applyCountsToSpec('Has 28 lint rules organized into 11 categories.', 39, [
      'a',
      'b',
      'c',
    ]);
    expect(out).toBe('Has 39 lint rules organized into 3 categories.');
  });

  it('does NOT rewrite a per-category subset sentence in a multi-category catalog', () => {
    // The failure mode this pins: a multi-category spec writing
    // "4 rules in the `frontmatter` category" must not be corrupted to the
    // catalog total during a routine build.
    const body =
      'There are 4 rules in the `frontmatter` category and 3 rules in the `security` category.';
    expect(applyCountsToSpec(body, 28, ['frontmatter', 'security', 'paths'])).toBe(body);
  });

  it('rewrites the per-category sentence for a single-category catalog with a matching name', () => {
    const out = applyCountsToSpec(
      '- 8 lint rules in the `session` category\n\n8 rules in 1 category (`session`).',
      9,
      ['session'],
    );
    expect(out).toBe(
      '- 9 lint rules in the `session` category\n\n9 rules in 1 category (`session`).',
    );
  });

  it('leaves a per-category sentence alone when the named category is not the sole category', () => {
    const body = '2 rules in the `something-else` category';
    expect(applyCountsToSpec(body, 9, ['session'])).toBe(body);
  });

  it('rewrites every header phrasing and keeps the category noun in step with the count', () => {
    // A catalog going from 1 to 2 categories must not leave "in 2 category".
    expect(applyCountsToSpec('5 rules in 1 category (`skill`).', 6, ['skill', 'other'])).toBe(
      '6 rules in 2 categories (`skill`).',
    );
    expect(applyCountsToSpec('9 lint rules organized into 1 category', 9, ['a', 'b'])).toBe(
      '9 lint rules organized into 2 categories',
    );
  });

  it('specCountHeaders returns every header, not just the first', () => {
    const body =
      '- 43 lint rules organized into 12 categories\n\n## 3\n\n41 rules organized into 12 categories.';
    expect(specCountHeaders(body)).toEqual([
      { rules: 43, categories: 12 },
      { rules: 41, categories: 12 },
    ]);
  });
});
