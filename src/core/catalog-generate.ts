/**
 * Catalog <-> spec coverage checks (item 3, TS side).
 *
 * The count-header / README generation logic lives in
 * `scripts/generate-catalog-prose.mjs` (one source of truth, runnable from
 * build.mjs and from the catalog-generate test via child_process --check).
 * This module holds the cross-checks that JSON Schema + count-regen don't
 * cover, in both directions:
 *  - specCoverageGaps: every rule ID declared in a catalog must appear
 *    somewhere in its companion spec body (a rule added to the catalog but
 *    never documented);
 *  - specOrphanRuleIds: every rule ID a spec documents in a rule table must
 *    be declared in the catalog (a rule documented, or left behind in the
 *    spec after a removal, that the catalog does not publish).
 * Rich per-rule tables stay hand-authored.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { REPO_ROOT, type CatalogMeta } from './catalog-meta.js';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readPair(meta: CatalogMeta): { body: string; ids: string[] } | null {
  if (!meta.spec) return null;
  const body = fs.readFileSync(path.join(REPO_ROOT, meta.spec), 'utf-8');
  const catalog = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, meta.catalog), 'utf-8')) as {
    rules: Array<{ id: string }>;
  };
  return { body, ids: catalog.rules.map((r) => r.id) };
}

export function specCoverageGaps(meta: CatalogMeta): string[] {
  const pair = readPair(meta);
  if (!pair) return [];
  // Token-bounded membership test rather than a raw substring scan. A bare
  // `body.includes(id)` lets a dropped rule ID hide behind a documented longer
  // superstring (e.g. `tokens/aggregate` inside `tier-tokens/aggregate`, or
  // `frontmatter/missing` inside `frontmatter/missing-field`) -- the gap goes
  // unreported. Requiring a word/path boundary on both sides (no surrounding
  // `\w`, `/`, or `-`) means the id must appear as its own token to count.
  return pair.ids.filter((id) => {
    const re = new RegExp(`(?<![\\w/-])${escapeRegex(id)}(?![\\w/-])`);
    return !re.test(pair.body);
  });
}

/**
 * Rule IDs the spec documents as rules, i.e. the backticked `category/slug`
 * in the first cell of a table row (`| \`paths/not-found\` | error | ...`) or
 * in a `| **Rule ID** | \`session/x\` |` field row. Prose mentions are not
 * collected: a spec may cite another pillar's rule (`session/...` from the
 * context spec) without documenting it.
 */
export function specDocumentedRuleIds(body: string): string[] {
  const ids = new Set<string>();
  const firstCell = /^\|\s*`([a-z0-9-]+\/[a-z0-9-]+)`\s*\|/gm;
  const fieldRow = /^\|\s*\*\*Rule ID\*\*\s*\|\s*`([a-z0-9-]+\/[a-z0-9-]+)`\s*\|/gm;
  for (const re of [firstCell, fieldRow]) {
    for (const m of body.matchAll(re)) ids.add(m[1]);
  }
  return [...ids];
}

/** Rule IDs the spec documents in a rule table that the catalog does not declare. */
export function specOrphanRuleIds(meta: CatalogMeta): string[] {
  const pair = readPair(meta);
  if (!pair) return [];
  const declared = new Set(pair.ids);
  return specDocumentedRuleIds(pair.body).filter((id) => !declared.has(id));
}
