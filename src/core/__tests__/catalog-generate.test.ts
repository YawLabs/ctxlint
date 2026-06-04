import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { CATALOGS, REPO_ROOT, type CatalogMeta } from '../catalog-meta.js';
import { specCoverageGaps } from '../catalog-generate.js';

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
  }
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
      ruleIdFormat: 'category/slug',
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
