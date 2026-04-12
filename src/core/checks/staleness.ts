import * as path from 'node:path';
import { isGitRepo, getFileLastModified, getCommitsSince } from '../../utils/git.js';
import type { ParsedContextFile, LintIssue } from '../types.js';

const WARNING_DAYS = 30;
const INFO_DAYS = 14;

export async function checkStaleness(
  file: ParsedContextFile,
  projectRoot: string,
): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];

  if (!(await isGitRepo(projectRoot))) {
    return issues;
  }

  const relativePath = path.relative(projectRoot, file.filePath).replace(/\\/g, '/');
  const lastModified = await getFileLastModified(projectRoot, relativePath);

  if (!lastModified || isNaN(lastModified.getTime())) {
    return issues; // Can't determine last modified, skip
  }

  const daysSinceUpdate = Math.floor((Date.now() - lastModified.getTime()) / (1000 * 60 * 60 * 24));

  if (daysSinceUpdate < INFO_DAYS) {
    return issues; // Recently updated, skip
  }

  // Check referenced paths for activity since context file was last updated.
  // Only use the specific file paths — adding parent directories would double-count
  // commits since git log on a directory includes all files within it.
  const referencedPaths = new Set<string>();
  for (const ref of file.references.paths) {
    referencedPaths.add(ref.value);
  }

  let totalCommits = 0;
  let mostActiveRef = '';
  let mostActiveCommits = 0;

  for (const refPath of referencedPaths) {
    const commits = await getCommitsSince(projectRoot, refPath, lastModified);
    totalCommits += commits;
    if (commits > mostActiveCommits) {
      mostActiveCommits = commits;
      mostActiveRef = refPath;
    }
  }

  if (totalCommits === 0) {
    return issues; // No changes to referenced paths
  }

  const isStale = daysSinceUpdate >= WARNING_DAYS;
  const severity = isStale ? 'warning' : 'info';

  issues.push({
    severity,
    check: 'staleness',
    ruleId: isStale ? 'staleness/stale' : 'staleness/aging',
    line: 1,
    message: `Last updated ${daysSinceUpdate} days ago. ${mostActiveRef} has ${mostActiveCommits} commits since.`,
    suggestion: 'Review and update this context file to reflect recent changes.',
    detail: `${totalCommits} total commits to referenced paths since last update.`,
  });

  return issues;
}
