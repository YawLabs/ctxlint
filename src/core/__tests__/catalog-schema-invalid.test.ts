import { describe, it, expect } from 'vitest';
import { CATALOGS, readCatalog, type CatalogShape } from '../catalog-meta.js';
import {
  validateCatalogObject,
  checkDuplicateRuleIds,
  checkUnusedCategories,
  checkRuleIdPrefixes,
  checkRuleSeverityShape,
  loadCatalogSchema,
  schemaKeywordsUsed,
} from '../catalog-schema.js';

/**
 * Gap 5: the hand-rolled validator's ERROR classes. The existing
 * catalog-schema.test.ts only exercises the happy path (every published
 * catalog validates clean). These tests drive each failing branch of
 * validateNode by passing an inline schema as the second argument to
 * validateCatalogObject, so we can craft minimal INVALID inputs without
 * editing any published catalog.
 *
 * Branches covered (validateNode in catalog-schema.ts, unless noted):
 *   - type mismatch                       (the `type` check)
 *   - minLength on a string               (the string branch)
 *   - pattern miss on a string            (the string branch)
 *   - format: "uri" miss on a string      (the string branch)
 *   - enum violation (string + non-string)(the string branch + the non-string enum check)
 *   - minItems on an array                (the array branch)
 *   - missing required property           (the object branch)
 *   - additionalProperties false / schema (the object branch)
 *   - $ref into a missing $def -> throw   (resolveRef)
 *   - unknown keyword / format -> throw   (checkSchemaKeywords)
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
    expect(errors).toEqual([{ path: 'slug', message: 'string does not match pattern ^[a-z-]+$' }]);
  });

  it('flags a string that is not a valid uri (format: "uri")', () => {
    const schema = {
      type: 'object',
      properties: { repository: { type: 'string', format: 'uri' } },
    };
    const errors = validateCatalogObject({ repository: 'not a url' }, schema);
    expect(errors).toEqual([{ path: 'repository', message: 'string is not a valid uri' }]);
  });

  it('does NOT flag a valid uri (format: "uri")', () => {
    const schema = {
      type: 'object',
      properties: { repository: { type: 'string', format: 'uri' } },
    };
    expect(validateCatalogObject({ repository: 'https://example.com/repo' }, schema)).toEqual([]);
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
    // dedicated non-string enum check in validateNode fires.
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
    expect(errors).toEqual([{ path: 'rules[1].id', message: 'string shorter than minLength 2' }]);
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

  it('flags an undeclared property under additionalProperties: false', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: { severity: { type: 'string' } },
    };
    expect(validateCatalogObject({ severity: 'error' }, schema)).toEqual([]);
    expect(validateCatalogObject({ severity: 'error', when: 'x' }, schema)).toEqual([
      { path: 'when', message: 'unexpected property "when"' },
    ]);
  });

  it('validates undeclared property values against an additionalProperties schema', () => {
    const schema = {
      type: 'object',
      properties: { rules: { type: 'object', additionalProperties: { enum: ['error', 'info'] } } },
    };
    expect(validateCatalogObject({ rules: { a: 'error', b: 'info' } }, schema)).toEqual([]);
    expect(validateCatalogObject({ rules: { a: 'error', b: 'fatal' } }, schema)).toEqual([
      { path: 'rules.b', message: 'value "fatal" not in enum ["error","info"]' },
    ]);
  });

  it('throws on a keyword the validator does not implement, instead of ignoring it', () => {
    const schema = { type: 'object', properties: { n: { type: 'number', maximum: 3 } } };
    expect(() => validateCatalogObject({ n: 99 }, schema)).toThrow(
      /Unsupported JSON Schema keyword\(s\): maximum/,
    );
  });

  it('throws on a format other than "uri"', () => {
    const schema = { type: 'object', properties: { d: { type: 'string', format: 'date' } } };
    expect(() => validateCatalogObject({ d: 'x' }, schema)).toThrow(
      /Unsupported JSON Schema format/,
    );
  });

  it('collects keywords through properties, $defs, items and additionalProperties only', () => {
    const schema = {
      type: 'object',
      properties: { minimum: { type: 'string' } }, // a property NAMED like a keyword
      $defs: { a: { type: 'array', items: { pattern: 'x' } } },
      additionalProperties: { minLength: 1 },
    };
    expect([...schemaKeywordsUsed(schema)].sort()).toEqual(
      [
        '$defs',
        'additionalProperties',
        'items',
        'minLength',
        'pattern',
        'properties',
        'type',
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

/**
 * Real-schema negative tests: mutate a REAL published catalog and validate it
 * against the actual governing schema (schemas/ctxlint-catalog.schema.json).
 * The inline-schema suite above proves the validator's branches work; this
 * suite proves the WIRING — that the governing schema's required/enum/pattern
 * declarations actually reach those branches. A typo in the schema file
 * (e.g. "requried") would pass the inline suite but fail here.
 */
describe('validateCatalogObject (mutated real catalog vs governing schema)', () => {
  const contextMeta = CATALOGS.find((m) => m.key === 'context');
  if (!contextMeta) throw new Error('context catalog meta missing');

  // Arrow assigned after the guard (not a hoisted function declaration) so the
  // contextMeta narrowing above applies inside the closure.
  const mutatedCatalog = (mutate: (c: CatalogShape) => void): CatalogShape => {
    const clone = structuredClone(readCatalog(contextMeta));
    mutate(clone);
    return clone;
  };

  it('control: the unmutated catalog validates clean against the governing schema', () => {
    const errors = validateCatalogObject(readCatalog(contextMeta), loadCatalogSchema());
    expect(errors).toEqual([]);
  });

  it('flags a rule missing the required "stability" field', () => {
    const c = mutatedCatalog((cat) => {
      delete (cat.rules?.[0] as Record<string, unknown>).stability;
    });
    const errors = validateCatalogObject(c, loadCatalogSchema());
    expect(errors).toEqual([
      { path: 'rules[0]', message: 'missing required property "stability"' },
    ]);
  });

  it('flags a severity outside the enum', () => {
    const c = mutatedCatalog((cat) => {
      (cat.rules?.[0] as Record<string, unknown>).severity = 'critical';
    });
    const errors = validateCatalogObject(c, loadCatalogSchema());
    expect(errors).toEqual([
      {
        path: 'rules[0].severity',
        message: 'value "critical" not in enum ["error","warning","info"]',
      },
    ]);
  });

  it('flags a rule id that breaks the category/slug pattern', () => {
    const c = mutatedCatalog((cat) => {
      (cat.rules?.[0] as Record<string, unknown>).id = 'NoSlashHere';
    });
    const errors = validateCatalogObject(c, loadCatalogSchema());
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe('rules[0].id');
    expect(errors[0].message).toMatch(/does not match pattern/);
  });

  it('flags a missing top-level required property (specVersion)', () => {
    const c = mutatedCatalog((cat) => {
      delete (cat as Record<string, unknown>).specVersion;
    });
    const errors = validateCatalogObject(c, loadCatalogSchema());
    expect(errors).toEqual([{ path: '', message: 'missing required property "specVersion"' }]);
  });

  it('flags a specDate that breaks the ISO-date pattern', () => {
    const c = mutatedCatalog((cat) => {
      (cat as Record<string, unknown>).specDate = '2026/06/10';
    });
    const errors = validateCatalogObject(c, loadCatalogSchema());
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe('specDate');
    expect(errors[0].message).toMatch(/does not match pattern/);
  });
});

/**
 * Failing-branch coverage for the cross-field checks (the published-catalog
 * happy paths live in catalog-schema.test.ts).
 */
describe('cross-field checks (invalid inputs)', () => {
  it('checkDuplicateRuleIds flags a copy-pasted rule id once per extra copy', () => {
    const catalog = {
      rules: [{ id: 'a/x' }, { id: 'a/y' }, { id: 'a/x' }, { id: 'a/x' }],
    };
    const errors = checkDuplicateRuleIds(catalog);
    expect(errors).toEqual([
      { path: 'rules[a/x]', message: 'duplicate rule id "a/x"' },
      { path: 'rules[a/x]', message: 'duplicate rule id "a/x"' },
    ]);
  });

  it('checkUnusedCategories flags a declared category no rule uses', () => {
    const catalog = {
      categories: [{ id: 'used' }, { id: 'orphan' }],
      rules: [{ id: 'used/x', category: 'used' }],
    };
    expect(checkUnusedCategories(catalog)).toEqual([
      { path: 'categories[orphan]', message: 'category "orphan" is declared but no rule uses it' },
    ]);
  });

  it('checkRuleIdPrefixes flags a prefix/category mismatch', () => {
    const catalog = { rules: [{ id: 'ci/thing', category: 'ci-coverage' }] };
    expect(checkRuleIdPrefixes(catalog)).toEqual([
      {
        path: 'rules[ci/thing]',
        message: 'rule id prefix "ci" does not match category "ci-coverage"',
      },
    ]);
  });

  it('checkRuleIdPrefixes suppresses allowlisted legacy ids', () => {
    const catalog = { rules: [{ id: 'ci/thing', category: 'ci-coverage' }] };
    expect(checkRuleIdPrefixes(catalog, new Set(['ci/thing']))).toEqual([]);
  });

  it('checkRuleSeverityShape requires severity to be the highest per-case severity', () => {
    const variants = [
      { severity: 'error', when: 'a' },
      { severity: 'info', when: 'b' },
    ];
    expect(
      checkRuleSeverityShape({
        rules: [{ id: 'a/x', severity: 'error', fixable: false, severityVariants: variants }],
      }),
    ).toEqual([]);
    expect(
      checkRuleSeverityShape({
        rules: [{ id: 'a/x', severity: 'info', fixable: false, severityVariants: variants }],
      }),
    ).toEqual([
      {
        path: 'rules[a/x]',
        message: 'severity "info" is not the highest per-case severity "error"',
      },
    ]);
  });

  it('checkRuleSeverityShape rejects one-severity splits and both split fields at once', () => {
    const errors = checkRuleSeverityShape({
      rules: [
        {
          id: 'a/x',
          severity: 'warning',
          fixable: false,
          severityByFormat: { f: 'warning', g: 'warning' },
          severityVariants: [{ severity: 'warning' }, { severity: 'info' }],
        },
      ],
    });
    expect(errors.map((e) => e.message)).toEqual([
      'declares both severityByFormat and severityVariants',
      'per-case severities name only one severity',
    ]);
  });

  it('checkRuleSeverityShape ties fixDescription to fixable', () => {
    expect(
      checkRuleSeverityShape({
        rules: [
          { id: 'a/x', severity: 'error', fixable: true },
          { id: 'a/y', severity: 'error', fixable: false, fixDescription: 'stale' },
        ],
      }),
    ).toEqual([
      { path: 'rules[a/x]', message: 'fixable rule has no fixDescription' },
      { path: 'rules[a/y]', message: 'non-fixable rule carries a fixDescription' },
    ]);
  });
});
