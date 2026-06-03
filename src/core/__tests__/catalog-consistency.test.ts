import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { CATALOGS, REPO_ROOT, ruleCount } from '../catalog-meta.js';

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
 *   | **mcph Config Linting** (`...`)         | 10 rules for validating ... |
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
