/**
 * Single source of truth for the machine-readable rule catalogs that back the
 * ctxlint specifications. Used by:
 *
 *  - the catalog-consistency test (asserts each spec header + README count
 *    matches the catalog's actual `.rules.length`),
 *  - the catalog-schema validation (validates each catalog against
 *    `schemas/ctxlint-catalog.schema.json`),
 *  - `build.mjs`'s generate-from-catalog step (regenerates the spec count
 *    headers + README tables FROM the catalogs so prose can't drift).
 *
 * Every consumer resolves repo-root files relative to this module so there is
 * one place that knows the catalog -> spec -> README wiring.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// This file lives at <repo>/src/core/catalog-meta.ts, so repo root is two up.
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');

export interface CatalogMeta {
  /** Stable key used in test names + error messages. */
  key: string;
  /** Catalog filename, relative to repo root. */
  catalog: string;
  /** Companion spec markdown filename, relative to repo root. Null if the
   *  catalog ships without a prose spec (mcph is documented inline in README). */
  spec: string | null;
  /** Human label used in README's "Specifications" family table. */
  label: string;
  /**
   * Rule-ID format the catalog uses. ctxlint catalogs use `category/slug`
   * (a `/` separator); the sibling mcp-compliance project uses
   * `category-suffix` (a `-` separator). Documented here so the difference is
   * deliberate and machine-checkable, not accidental drift. See
   * docs/research / CONTRIBUTING for the canonical rationale.
   */
  ruleIdFormat: 'category/slug';
}

/**
 * The five published catalogs. Order is the canonical pillar order
 * (context, mcp-config, mcph, agent-session, agent-skill).
 */
export const CATALOGS: readonly CatalogMeta[] = [
  {
    key: 'context',
    catalog: 'context-lint-rules.json',
    spec: 'CONTEXT_LINT_SPEC.md',
    label: 'AI Context File Linting Spec',
    ruleIdFormat: 'category/slug',
  },
  {
    key: 'mcp-config',
    catalog: 'mcp-config-lint-rules.json',
    spec: 'MCP_CONFIG_LINT_SPEC.md',
    label: 'MCP Config Linting Spec',
    ruleIdFormat: 'category/slug',
  },
  {
    key: 'mcph-config',
    catalog: 'mcph-config-lint-rules.json',
    spec: null,
    label: 'mcph Config Linting',
    ruleIdFormat: 'category/slug',
  },
  {
    key: 'agent-session',
    catalog: 'agent-session-lint-rules.json',
    spec: 'AGENT_SESSION_LINT_SPEC.md',
    label: 'Agent Session Linting Spec',
    ruleIdFormat: 'category/slug',
  },
  {
    key: 'agent-skill',
    catalog: 'agent-skill-lint-rules.json',
    spec: 'AGENT_SKILL_LINT_SPEC.md',
    label: 'Agent Skill Linting Spec',
    ruleIdFormat: 'category/slug',
  },
];

export const CATALOG_SCHEMA = 'schemas/ctxlint-catalog.schema.json';

export interface CatalogShape {
  $schema?: string;
  specVersion?: string;
  specDate?: string;
  mcpSpecCompatibility?: string;
  repository?: string;
  categories?: Array<{ id: string; name?: string; description?: string }>;
  rules?: Array<{ id: string; category: string; severity: string }>;
  [k: string]: unknown;
}

/** Read + parse a catalog by its meta entry. Throws on missing/invalid JSON. */
export function readCatalog(meta: CatalogMeta): CatalogShape {
  const abs = path.join(REPO_ROOT, meta.catalog);
  return JSON.parse(fs.readFileSync(abs, 'utf-8')) as CatalogShape;
}

/** Number of rules declared in a catalog. */
export function ruleCount(meta: CatalogMeta): number {
  const c = readCatalog(meta);
  return Array.isArray(c.rules) ? c.rules.length : 0;
}

/** Number of distinct categories actually used by a catalog's rules. */
export function categoryCount(meta: CatalogMeta): number {
  const c = readCatalog(meta);
  const used = new Set((c.rules ?? []).map((r) => r.category));
  return used.size;
}
