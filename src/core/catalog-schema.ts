/**
 * Dependency-free validator for ctxlint rule catalogs against
 * `schemas/ctxlint-catalog.schema.json`.
 *
 * Why hand-rolled instead of ajv: ctxlint bundles to a single zero-runtime-dep
 * file (see build.mjs). The catalog schema uses only a small, fixed subset of
 * JSON Schema draft 2020-12 (type, required, enum, pattern, minLength,
 * minItems, properties, items, format ("uri"), $ref into $defs, and
 * additionalProperties as a boolean or a schema). Interpreting that subset is
 * ~100 lines and avoids pulling ajv (+ its deps) into the dependency graph for
 * one CI gate.
 *
 * It is NOT a general JSON Schema engine. A keyword outside
 * SUPPORTED_SCHEMA_KEYWORDS makes validation throw (see
 * checkSchemaKeywords), so a schema that grows a construct this validator
 * does not implement fails loudly instead of being silently ignored. Extend
 * `validateNode` and the keyword set together.
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
  additionalProperties?: boolean | SchemaNode;
  format?: string;
  [k: string]: Json;
}

/** Keywords validateNode enforces. */
const VALIDATION_KEYWORDS = [
  'type',
  'required',
  'enum',
  'pattern',
  'minLength',
  'minItems',
  'properties',
  'items',
  '$ref',
  '$defs',
  'additionalProperties',
  'format',
] as const;

/** Annotation keywords: they carry no constraint, so ignoring them is correct. */
const ANNOTATION_KEYWORDS = [
  '$schema',
  '$id',
  '$comment',
  'title',
  'description',
  'default',
  'examples',
] as const;

/** Every keyword the validator understands. Anything else makes it throw. */
export const SUPPORTED_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  ...VALIDATION_KEYWORDS,
  ...ANNOTATION_KEYWORDS,
]);

/** The only `format` value the validator implements. */
const SUPPORTED_FORMATS: ReadonlySet<string> = new Set(['uri']);

/**
 * Every keyword used anywhere in `schema`, walking the subschema positions
 * this validator knows (properties values, items, $defs values and a schema
 * additionalProperties). Keys INSIDE `properties` / `$defs` are names, not
 * keywords, so they are not collected.
 */
export function schemaKeywordsUsed(schema: SchemaNode): Set<string> {
  const used = new Set<string>();
  const walk = (node: SchemaNode) => {
    for (const key of Object.keys(node)) used.add(key);
    for (const sub of Object.values(node.properties ?? {})) walk(sub);
    for (const sub of Object.values(node.$defs ?? {})) walk(sub);
    if (node.items) walk(node.items);
    if (node.additionalProperties && typeof node.additionalProperties === 'object') {
      walk(node.additionalProperties);
    }
  };
  walk(schema);
  return used;
}

/**
 * Throw when the schema uses a keyword (or a `format`) the validator does not
 * implement. Without this an unknown constraint would be skipped silently and
 * every catalog would "pass" it.
 */
export function checkSchemaKeywords(schema: SchemaNode): void {
  const unknown = [...schemaKeywordsUsed(schema)].filter((k) => !SUPPORTED_SCHEMA_KEYWORDS.has(k));
  if (unknown.length > 0) {
    throw new Error(`Unsupported JSON Schema keyword(s): ${unknown.sort().join(', ')}`);
  }
  const walkFormats = (node: SchemaNode) => {
    if (node.format !== undefined && !SUPPORTED_FORMATS.has(node.format)) {
      throw new Error(`Unsupported JSON Schema format: ${node.format}`);
    }
    for (const sub of Object.values(node.properties ?? {})) walkFormats(sub);
    for (const sub of Object.values(node.$defs ?? {})) walkFormats(sub);
    if (node.items) walkFormats(node.items);
    if (node.additionalProperties && typeof node.additionalProperties === 'object') {
      walkFormats(node.additionalProperties);
    }
  };
  walkFormats(schema);
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
    // We only implement the one format the catalog schema uses: "uri".
    // new URL() throws on anything that isn't an absolute URL with a scheme.
    if (node.format === 'uri') {
      try {
        new URL(value);
      } catch {
        errors.push({ path: loc, message: `string is not a valid uri` });
      }
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
    const declared = node.properties ?? {};
    for (const [key, sub] of Object.entries(declared)) {
      if (key in obj) {
        validateNode(obj[key], sub, root, loc === '' ? key : `${loc}.${key}`, errors);
      }
    }
    // additionalProperties: true (or absent) -> extra keys allowed; false ->
    // each undeclared key is an error; a schema -> each undeclared value must
    // satisfy it.
    const extra = node.additionalProperties;
    if (extra !== undefined && extra !== true) {
      for (const key of Object.keys(obj)) {
        if (key in declared) continue;
        const keyLoc = loc === '' ? key : `${loc}.${key}`;
        if (extra === false) {
          errors.push({ path: keyLoc, message: `unexpected property "${key}"` });
        } else {
          validateNode(obj[key], extra, root, keyLoc, errors);
        }
      }
    }
  }
}

/** Validate an already-parsed catalog object against the catalog schema. */
export function validateCatalogObject(catalog: Json, schema?: SchemaNode): ValidationError[] {
  const root = schema ?? loadCatalogSchema();
  checkSchemaKeywords(root);
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

const SEVERITY_RANK: Record<string, number> = { info: 0, warning: 1, error: 2 };

/**
 * Per-rule shape invariants the schema cannot express:
 *  - a rule declares at most one of severityByFormat / severityVariants;
 *  - when it declares one, it names at least two distinct severities, and
 *    `severity` is the highest of them (the documented meaning of the field);
 *  - fixDescription is present exactly when fixable is true.
 */
export function checkRuleSeverityShape(catalog: Json): ValidationError[] {
  const errors: ValidationError[] = [];
  if (catalog === null || typeof catalog !== 'object') return errors;
  const c = catalog as {
    rules?: Array<{
      id?: string;
      severity?: string;
      fixable?: boolean;
      fixDescription?: string;
      severityByFormat?: Record<string, string>;
      severityVariants?: Array<{ severity?: string }>;
    }>;
  };
  for (const r of c.rules ?? []) {
    const path = `rules[${r.id ?? '?'}]`;
    if (r.severityByFormat && r.severityVariants) {
      errors.push({ path, message: 'declares both severityByFormat and severityVariants' });
    }
    const split = r.severityByFormat
      ? Object.values(r.severityByFormat)
      : r.severityVariants?.map((v) => v.severity ?? '');
    if (split) {
      const distinct = new Set(split);
      if (distinct.size < 2) {
        errors.push({ path, message: 'per-case severities name only one severity' });
      }
      const max = [...distinct].sort((a, b) => SEVERITY_RANK[b] - SEVERITY_RANK[a])[0];
      if (r.severity !== max) {
        errors.push({
          path,
          message: `severity "${r.severity}" is not the highest per-case severity "${max}"`,
        });
      }
    }
    if (r.fixable === true && !r.fixDescription) {
      errors.push({ path, message: 'fixable rule has no fixDescription' });
    }
    if (r.fixable === false && r.fixDescription !== undefined) {
      errors.push({ path, message: 'non-fixable rule carries a fixDescription' });
    }
  }
  return errors;
}

/**
 * Inverse of checkCategoryReferences: every declared category must be used by
 * at least one rule. An orphaned declared category silently desyncs the
 * generated "organized into M categories" prose, because
 * generate-catalog-prose.mjs counts categories USED by rules, not categories
 * declared.
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
