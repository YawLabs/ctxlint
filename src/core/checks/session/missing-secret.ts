import { resolve, basename } from 'node:path';
import type { LintIssue, SessionContext, SiblingRepo } from '../../types.js';

/** Normalize a path for equality comparison across Windows/POSIX. */
function normalizePath(p: string): string {
  return resolve(p).replace(/\\/g, '/').toLowerCase();
}

// Locate the `gh secret set` invocation, then capture `--repo owner/repo`
// separately so the flag binds regardless of where it sits on the line. The
// old single regex required `--repo` immediately after NAME, so
// `gh secret set NAME -b "val" --repo org/repo` (body before flag) silently
// dropped the repo binding.
const SECRET_SET_PREFIX = /gh\s+secret\s+set\s+/;
const REPO_FLAG_PATTERN = /--repo\s+(\S+)/;
// Flags that take a value; their value token must be skipped when hunting for
// the secret NAME, so a flag-first ordering like `gh secret set --repo org/foo
// NAME -b x` doesn't capture `--repo` (or `org/foo`) as the name.
const VALUE_FLAGS = new Set(['--repo', '-R', '-b', '--body', '--app', '--env']);

/**
 * Extract the secret NAME from a `gh secret set ...` command. Returns the first
 * non-flag token after `set`, skipping known flag+value pairs (e.g. `--repo
 * org/foo`, `-b xxx`) and bare flags. Returns undefined if no NAME is present.
 */
function extractSecretName(display: string): string | undefined {
  const prefixMatch = display.match(SECRET_SET_PREFIX);
  if (!prefixMatch) return undefined;
  const rest = display.slice(prefixMatch.index! + prefixMatch[0].length);
  const tokens = rest.split(/\s+/).filter((t) => t.length > 0);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok.startsWith('-')) return tok;
    // A flag: if it carries a value (and isn't written as `--flag=value`),
    // skip the following token too.
    if (VALUE_FLAGS.has(tok) && !tok.includes('=')) i++;
  }
  return undefined;
}

/** The repo name from a `--repo` value, dropping any `owner/` segment. */
function repoBasename(repoSpec: string): string {
  return (repoSpec.split('/').pop() || repoSpec).toLowerCase();
}

/**
 * Does a `--repo owner/repo` (or bare `repo`) spec name this sibling? When the
 * spec carries an owner segment, match the full owner/repo against the
 * sibling's gitOrg/gitRemoteUrl so same-basename repos in different orgs
 * (orgA/ci vs orgB/ci) don't collide. Bare specs fall back to basename.
 */
function repoMatchesSibling(repoSpec: string, sib: SiblingRepo): boolean {
  const slash = repoSpec.indexOf('/');
  const sibBase = basename(normalizePath(sib.path));
  if (slash === -1) {
    // No owner segment — basename match is all we have.
    return repoBasename(repoSpec) === sibBase;
  }
  const owner = repoSpec.slice(0, slash).toLowerCase();
  const repoName = repoSpec.slice(slash + 1).toLowerCase();
  if (repoName !== sibBase) return false;
  // Repo name agrees. If the sibling carries git metadata, require the owner to
  // agree too so same-basename repos in different orgs (orgA/ci vs orgB/ci)
  // don't collide. Prefer gitOrg; otherwise scan the remote URL for
  // `owner/repo`. If the sibling has no git metadata at all there's no org to
  // disambiguate on, so fall back to the basename match we already confirmed.
  if (sib.gitOrg) return sib.gitOrg.toLowerCase() === owner;
  if (sib.gitRemoteUrl) {
    return sib.gitRemoteUrl.toLowerCase().includes(`${owner}/${repoName}`);
  }
  return true;
}

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
    const name = extractSecretName(entry.display);
    if (!name) continue;

    // Capture `--repo` independently of where it appears on the line, so a
    // body-before-flag ordering still binds the repo.
    const repoMatch = entry.display.match(REPO_FLAG_PATTERN);

    secrets.push({
      name,
      repo: repoMatch ? repoMatch[1] : undefined,
      project: entry.project,
    });
  }

  if (secrets.length === 0) return issues;

  // Group secrets by name. Track project paths and `--repo owner/repo` specs
  // separately: paths match siblings by normalized-path equality, while repo
  // specs match by owner/repo identity (full owner-qualified when an owner
  // segment is present) so `orgA/ci` and `orgB/ci` don't collide.
  const byName = new Map<string, { projects: Set<string>; repos: Set<string> }>();
  for (const s of secrets) {
    if (!byName.has(s.name)) byName.set(s.name, { projects: new Set(), repos: new Set() });
    const bucket = byName.get(s.name)!;
    bucket.projects.add(s.project);
    if (s.repo) bucket.repos.add(s.repo);
  }

  // Check if current project is missing any secret that 2+ siblings have.
  // Use path equality (normalized) — earlier substring matching false-positived
  // when a sibling directory name contained the current project's basename
  // (e.g. `ctxlint-fork` matching a `ctxlint` current via basename contains).
  const currentNorm = normalizePath(ctx.currentProject);
  const currentBase = basename(currentNorm);

  for (const [secretName, { projects, repos }] of byName) {
    const normalizedProjects = [...projects].map(normalizePath);
    const repoSpecs = [...repos];

    // Current project "has" the secret if a history entry's project path
    // equals the current project path, OR if a --repo flag value names this
    // project's basename (gh secret set --repo owner/REPO_BASE — the current
    // project has no remote owner to compare against, so basename is all we
    // can match on here).
    const currentHas =
      normalizedProjects.some((p) => p === currentNorm) ||
      repoSpecs.some((r) => repoBasename(r) === currentBase);

    if (currentHas) continue;

    // Need at least 2 other projects to have it. A sibling matches if a
    // history project path equals its path, OR a --repo spec names it. For
    // owner-qualified specs (owner/repo) match the full owner/repo against the
    // sibling's git remote/org; for bare names fall back to basename.
    const siblingMatches = ctx.siblings.filter((sib) => {
      const sibNorm = normalizePath(sib.path);
      if (normalizedProjects.some((p) => p === sibNorm)) return true;
      return repoSpecs.some((r) => repoMatchesSibling(r, sib));
    });

    if (siblingMatches.length >= 2) {
      const sibNames = siblingMatches.map((s) => s.name).join(', ');
      issues.push({
        severity: 'error',
        check: 'session-missing-secret',
        ruleId: 'session-missing-secret/missing-secret',
        line: 0,
        message: `GitHub secret "${secretName}" is set on ${siblingMatches.length} sibling repos (${sibNames}) but not on this project`,
        suggestion: `Run: gh secret set ${secretName} --repo <owner>/<repo>`,
        detail: `Found in agent history: ${siblingMatches.length} sibling repos have this secret configured`,
      });
    }
  }

  return issues;
}
