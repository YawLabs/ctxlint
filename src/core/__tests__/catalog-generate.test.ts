import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { CATALOGS, REPO_ROOT } from '../catalog-meta.js';
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
