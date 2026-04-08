import { resolve } from 'node:path';
import type { LintIssue, SessionContext } from '../../types.js';

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

  // Check if current project is missing any secret that 2+ siblings have
  const currentNorm = resolve(ctx.currentProject).replace(/\\/g, '/');

  for (const [secretName, projects] of byName) {
    // Check if current project already has this secret
    const currentHas = [...projects].some(
      (p) =>
        p.includes(currentNorm) ||
        currentNorm.includes(p.replace(/\\/g, '/')) ||
        p.includes(resolve(ctx.currentProject).split(/[/\\]/).pop() || ''),
    );

    if (currentHas) continue;

    // Need at least 2 other projects to have it
    const siblingMatches = ctx.siblings.filter((sib) =>
      [...projects].some(
        (p) =>
          p.replace(/\\/g, '/').includes(sib.name) ||
          p.includes(sib.path),
      ),
    );

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
