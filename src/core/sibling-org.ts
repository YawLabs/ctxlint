import type { SiblingRepo } from './types.js';

/**
 * The GitHub owner of a repo's `origin` remote, or undefined when it has no
 * git metadata, no origin, or a non-GitHub remote. Siblings carry the same
 * value as `gitOrg` (see `resolveSibling` in session-scanner.ts), so checks that
 * compare a project with its siblings can keep the comparison inside one
 * organization.
 *
 * simple-git is imported lazily so tests that stub this module (and mock
 * `node:fs`) never load it.
 */
export async function currentGitOrg(projectRoot: string): Promise<string | undefined> {
  try {
    const { simpleGit } = await import('simple-git');
    const remotes = await simpleGit(projectRoot).getRemotes(true);
    const origin = remotes.find((r) => r.name === 'origin');
    return origin?.refs?.fetch?.match(/github\.com[:/]([^/]+)\//)?.[1];
  } catch {
    return undefined; // no git, or not a directory simple-git accepts
  }
}

/**
 * Siblings worth comparing this project against: those under the same GitHub
 * owner when the project has one. Repos that merely share a parent directory
 * with an unrelated owner carry unrelated conventions, and comparing against
 * them is noise. With no owner to match (no remote, non-GitHub remote) every
 * sibling is kept, since there is nothing to filter on.
 */
export function sameOrgSiblings(
  siblings: SiblingRepo[],
  currentOrg: string | undefined,
): SiblingRepo[] {
  if (!currentOrg) return siblings;
  const org = currentOrg.toLowerCase();
  return siblings.filter((s) => s.gitOrg?.toLowerCase() === org);
}
