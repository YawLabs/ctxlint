import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { jaccardSimilarityFromSets, toLineSet } from '../../../utils/similarity.js';
import { stripBom } from '../../../utils/fs.js';
import type { LintIssue, SessionContext } from '../../types.js';

/** Files worth comparing across sibling repos for consistency */
const CANONICAL_FILES = [
  'release.sh',
  '.github/workflows/ci.yml',
  '.github/workflows/release.yml',
  'biome.json',
  '.prettierrc',
  '.eslintrc.json',
  'tsconfig.json',
  '.gitignore',
];

const MIN_TOKEN_LEN = 3;

/**
 * Module-scope cache of tokenized canonical files keyed by absolute path.
 * Each entry stores the file's mtime + size so we can invalidate when the
 * file is rewritten. The cache pays off in long-running contexts (watch
 * mode, MCP server) where the same canonical pairs are re-scanned every
 * audit; without it we re-read and re-tokenize every sibling's tsconfig /
 * release.sh / etc. on every run. CLI one-shot invocations hit the cache
 * for free too — sibling counts of 5+ * 8 canonical files is enough for
 * the per-pair tokenization cost to show up in profiles.
 */
interface CacheEntry {
  mtimeMs: number;
  size: number;
  lineSet: Set<string>;
}

/**
 * LRU cap: a long-running watch / MCP-server process scanning many sibling
 * sets across many projects would otherwise grow this map without bound.
 * 256 entries is generous (8 canonical files * 32 sibling repos = 256
 * tokenized files cached in memory; well past any realistic working set,
 * far below anything that would matter for RSS).
 *
 * `Map` preserves insertion order, so promoting an entry on hit by deleting
 * and re-setting moves it to the back of the iteration order. The eviction
 * step grabs the first key (oldest) when over the cap.
 */
const CACHE_MAX_ENTRIES = 256;
const lineSetCache = new Map<string, CacheEntry>();

async function loadLineSet(absPath: string): Promise<Set<string> | null> {
  let mtimeMs: number;
  let size: number;
  try {
    const stats = await stat(absPath);
    mtimeMs = stats.mtimeMs;
    size = stats.size;
  } catch {
    return null;
  }

  const cached = lineSetCache.get(absPath);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
    // Promote to most-recently-used by re-inserting at the end of the
    // iteration order.
    lineSetCache.delete(absPath);
    lineSetCache.set(absPath, cached);
    return cached.lineSet;
  }

  let content: string;
  try {
    content = stripBom(await readFile(absPath, 'utf-8'));
  } catch {
    return null;
  }
  const lineSet = toLineSet(content, MIN_TOKEN_LEN);
  lineSetCache.set(absPath, { mtimeMs, size, lineSet });
  if (lineSetCache.size > CACHE_MAX_ENTRIES) {
    const oldest = lineSetCache.keys().next().value;
    if (oldest !== undefined) lineSetCache.delete(oldest);
  }
  return lineSet;
}

/**
 * Test-only cache reset. Vitest reuses module instances across tests, so a
 * test that mutates a fixture file would otherwise see a stale lineSet.
 */
export function resetDivergedFileCache(): void {
  lineSetCache.clear();
}

/**
 * Detect files that exist in multiple sibling repos but have diverged.
 * Helps catch drift in release scripts, CI configs, linter configs, etc.
 */
export async function checkDivergedFile(ctx: SessionContext): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];

  for (const fileName of CANONICAL_FILES) {
    const currentPath = join(ctx.currentProject, fileName);
    if (!existsSync(currentPath)) continue;

    const currentLineSet = await loadLineSet(currentPath);
    if (!currentLineSet) continue;

    // Check which siblings have this same file
    const diverged: Array<{ sibling: string; overlap: number; path: string }> = [];

    for (const sib of ctx.siblings) {
      const sibPath = join(sib.path, fileName);
      if (!existsSync(sibPath)) continue;

      const sibLineSet = await loadLineSet(sibPath);
      if (!sibLineSet) continue;

      // Two empty canonical files (e.g. empty .gitignore) are trivially in
      // sync — `bothEmptyIsIdentical: true` keeps that from emitting a 0%
      // overlap warning.
      const overlap = jaccardSimilarityFromSets(currentLineSet, sibLineSet, {
        bothEmptyIsIdentical: true,
      });

      // Flag if overlap is between 20% and 90% — similar but diverged
      // Below 20% means intentionally different, above 90% means close enough
      if (overlap >= 0.2 && overlap < 0.9) {
        diverged.push({
          sibling: sib.name,
          overlap: Math.round(overlap * 100),
          path: resolve(sibPath),
        });
      }
    }

    if (diverged.length > 0) {
      // Lowest overlap first (per the spec's 2.2 Notes): the sibling that has
      // drifted furthest is the one worth reading first.
      diverged.sort((a, b) => a.overlap - b.overlap);
      const details = diverged.map((d) => `${d.sibling} (${d.overlap}% overlap)`).join(', ');
      // Lead the detail with navigable absolute paths (mirroring
      // memory-index-overflow's `File: ...` detail) since the message is
      // basename-only and the issue carries line:0.
      const sibPaths = diverged.map((d) => `  ${d.sibling}: ${d.path}`).join('\n');
      issues.push({
        severity: 'warning',
        check: 'session-diverged-file',
        ruleId: 'session-diverged-file/diverged-file',
        line: 0,
        message: `${fileName} has diverged from sibling repos: ${details}`,
        suggestion: `Compare with sibling versions to identify unintentional drift`,
        detail: `File: ${resolve(currentPath)}\nDiverged siblings:\n${sibPaths}`,
      });
    }
  }

  return issues;
}
