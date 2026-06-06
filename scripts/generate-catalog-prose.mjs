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
  { catalog: 'mcph-config-lint-rules.json', spec: null, label: 'mcph Config Linting' },
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

function categoryCount(c) {
  return new Set((c.rules ?? []).map((r) => r.category)).size;
}

/** Rewrite a spec's count headers from the catalog (rules + categories). */
export function applyCountsToSpec(body, rules, categories) {
  let out = body;
  out = out.replace(/\b\d+(\s+lint)?\s+rules\s+organized into\s+\d+\s+categories\b/gi, (m) =>
    m
      .replace(/^\d+/, String(rules))
      .replace(/organized into\s+\d+/i, `organized into ${categories}`),
  );
  out = out.replace(/\b\d+(\s+lint)?\s+rules\s+in the\s+`[^`]+`\s+category\b/gi, (m) =>
    m.replace(/^\d+/, String(rules)),
  );
  out = out.replace(/\b\d+\s+rules\s+in\s+\d+\s+category\b/gi, (m) =>
    m.replace(/^\d+/, String(rules)),
  );
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
    const generated = applyCountsToSpec(current, ruleCount(c), categoryCount(c));
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

// Only run main when invoked directly, not when imported by the test.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
