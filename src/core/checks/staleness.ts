import * as path from 'node:path';
import { isOutsideRelative } from '../../utils/fs.js';
import { isGitRepo, isShallowRepo, getFileLastCommit, getCommitActivity } from '../../utils/git.js';
import type { ParsedContextFile, LintIssue } from '../types.js';

const WARNING_DAYS = 30;
const INFO_DAYS = 14;

/**
 * Turn a doc ref into the projectRoot-relative, forward-slash key the git
 * layer counts against, or null when it resolves outside the project root
 * (git cannot have logged it from here).
 *
 * `./` and `../` refs are relative to the CONTEXT FILE's own directory
 * (mirrors paths.ts / redundancy.ts): `./src/x.ts` in packages/a/CLAUDE.md is
 * packages/a/src/x.ts, not the root's src/x.ts. Every other relative ref is
 * project-root-relative. Absolute refs pass through (the git layer
 * relativizes them). A trailing `/` (directory ref) is preserved.
 */
function toRootKey(ref: string, file: ParsedContextFile, projectRoot: string): string | null {
  const normalized = ref.replace(/\\/g, '/');
  if (path.isAbsolute(ref)) return ref;
  const trailingSlash = normalized.endsWith('/');
  let rel: string;
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('./') ||
    normalized.startsWith('../')
  ) {
    const abs = path.resolve(path.dirname(file.filePath), normalized);
    rel = path.relative(projectRoot, abs);
    if (isOutsideRelative(rel)) return null;
    rel = rel.replace(/\\/g, '/');
  } else {
    rel = path.posix.normalize(normalized);
    if (isOutsideRelative(rel)) return null;
  }
  // The project root itself carries no information (every commit touches it).
  if (rel === '' || rel === '.') return null;
  rel = rel.replace(/\/+$/, '');
  return trailingSlash ? `${rel}/` : rel;
}

export async function checkStaleness(
  file: ParsedContextFile,
  projectRoot: string,
): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];

  if (!(await isGitRepo(projectRoot))) {
    return issues;
  }
  // A shallow clone (CI's `--depth 1`) truncates history at a graft whose
  // boundary commit appears to touch every file, so "last updated" and
  // "commits since" are both artefacts of the clone depth, not of the repo.
  // Skip rather than report either a false "stale" or a false "fresh".
  if (await isShallowRepo(projectRoot)) {
    return issues;
  }

  const relativePath = path.relative(projectRoot, file.filePath).replace(/\\/g, '/');
  const lastCommit = await getFileLastCommit(projectRoot, relativePath);

  if (!lastCommit || isNaN(lastCommit.date.getTime())) {
    return issues; // Can't determine last modified, skip
  }

  const daysSinceUpdate = Math.floor(
    (Date.now() - lastCommit.date.getTime()) / (1000 * 60 * 60 * 24),
  );

  if (daysSinceUpdate < INFO_DAYS) {
    return issues; // Recently updated, skip
  }

  // Check referenced paths for activity since context file was last updated.
  // Only use the specific file paths — adding parent directories would double-count
  // commits since git log on a directory includes all files within it.
  const referencedPaths = new Set<string>();
  // Counting keys are resolved / synthesized forms, not necessarily strings
  // the user wrote (a `./x` ref in a nested doc becomes `pkg/x`; a glob
  // becomes its static directory prefix). Map each key back to the original
  // ref so the issue message never cites a reference that appears nowhere in
  // the context file. Several refs can collapse to one key (src/*.ts +
  // src/lib/*.ts -> src/); the first one encountered names the message.
  const labelByKey = new Map<string, string>();
  const addKey = (key: string | null, label: string) => {
    if (!key) return;
    referencedPaths.add(key);
    if (!labelByKey.has(key)) labelByKey.set(key, label);
  };
  for (const ref of file.references.paths) {
    const normalized = ref.value.replace(/\\/g, '/');
    if (normalized.includes('*')) {
      // getCommitActivity matches exact paths and trailing-slash directory
      // prefixes only — glob metacharacters compare literally, so a raw glob
      // ref silently counts 0 and a file whose only refs are globs would
      // never go stale. Substitute the glob's static directory prefix
      // (src/**/*.ts -> src/). The dir ref can over-count relative to the
      // glob's exact match set (and to the no-parent-dirs rule above) —
      // acceptable for a staleness heuristic. A glob whose static prefix
      // resolves to the project root itself (`**`, `./**/*.ts` in a root
      // doc) has nothing to correlate against, so it's skipped.
      const staticSegments: string[] = [];
      for (const segment of normalized.split('/')) {
        if (segment.includes('*')) break;
        staticSegments.push(segment);
      }
      const prefix = staticSegments.join('/');
      if (prefix) addKey(toRootKey(`${prefix}/`, file, projectRoot), ref.value);
      continue;
    }
    addKey(toRootKey(ref.value, file, projectRoot), ref.value);
  }

  if (referencedPaths.size === 0) {
    return issues; // Nothing to correlate against
  }

  // Batch all referenced paths into one git log call. Previously each ref
  // spawned its own subprocess — expensive on Windows where fork+exec is
  // 20-80ms. 30 refs × 50ms = 1.5s of pure process overhead per stale file.
  // Counted from the doc's own last commit EXCLUSIVE (`<hash>..HEAD`): a
  // `--since=<date>` window is inclusive, so a commit that updated the doc
  // and its referenced code together counted as activity "since" itself.
  const { perPath, distinctCommits } = await getCommitActivity(projectRoot, [...referencedPaths], {
    commit: lastCommit.hash,
  });

  let mostActiveRef = '';
  let mostActiveCommits = 0;

  for (const [refPath, commits] of perPath) {
    if (commits > mostActiveCommits) {
      mostActiveCommits = commits;
      mostActiveRef = refPath;
    }
  }

  if (distinctCommits === 0) {
    return issues; // No changes to referenced paths
  }

  const isStale = daysSinceUpdate >= WARNING_DAYS;
  const severity = isStale ? 'warning' : 'info';
  // Counting stays keyed on the resolved / synthesized key; only the rendered
  // label swaps back to the ref the user actually wrote.
  const mostActiveLabel = labelByKey.get(mostActiveRef) ?? mostActiveRef;

  issues.push({
    severity,
    check: 'staleness',
    ruleId: isStale ? 'staleness/stale' : 'staleness/aging',
    line: 1,
    message: `Last updated ${daysSinceUpdate} days ago. ${mostActiveLabel} has ${mostActiveCommits} commits since.`,
    suggestion: 'Review and update this context file to reflect recent changes.',
    // Distinct commits: one commit touching three referenced paths is one
    // change, not three.
    detail: `${distinctCommits} total commit${distinctCommits === 1 ? '' : 's'} to referenced paths since last update.`,
  });

  return issues;
}
