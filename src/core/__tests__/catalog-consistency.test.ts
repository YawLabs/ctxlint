import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { CATALOGS, REPO_ROOT, ruleCount } from '../catalog-meta.js';
// The prose generator (build.mjs's source of truth) keeps its OWN duplicate
// CATALOGS list. Import it here so drift between the two hand-maintained lists
// fails CI. It is plain .mjs (no TS) so build.mjs can call it without a compile
// step; vitest loads the .mjs directly here.
// @ts-expect-error generate-catalog-prose.mjs is plain JS with no type declarations
import { CATALOGS as PROSE_CATALOGS } from '../../../scripts/generate-catalog-prose.mjs';

/**
 * Guards against rule-count drift: the prose count headers in each spec and the
 * README "Specifications" family table must agree with the catalog's actual
 * `.rules.length`. Catalogs are the machine-readable source of truth; prose is
 * generated/verified from them (see build.mjs generate-from-catalog step).
 */

const README = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf-8');

/**
 * Pull the "<N> rules ..." count from a spec body. Specs phrase this as either
 * "N rules organized into M categories" or "N rules in 1 category (...)".
 * Returns null if no such header is found.
 */
function specRuleCount(specBody: string): number | null {
  const m = specBody.match(/\b(\d+)\s+rules?\s+(?:organized into|in)\b/i);
  return m ? Number(m[1]) : null;
}

/**
 * Pull the count from the README "Specifications" family table row, matched by
 * the catalog's label. Rows look like:
 *   | **[AI Context File Linting Spec](...)** | 27 rules for validating ... |
 *   | **[MCP Config Linting Spec](...)**      | 10 rules for validating ... |
 */
function readmeTableCount(label: string): number | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\*\\*[^*]*${escaped}[^*]*\\*\\*[^|]*\\|\\s*(\\d+)\\s+rules?\\b`, 'i');
  const m = README.match(re);
  return m ? Number(m[1]) : null;
}

describe('catalog rule-count consistency', () => {
  for (const meta of CATALOGS) {
    describe(meta.key, () => {
      const count = ruleCount(meta);

      it('catalog has at least one rule', () => {
        expect(count).toBeGreaterThan(0);
      });

      if (meta.spec) {
        it(`${meta.spec} header count matches catalog (${count})`, () => {
          const body = fs.readFileSync(path.join(REPO_ROOT, meta.spec as string), 'utf-8');
          const stated = specRuleCount(body);
          expect(stated, `no "<N> rules" header found in ${meta.spec}`).not.toBeNull();
          expect(stated).toBe(count);
        });
      }

      it(`README family-table count matches catalog (${count})`, () => {
        const stated = readmeTableCount(meta.label);
        expect(
          stated,
          `no README "Specifications" row matched label "${meta.label}"`,
        ).not.toBeNull();
        expect(stated).toBe(count);
      });
    });
  }
});

/**
 * Guards against drift between the two hand-maintained catalog lists: the TS
 * `CATALOGS` in catalog-meta.ts and the duplicate `CATALOGS` in
 * scripts/generate-catalog-prose.mjs (which build.mjs reads via computeTargets).
 * The shared shape is the catalog/spec/label triple; the .mjs list omits the
 * TS-only `key` / `ruleIdFormat` fields, so only the triples are compared.
 */
describe('catalog-meta.ts and generate-catalog-prose.mjs CATALOGS agree', () => {
  it('declare the same number of catalogs', () => {
    expect(PROSE_CATALOGS.length).toBe(CATALOGS.length);
  });

  it('catalog/spec/label triples match element-wise', () => {
    const triples = (
      list: ReadonlyArray<{ catalog: string; spec: string | null; label: string }>,
    ) => list.map(({ catalog, spec, label }) => ({ catalog, spec, label }));
    expect(triples(PROSE_CATALOGS)).toEqual(triples(CATALOGS));
  });
});
