import * as path from 'node:path';
import { isGitRepo, getFileLastModified, getCommitsSinceBatch } from '../../utils/git.js';
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
  // Synthesized glob prefixes are internal counting keys, not strings the
  // user wrote. Map each key back to the original glob ref so the issue
  // message never cites a reference that appears nowhere in the context
  // file. Several globs can collapse to one prefix (src/*.ts + src/lib/*.ts
  // -> src/); the first one encountered names the message.
  const globByPrefix = new Map<string, string>();
  for (const ref of file.references.paths) {
    const normalized = ref.value.replace(/\\/g, '/');
    if (normalized.includes('*')) {
      // getCommitsSinceBatch matches exact paths and trailing-slash directory
      // prefixes only — glob metacharacters compare literally, so a raw glob
      // ref silently counts 0 and a file whose only refs are globs would
      // never go stale. Substitute the glob's static directory prefix
      // (src/**/*.ts -> src/). The dir ref can over-count relative to the
      // glob's exact match set (and to the no-parent-dirs rule above) —
      // acceptable for a staleness heuristic. A glob with no static prefix
      // has nothing to correlate against, so it's skipped.
      const staticSegments: string[] = [];
      for (const segment of normalized.split('/')) {
        // A bare `.` segment (./**/*.ts) carries no directory information:
        // keeping it would synthesize the key `./`, which survives
        // path.posix.normalize unchanged and never matches git's
        // root-relative output -- the silent-zero this branch exists to fix.
        if (segment === '.') continue;
        if (segment.includes('*')) break;
        staticSegments.push(segment);
      }
      const prefix = staticSegments.join('/');
      if (prefix) {
        const key = `${prefix}/`;
        referencedPaths.add(key);
        if (!globByPrefix.has(key)) globByPrefix.set(key, ref.value);
      }
      continue;
    }
    referencedPaths.add(ref.value);
  }

  if (referencedPaths.size === 0) {
    return issues; // Nothing to correlate against
  }

  // Batch all referenced paths into one git log call. Previously each ref
  // spawned its own subprocess — expensive on Windows where fork+exec is
  // 20-80ms. 30 refs × 50ms = 1.5s of pure process overhead per stale file.
  const counts = await getCommitsSinceBatch(projectRoot, [...referencedPaths], lastModified);

  let totalCommits = 0;
  let mostActiveRef = '';
  let mostActiveCommits = 0;

  for (const [refPath, commits] of counts) {
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
  // Counting stays keyed on the synthesized prefix; only the rendered label
  // swaps back to the glob the user actually wrote.
  const mostActiveLabel = globByPrefix.get(mostActiveRef) ?? mostActiveRef;

  issues.push({
    severity,
    check: 'staleness',
    ruleId: isStale ? 'staleness/stale' : 'staleness/aging',
    line: 1,
    message: `Last updated ${daysSinceUpdate} days ago. ${mostActiveLabel} has ${mostActiveCommits} commits since.`,
    suggestion: 'Review and update this context file to reflect recent changes.',
    detail: `${totalCommits} total commits to referenced paths since last update.`,
  });

  return issues;
}
