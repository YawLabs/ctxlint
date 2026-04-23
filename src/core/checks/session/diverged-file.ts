import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
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

/**
 * Jaccard similarity over non-trivial lines. Returns |A ∩ B| / |A ∪ B| in
 * [0, 1], where 1 means identical. An earlier "matches / max(|A|, |B|)"
 * variant was asymmetric (linesA as an array counted duplicates, linesB as a
 * set did not) and inflated/deflated similarity based on file size rather
 * than actual shared content.
 */
function calculateOverlap(a: string, b: string): number {
  const linesA = new Set(
    a
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 3),
  );
  const linesB = new Set(
    b
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 3),
  );

  if (linesA.size === 0 && linesB.size === 0) return 1;
  if (linesA.size === 0 || linesB.size === 0) return 0;

  let intersection = 0;
  for (const line of linesA) {
    if (linesB.has(line)) intersection++;
  }
  const unionSize = linesA.size + linesB.size - intersection;
  return intersection / unionSize;
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

    let currentContent: string;
    try {
      currentContent = await readFile(currentPath, 'utf-8');
    } catch {
      continue;
    }

    // Check which siblings have this same file
    const diverged: Array<{ sibling: string; overlap: number }> = [];

    for (const sib of ctx.siblings) {
      const sibPath = join(sib.path, fileName);
      if (!existsSync(sibPath)) continue;

      try {
        const sibContent = await readFile(sibPath, 'utf-8');
        const overlap = calculateOverlap(currentContent, sibContent);

        // Flag if overlap is between 20% and 90% — similar but diverged
        // Below 20% means intentionally different, above 90% means close enough
        if (overlap >= 0.2 && overlap < 0.9) {
          diverged.push({ sibling: sib.name, overlap: Math.round(overlap * 100) });
        }
      } catch {
        continue;
      }
    }

    if (diverged.length > 0) {
      const details = diverged.map((d) => `${d.sibling} (${d.overlap}% overlap)`).join(', ');
      issues.push({
        severity: 'warning',
        check: 'session-diverged-file',
        ruleId: 'session/diverged-file',
        line: 0,
        message: `${fileName} has diverged from sibling repos: ${details}`,
        suggestion: `Compare with sibling versions to identify unintentional drift`,
        detail: `Files with the same name across sibling repos should be kept in sync when they serve the same purpose`,
      });
    }
  }

  return issues;
}
