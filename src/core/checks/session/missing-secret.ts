import { resolve, basename } from 'node:path';
import type { LintIssue, SessionContext } from '../../types.js';

/** Normalize a path for equality comparison across Windows/POSIX. */
function normalizePath(p: string): string {
  return resolve(p).replace(/\\/g, '/').toLowerCase();
}

const SECRET_SET_PATTERN = /gh\s+secret\s+set\s+(\S+)\s+(?:--repo\s+(\S+)|.*-b\s+)/;
const SECRET_SET_SIMPLE = /gh\s+secret\s+set\s+(\S+)/;

interface SecretRecord {
  name: string;
  repo?: string;
  project: string;
}

/**
 * Detect secrets set via `gh secret set` in agent history.
 * Flag repos in the same org that are missing a secret siblings have.
 */
export async function checkMissingSecret(ctx: SessionContext): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];
  const secrets: SecretRecord[] = [];

  // Extract all `gh secret set` commands from history
  for (const entry of ctx.history) {
    const match = entry.display.match(SECRET_SET_PATTERN) || entry.display.match(SECRET_SET_SIMPLE);
    if (!match) continue;

    secrets.push({
      name: match[1],
      repo: match[2],
      project: entry.project,
    });
  }

  if (secrets.length === 0) return issues;

  // Group secrets by name
  const byName = new Map<string, Set<string>>();
  for (const s of secrets) {
    if (!byName.has(s.name)) byName.set(s.name, new Set());
    // Track which project directories have this secret set
    byName.get(s.name)!.add(s.project);
    // Also track by --repo flag if present
    if (s.repo) byName.get(s.name)!.add(s.repo);
  }

  // Check if current project is missing any secret that 2+ siblings have.
  // Use path equality (normalized) — earlier substring matching false-positived
  // when a sibling directory name contained the current project's basename
  // (e.g. `ctxlint-fork` matching a `ctxlint` current via basename contains).
  const currentNorm = normalizePath(ctx.currentProject);
  const currentBase = basename(currentNorm);

  for (const [secretName, projects] of byName) {
    const normalizedProjects = [...projects].map(normalizePath);

    // Current project "has" the secret if a history entry's project path
    // equals the current project path, OR if a --repo flag value equals
    // the current project's basename (gh secret set --repo owner/REPO_BASE).
    const currentHas = normalizedProjects.some((p) => {
      if (p === currentNorm) return true;
      // --repo values look like "owner/repo"; compare last segment to basename.
      const lastSegment = p.split('/').pop() || '';
      return lastSegment === currentBase;
    });

    if (currentHas) continue;

    // Need at least 2 other projects to have it. Match by sibling path or
    // by sibling basename (for --repo flag values).
    const siblingMatches = ctx.siblings.filter((sib) => {
      const sibNorm = normalizePath(sib.path);
      const sibBase = basename(sibNorm);
      return normalizedProjects.some((p) => {
        if (p === sibNorm) return true;
        const lastSegment = p.split('/').pop() || '';
        return lastSegment === sibBase;
      });
    });

    if (siblingMatches.length >= 2) {
      const sibNames = siblingMatches.map((s) => s.name).join(', ');
      issues.push({
        severity: 'error',
        check: 'session-missing-secret',
        ruleId: 'session/missing-secret',
        line: 0,
        message: `GitHub secret "${secretName}" is set on ${siblingMatches.length} sibling repos (${sibNames}) but not on this project`,
        suggestion: `Run: gh secret set ${secretName} --repo <owner>/<repo>`,
        detail: `Found in agent history: ${siblingMatches.length} sibling repos have this secret configured`,
      });
    }
  }

  return issues;
}
