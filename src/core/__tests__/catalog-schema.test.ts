import { describe, it, expect } from 'vitest';
import { CATALOGS, readCatalog } from '../catalog-meta.js';
import {
  validateCatalogFile,
  checkCategoryReferences,
  checkDuplicateRuleIds,
  checkUnusedCategories,
  checkRuleIdPrefixes,
  loadCatalogSchema,
} from '../catalog-schema.js';

/**
 * CI gate (item 2): every published catalog must validate against the single
 * governing schema (schemas/ctxlint-catalog.schema.json) AND satisfy the
 * cross-field constraints that JSON Schema can't express (category
 * referential integrity in both directions, rule-id uniqueness, and the
 * prefix-equals-category convention).
 */

/**
 * Published legacy rule IDs that predate the prefix-equals-category
 * convention. Their IDs are published API and stay stable; everything else
 * must satisfy prefix === category. If a rule here is ever renamed/removed,
 * the companion test below fails so the allowlist can't outlive its entries.
 */
const RULE_ID_PREFIX_ALLOWLIST: ReadonlyMap<string, string> = new Map([
  ['ci/no-release-docs', 'ci-coverage'],
  ['ci/undocumented-secret', 'ci-secrets'],
]);

describe('catalog schema validation', () => {
  it('the governing schema itself parses', () => {
    expect(() => loadCatalogSchema()).not.toThrow();
  });

  for (const meta of CATALOGS) {
    describe(meta.key, () => {
      it('validates against ctxlint-catalog.schema.json', () => {
        const errors = validateCatalogFile(meta);
        expect(
          errors,
          `${meta.catalog} schema errors:\n` +
            errors.map((e) => `  ${e.path || '(root)'}: ${e.message}`).join('\n'),
        ).toEqual([]);
      });

      it('every rule.category references a declared category', () => {
        const errors = checkCategoryReferences(readCatalog(meta));
        expect(errors, errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')).toEqual([]);
      });

      it('every declared category is used by at least one rule', () => {
        const errors = checkUnusedCategories(readCatalog(meta));
        expect(errors, errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')).toEqual([]);
      });

      it('declares no duplicate rule ids', () => {
        const errors = checkDuplicateRuleIds(readCatalog(meta));
        expect(errors, errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')).toEqual([]);
      });

      it('rule id prefix matches rule.category (legacy ci/* IDs allowlisted)', () => {
        const errors = checkRuleIdPrefixes(
          readCatalog(meta),
          new Set(RULE_ID_PREFIX_ALLOWLIST.keys()),
        );
        expect(errors, errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')).toEqual([]);
      });

      it('points $schema at the governing catalog schema', () => {
        const c = readCatalog(meta);
        expect(c.$schema).toMatch(/ctxlint-catalog\.schema\.json$/);
      });
    });
  }

  it('the prefix allowlist entries still exist with their expected categories', () => {
    // Guard the allowlist itself: each allowlisted ID must still be published
    // (in the context catalog) under the category the exception was granted
    // for. A renamed or removed rule must also be removed from the allowlist.
    const contextMeta = CATALOGS.find((m) => m.key === 'context');
    expect(contextMeta).toBeDefined();
    const context = readCatalog(contextMeta as (typeof CATALOGS)[number]);
    const byId = new Map((context.rules ?? []).map((r) => [r.id, r.category]));
    for (const [id, expectedCategory] of RULE_ID_PREFIX_ALLOWLIST) {
      expect(byId.get(id), `allowlisted ${id} missing from context-lint-rules.json`).toBe(
        expectedCategory,
      );
    }
  });

  it('mcpSpecCompatibility is present only where the catalog tracks the MCP wire spec', () => {
    // mcp-config is the only protocol-bound catalog; the others are
    // deliberately protocol-agnostic and omit the field (absence is meaningful).
    for (const meta of CATALOGS) {
      const c = readCatalog(meta);
      if (meta.key === 'mcp-config') {
        expect(
          c.mcpSpecCompatibility,
          'mcp-config should declare mcpSpecCompatibility',
        ).toBeTruthy();
      } else {
        expect(
          c.mcpSpecCompatibility,
          `${meta.key} is protocol-agnostic and should omit mcpSpecCompatibility`,
        ).toBeUndefined();
      }
    }
  });
});
