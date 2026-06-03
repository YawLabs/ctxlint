import { describe, it, expect } from 'vitest';
import { validateCatalogObject } from '../catalog-schema.js';

/**
 * Gap 5: the hand-rolled validator's ERROR classes. The existing
 * catalog-schema.test.ts only exercises the happy path (every published
 * catalog validates clean). These tests drive each failing branch of
 * validateNode by passing an inline schema as the second argument to
 * validateCatalogObject, so we can craft minimal INVALID inputs without
 * editing any published catalog.
 *
 * Branches covered (catalog-schema.ts:57-135):
 *   - type mismatch                       (line 82-85)
 *   - minLength on a string               (line 89-90)
 *   - pattern miss on a string            (line 92-93)
 *   - enum violation (string + non-string)(line 95-100, 103-105)
 *   - minItems on an array                (line 108-109)
 *   - missing required property           (line 120-123)
 *   - $ref into a missing $def -> throw   (resolveRef, line 57-64)
 *   - nested error path reporting         (properties/items recursion)
 */

describe('validateCatalogObject (invalid inputs)', () => {
  it('flags a top-level type mismatch (object expected, string given)', () => {
    const schema = { type: 'object' };
    const errors = validateCatalogObject('not-an-object', schema);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({ path: '', message: 'expected type object, got string' });
  });

  it('flags a property type mismatch and reports the property path', () => {
    const schema = {
      type: 'object',
      properties: { name: { type: 'string' } },
    };
    const errors = validateCatalogObject({ name: 123 }, schema);
    expect(errors).toEqual([{ path: 'name', message: 'expected type string, got number' }]);
  });

  it('flags a string shorter than minLength', () => {
    const schema = {
      type: 'object',
      properties: { id: { type: 'string', minLength: 3 } },
    };
    const errors = validateCatalogObject({ id: 'ab' }, schema);
    expect(errors).toEqual([{ path: 'id', message: 'string shorter than minLength 3' }]);
  });

  it('does NOT flag a string at exactly minLength (boundary)', () => {
    const schema = {
      type: 'object',
      properties: { id: { type: 'string', minLength: 3 } },
    };
    expect(validateCatalogObject({ id: 'abc' }, schema)).toEqual([]);
  });

  it('flags a string that fails the pattern', () => {
    const schema = {
      type: 'object',
      properties: { slug: { type: 'string', pattern: '^[a-z-]+$' } },
    };
    const errors = validateCatalogObject({ slug: 'Has_Caps' }, schema);
    expect(errors).toEqual([
      { path: 'slug', message: 'string does not match pattern ^[a-z-]+$' },
    ]);
  });

  it('flags a string value outside its enum', () => {
    const schema = {
      type: 'object',
      properties: { sev: { type: 'string', enum: ['error', 'warning', 'info'] } },
    };
    const errors = validateCatalogObject({ sev: 'critical' }, schema);
    expect(errors).toEqual([
      {
        path: 'sev',
        message: 'value "critical" not in enum ["error","warning","info"]',
      },
    ]);
  });

  it('flags a non-string value outside its enum (the typeof !== string branch)', () => {
    // No `type` declared so the typed-string enum branch is skipped and the
    // dedicated non-string enum check (catalog-schema.ts:103-105) fires.
    const schema = {
      type: 'object',
      properties: { count: { enum: [1, 2, 3] } },
    };
    const errors = validateCatalogObject({ count: 9 }, schema);
    expect(errors).toEqual([{ path: 'count', message: 'value not in enum [1,2,3]' }]);
  });

  it('flags an array shorter than minItems', () => {
    const schema = {
      type: 'object',
      properties: { rules: { type: 'array', minItems: 1, items: { type: 'string' } } },
    };
    const errors = validateCatalogObject({ rules: [] }, schema);
    expect(errors).toEqual([{ path: 'rules', message: 'array shorter than minItems 1' }]);
  });

  it('flags a missing required property', () => {
    const schema = {
      type: 'object',
      required: ['version', 'rules'],
      properties: { version: { type: 'string' } },
    };
    const errors = validateCatalogObject({ version: '1.0.0' }, schema);
    expect(errors).toEqual([{ path: '', message: 'missing required property "rules"' }]);
  });

  it('reports multiple missing required properties', () => {
    const schema = { type: 'object', required: ['a', 'b', 'c'] };
    const errors = validateCatalogObject({ a: 1 }, schema);
    expect(errors.map((e) => e.message)).toEqual([
      'missing required property "b"',
      'missing required property "c"',
    ]);
  });

  it('throws when a $ref points at a missing $def (resolveRef guard)', () => {
    const schema = {
      type: 'object',
      $defs: { real: { type: 'string' } },
      properties: { x: { $ref: '#/$defs/doesNotExist' } },
    };
    expect(() => validateCatalogObject({ x: 'hi' }, schema)).toThrow(
      /Unsupported or unknown \$ref: #\/\$defs\/doesNotExist/,
    );
  });

  it('throws on a non-local $ref shape (resolveRef regex miss)', () => {
    const schema = {
      properties: { x: { $ref: 'https://example.com/schema#/foo' } },
      type: 'object',
    };
    expect(() => validateCatalogObject({ x: 1 }, schema)).toThrow(/Unsupported or unknown \$ref/);
  });

  it('resolves a valid $ref and validates the referenced node', () => {
    // Positive control for the $ref path so the throw cases above are
    // meaningfully distinguished from "always throws".
    const schema = {
      type: 'object',
      $defs: { sev: { type: 'string', enum: ['error', 'warning'] } },
      properties: { severity: { $ref: '#/$defs/sev' } },
    };
    expect(validateCatalogObject({ severity: 'error' }, schema)).toEqual([]);
    const errors = validateCatalogObject({ severity: 'nope' }, schema);
    expect(errors).toEqual([
      { path: 'severity', message: 'value "nope" not in enum ["error","warning"]' },
    ]);
  });

  it('reports nested error paths through properties + array items', () => {
    const schema = {
      type: 'object',
      properties: {
        rules: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string', minLength: 2 } },
          },
        },
      },
    };
    const errors = validateCatalogObject({ rules: [{ id: 'ok' }, { id: 'x' }] }, schema);
    expect(errors).toEqual([
      { path: 'rules[1].id', message: 'string shorter than minLength 2' },
    ]);
  });

  it('accumulates several independent errors in one pass', () => {
    const schema = {
      type: 'object',
      required: ['name'],
      properties: {
        version: { type: 'string', minLength: 5 },
        tags: { type: 'array', minItems: 2 },
      },
    };
    const errors = validateCatalogObject({ version: 'v1', tags: [] }, schema);
    const msgs = errors.map((e) => `${e.path}: ${e.message}`).sort();
    expect(msgs).toEqual(
      [
        ': missing required property "name"',
        'tags: array shorter than minItems 2',
        'version: string shorter than minLength 5',
      ].sort(),
    );
  });

  it('stops descending after a type mismatch (no spurious sub-errors)', () => {
    // When the type guard fails, validateNode returns early -- the minLength
    // check that would also "fail" on a number is never reached.
    const schema = {
      type: 'object',
      properties: { id: { type: 'string', minLength: 100 } },
    };
    const errors = validateCatalogObject({ id: 42 }, schema);
    expect(errors).toEqual([{ path: 'id', message: 'expected type string, got number' }]);
  });
});
