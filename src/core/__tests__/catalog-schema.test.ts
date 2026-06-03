import { describe, it, expect } from 'vitest';
import { CATALOGS, readCatalog } from '../catalog-meta.js';
import {
  validateCatalogFile,
  checkCategoryReferences,
  loadCatalogSchema,
} from '../catalog-schema.js';

/**
 * CI gate (item 2): every published catalog must validate against the single
 * governing schema (schemas/ctxlint-catalog.schema.json) AND satisfy the
 * referential-integrity constraint that JSON Schema can't express (every
 * rule.category references a declared category id).
 */

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

      it('points $schema at the governing catalog schema', () => {
        const c = readCatalog(meta);
        expect(c.$schema).toMatch(/ctxlint-catalog\.schema\.json$/);
      });
    });
  }

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
