/**
 * Generate-from-catalog (item 3). The count headers in each spec and the counts
 * in the README "Specifications" family table are DERIVED from the
 * machine-readable rule catalogs so prose can't drift from the source of truth.
 *
 * Usage:
 *   node scripts/generate-catalog-prose.mjs          # write changes in place
 *   node scripts/generate-catalog-prose.mjs --check   # exit 1 if out of sync
 *
 * This is plain .mjs (no TS) so build.mjs can call it without a compile step
 * and the catalog-generate vitest test can shell out to it in --check mode.
 * One source of truth for the regeneration logic.
 *
 * Scope: ONLY the count substrings are generated. The rich per-rule tables
 * (trigger/message/algorithm prose) stay hand-authored; a separate test asserts
 * every catalog rule ID still appears in its spec to catch add/remove drift.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './lib/main-module.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * catalog -> spec wiring, plus the README label used in the family table.
 * Exported so the catalog-consistency test can assert these triples stay in
 * sync with the TS-side `CATALOGS` in src/core/catalog-meta.ts (drift fails CI).
 */
export const CATALOGS = [
  {
    catalog: 'context-lint-rules.json',
    spec: 'CONTEXT_LINT_SPEC.md',
    label: 'AI Context File Linting Spec',
  },
  {
    catalog: 'mcp-config-lint-rules.json',
    spec: 'MCP_CONFIG_LINT_SPEC.md',
    label: 'MCP Config Linting Spec',
  },
  {
    catalog: 'agent-session-lint-rules.json',
    spec: 'AGENT_SESSION_LINT_SPEC.md',
    label: 'Agent Session Linting Spec',
  },
  {
    catalog: 'agent-skill-lint-rules.json',
    spec: 'AGENT_SKILL_LINT_SPEC.md',
    label: 'Agent Skill Linting Spec',
  },
];

function readCatalog(name) {
  return JSON.parse(readFileSync(join(ROOT, name), 'utf-8'));
}

function ruleCount(c) {
  return Array.isArray(c.rules) ? c.rules.length : 0;
}

/** Ordered, de-duplicated category ids actually used by a catalog's rules. */
function usedCategoryIds(c) {
  return [...new Set((c.rules ?? []).map((r) => r.category))];
}

/**
 * Rewrite a spec's count headers from the catalog (rules + categories).
 *
 * `categoryIds` is the catalog's used-category id list. The "N rules in the
 * `X` category" / "N rules in 1 category" phrasings are rewritten ONLY for
 * single-category catalogs, and only when the named category IS that
 * catalog's sole category. Without that guard, a multi-category spec writing
 * a per-category subset sentence ("4 rules in the `frontmatter` category")
 * would be silently corrupted to the catalog TOTAL — and the corruption then
 * passes --check forever because the substitution is idempotent.
 */
export function applyCountsToSpec(body, rules, categoryIds) {
  const categories = categoryIds.length;
  const noun = categories === 1 ? 'category' : 'categories';
  let out = body;
  // The total header, in every phrasing the specs use: "N rules organized
  // into M categories", "N lint rules in M categories", "N rules in 1
  // category". Both numbers come from the catalog, and the noun follows M,
  // so a catalog that gains or loses its second category cannot leave
  // "in 2 category" behind.
  out = out.replace(
    /\b\d+(\s+lint)?(\s+)rules(\s+)(organized into|in)(\s+)\d+\s+categor(?:y|ies)\b/gi,
    (_m, lint, s1, s2, joiner, s3) =>
      `${rules}${lint ?? ''}${s1}rules${s2}${joiner}${s3}${categories} ${noun}`,
  );
  if (categories === 1) {
    const only = categoryIds[0];
    out = out.replace(
      /\b\d+(\s+lint)?\s+rules\s+in the\s+`([^`]+)`\s+category\b/gi,
      (m, _lint, name) => (name === only ? m.replace(/^\d+/, String(rules)) : m),
    );
  }
  return out;
}

/**
 * Every rule-count header in a spec body, as {rules, categories} pairs, in
 * order. Exported for the catalog-consistency test, which requires at least
 * one and requires ALL of them to agree with the catalog -- checking only the
 * first match let a second, stale header pass.
 */
export function specCountHeaders(body) {
  const out = [];
  const re = /\b(\d+)(?:\s+lint)?\s+rules\s+(?:organized into|in)\s+(\d+)\s+categor(?:y|ies)\b/gi;
  for (const m of body.matchAll(re)) out.push({ rules: Number(m[1]), categories: Number(m[2]) });
  return out;
}

/** Rewrite the README "Specifications" family-table counts from the catalogs. */
export function applyCountsToReadme(body, catalogs) {
  let out = body;
  for (const { label, catalog } of catalogs) {
    const n = ruleCount(readCatalog(catalog));
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(
      `(\\*\\*[^*]*${escaped}[^*]*\\*\\*[^|]*\\|\\s*)\\d+(\\s+rules?\\b)`,
      'gi',
    );
    out = out.replace(re, `$1${n}$2`);
  }
  return out;
}

/** Compute {file, current, generated} for every spec + the README. */
export function computeTargets() {
  const targets = [];
  for (const { catalog, spec } of CATALOGS) {
    if (!spec) continue;
    const c = readCatalog(catalog);
    const file = join(ROOT, spec);
    const current = readFileSync(file, 'utf-8');
    const generated = applyCountsToSpec(current, ruleCount(c), usedCategoryIds(c));
    targets.push({ file, current, generated });
  }
  const readme = join(ROOT, 'README.md');
  const current = readFileSync(readme, 'utf-8');
  targets.push({ file: readme, current, generated: applyCountsToReadme(current, CATALOGS) });
  return targets;
}

function main() {
  const check = process.argv.includes('--check');
  const targets = computeTargets();
  const outOfSync = targets.filter((t) => t.current !== t.generated);

  if (check) {
    if (outOfSync.length > 0) {
      console.error(
        'Catalog-derived prose is out of sync. Run: node scripts/generate-catalog-prose.mjs',
      );
      for (const t of outOfSync) console.error('  ' + relative(ROOT, t.file));
      process.exit(1);
    }
    console.log('Catalog-derived prose is in sync.');
    return;
  }

  for (const t of outOfSync) {
    writeFileSync(t.file, t.generated, 'utf-8');
    console.log('regenerated ' + relative(ROOT, t.file));
  }
  if (outOfSync.length === 0) console.log('Catalog-derived prose already in sync.');
}

// Only run main when invoked directly, not when imported by the test or by
// build.mjs. A raw argv[1] compare skipped main() from a junctioned or
// symlinked checkout and exited 0 having checked nothing -- see
// scripts/lib/main-module.mjs.
if (isMainModule(process.argv[1], import.meta.url)) {
  main();
}
