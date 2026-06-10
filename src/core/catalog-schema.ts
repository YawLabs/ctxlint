/**
 * Dependency-free validator for ctxlint rule catalogs against
 * `schemas/ctxlint-catalog.schema.json`.
 *
 * Why hand-rolled instead of ajv: ctxlint bundles to a single zero-runtime-dep
 * file (see build.mjs). The catalog schema uses only a small, fixed subset of
 * JSON Schema draft 2020-12 (type, required, enum, pattern, minLength,
 * minItems, properties, items, $ref into $defs, additionalProperties: true).
 * Interpreting that subset is ~80 lines and avoids pulling ajv (+ its deps)
 * into the dependency graph for one CI gate.
 *
 * It is NOT a general JSON Schema engine. If the schema grows constructs this
 * validator doesn't implement, extend `validateAgainst` deliberately rather
 * than assuming silent coverage.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { REPO_ROOT, CATALOG_SCHEMA, type CatalogMeta } from './catalog-meta.js';

type Json = unknown;
interface SchemaNode {
  type?: string;
  required?: string[];
  enum?: Json[];
  pattern?: string;
  minLength?: number;
  minItems?: number;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  $ref?: string;
  $defs?: Record<string, SchemaNode>;
  additionalProperties?: boolean;
  format?: string;
  [k: string]: Json;
}

export interface ValidationError {
  path: string;
  message: string;
}

let cachedSchema: SchemaNode | null = null;

export function loadCatalogSchema(): SchemaNode {
  if (cachedSchema) return cachedSchema;
  const abs = path.join(REPO_ROOT, CATALOG_SCHEMA);
  cachedSchema = JSON.parse(fs.readFileSync(abs, 'utf-8')) as SchemaNode;
  return cachedSchema;
}

function typeOf(value: Json): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function resolveRef(ref: string, root: SchemaNode): SchemaNode {
  // Only local "#/$defs/<name>" refs are used.
  const m = ref.match(/^#\/\$defs\/(.+)$/);
  if (!m || !root.$defs || !root.$defs[m[1]]) {
    throw new Error(`Unsupported or unknown $ref: ${ref}`);
  }
  return root.$defs[m[1]];
}

function validateNode(
  value: Json,
  node: SchemaNode,
  root: SchemaNode,
  loc: string,
  errors: ValidationError[],
): void {
  if (node.$ref) {
    validateNode(value, resolveRef(node.$ref, root), root, loc, errors);
    return;
  }

  if (node.type) {
    const actual = typeOf(value);
    // JSON Schema "integer" is a distinct type that `typeof` can't produce;
    // accept any JS number for it. (The catalog schema doesn't currently use
    // "integer", but the accommodation matches what a schema author would
    // expect if it ever does.)
    const ok = node.type === actual || (node.type === 'integer' && actual === 'number');
    if (!ok) {
      errors.push({ path: loc, message: `expected type ${node.type}, got ${actual}` });
      return; // further checks assume the type held
    }
  }

  if (typeof value === 'string') {
    if (node.minLength !== undefined && value.length < node.minLength) {
      errors.push({ path: loc, message: `string shorter than minLength ${node.minLength}` });
    }
    if (node.pattern && !new RegExp(node.pattern).test(value)) {
      errors.push({ path: loc, message: `string does not match pattern ${node.pattern}` });
    }
    if (node.enum && !node.enum.includes(value)) {
      errors.push({
        path: loc,
        message: `value "${value}" not in enum ${JSON.stringify(node.enum)}`,
      });
    }
  }

  if (node.enum && typeof value !== 'string' && !node.enum.includes(value)) {
    errors.push({ path: loc, message: `value not in enum ${JSON.stringify(node.enum)}` });
  }

  if (Array.isArray(value)) {
    if (node.minItems !== undefined && value.length < node.minItems) {
      errors.push({ path: loc, message: `array shorter than minItems ${node.minItems}` });
    }
    if (node.items) {
      value.forEach((item, i) =>
        validateNode(item, node.items as SchemaNode, root, `${loc}[${i}]`, errors),
      );
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, Json>;
    for (const req of node.required ?? []) {
      if (!(req in obj)) {
        errors.push({ path: loc, message: `missing required property "${req}"` });
      }
    }
    if (node.properties) {
      for (const [key, sub] of Object.entries(node.properties)) {
        if (key in obj) {
          validateNode(obj[key], sub, root, loc === '' ? key : `${loc}.${key}`, errors);
        }
      }
    }
    // additionalProperties: true (or absent) -> extra keys allowed. We never
    // set it to false, so no extra-property checks are needed.
  }
}

/** Validate an already-parsed catalog object against the catalog schema. */
export function validateCatalogObject(catalog: Json, schema?: SchemaNode): ValidationError[] {
  const root = schema ?? loadCatalogSchema();
  const errors: ValidationError[] = [];
  validateNode(catalog, root, root, '', errors);
  return errors;
}

/** Read + validate a catalog by its meta entry. */
export function validateCatalogFile(meta: CatalogMeta): ValidationError[] {
  const abs = path.join(REPO_ROOT, meta.catalog);
  let parsed: Json;
  try {
    parsed = JSON.parse(fs.readFileSync(abs, 'utf-8'));
  } catch (err) {
    return [{ path: meta.catalog, message: `failed to parse JSON: ${(err as Error).message}` }];
  }
  return validateCatalogObject(parsed);
}

/**
 * Referential-integrity check beyond what plain JSON Schema expresses: every
 * `rule.category` must reference a declared category `id`. JSON Schema can't
 * express this cross-field constraint, so it lives here alongside validation.
 */
export function checkCategoryReferences(catalog: Json): ValidationError[] {
  const errors: ValidationError[] = [];
  if (catalog === null || typeof catalog !== 'object') return errors;
  const c = catalog as {
    categories?: Array<{ id?: string }>;
    rules?: Array<{ id?: string; category?: string }>;
  };
  const declared = new Set((c.categories ?? []).map((cat) => cat.id));
  for (const r of c.rules ?? []) {
    if (r.category && !declared.has(r.category)) {
      errors.push({
        path: `rules[${r.id ?? '?'}]`,
        message: `category "${r.category}" is not declared in categories[]`,
      });
    }
  }
  return errors;
}

/**
 * Uniqueness check JSON Schema can't express (uniqueItems compares whole
 * items, not a single field): no two rules may share an `id`. A copy-pasted
 * rule entry would otherwise pass schema validation, pass category
 * references, satisfy spec coverage (one spec mention covers both copies),
 * and self-consistently inflate every generated count.
 */
export function checkDuplicateRuleIds(catalog: Json): ValidationError[] {
  const errors: ValidationError[] = [];
  if (catalog === null || typeof catalog !== 'object') return errors;
  const c = catalog as { rules?: Array<{ id?: string }> };
  const seen = new Set<string>();
  for (const r of c.rules ?? []) {
    if (!r.id) continue;
    if (seen.has(r.id)) {
      errors.push({ path: `rules[${r.id}]`, message: `duplicate rule id "${r.id}"` });
    }
    seen.add(r.id);
  }
  return errors;
}

/**
 * Inverse of checkCategoryReferences: every declared category must be used by
 * at least one rule. An orphaned declared category silently desyncs the
 * generated "organized into M categories" prose, because both categoryCount
 * implementations (catalog-meta.ts and generate-catalog-prose.mjs) count
 * categories USED by rules, not categories declared.
 */
export function checkUnusedCategories(catalog: Json): ValidationError[] {
  const errors: ValidationError[] = [];
  if (catalog === null || typeof catalog !== 'object') return errors;
  const c = catalog as {
    categories?: Array<{ id?: string }>;
    rules?: Array<{ category?: string }>;
  };
  const used = new Set((c.rules ?? []).map((r) => r.category));
  for (const cat of c.categories ?? []) {
    if (cat.id && !used.has(cat.id)) {
      errors.push({
        path: `categories[${cat.id}]`,
        message: `category "${cat.id}" is declared but no rule uses it`,
      });
    }
  }
  return errors;
}

/**
 * Convention check the schema's `rule.id` pattern can't express: the
 * `category/slug` prefix must equal the rule's `category`. The schema pattern
 * only validates the SHAPE (lowercase kebab + one slash); this validates the
 * cross-field invariant. `allowlist` carries published legacy IDs that
 * predate the convention and are kept stable (renaming a published rule ID is
 * breaking): currently `ci/no-release-docs` (category `ci-coverage`) and
 * `ci/undocumented-secret` (category `ci-secrets`), passed in by the test.
 */
export function checkRuleIdPrefixes(
  catalog: Json,
  allowlist: ReadonlySet<string> = new Set(),
): ValidationError[] {
  const errors: ValidationError[] = [];
  if (catalog === null || typeof catalog !== 'object') return errors;
  const c = catalog as { rules?: Array<{ id?: string; category?: string }> };
  for (const r of c.rules ?? []) {
    if (!r.id || !r.id.includes('/')) continue;
    if (allowlist.has(r.id)) continue;
    const prefix = r.id.slice(0, r.id.indexOf('/'));
    if (prefix !== r.category) {
      errors.push({
        path: `rules[${r.id}]`,
        message: `rule id prefix "${prefix}" does not match category "${r.category}"`,
      });
    }
  }
  return errors;
}
