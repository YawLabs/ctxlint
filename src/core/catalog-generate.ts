/**
 * Catalog -> spec coverage check (item 3, TS side).
 *
 * The count-header / README generation logic lives in
 * `scripts/generate-catalog-prose.mjs` (one source of truth, runnable from
 * build.mjs and from the catalog-generate test via child_process --check).
 * This module holds only the cross-check that JSON Schema + count-regen don't
 * cover: every rule ID declared in a catalog must appear somewhere in its
 * companion spec body. Rich per-rule tables stay hand-authored, so this catches
 * a rule added to the catalog but never documented (or removed from the spec).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { REPO_ROOT, type CatalogMeta } from './catalog-meta.js';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function specCoverageGaps(meta: CatalogMeta): string[] {
  if (!meta.spec) return [];
  const body = fs.readFileSync(path.join(REPO_ROOT, meta.spec), 'utf-8');
  const catalog = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, meta.catalog), 'utf-8')) as {
    rules: Array<{ id: string }>;
  };
  // Token-bounded membership test rather than a raw substring scan. A bare
  // `body.includes(id)` lets a dropped rule ID hide behind a documented longer
  // superstring (e.g. `tokens/aggregate` inside `tier-tokens/aggregate`, or
  // `frontmatter/missing` inside `frontmatter/missing-field`) -- the gap goes
  // unreported. Requiring a word/path boundary on both sides (no surrounding
  // `\w`, `/`, or `-`) means the id must appear as its own token to count.
  return catalog.rules
    .map((r) => r.id)
    .filter((id) => {
      const re = new RegExp(`(?<![\\w/-])${escapeRegex(id)}(?![\\w/-])`);
      return !re.test(body);
    });
}
