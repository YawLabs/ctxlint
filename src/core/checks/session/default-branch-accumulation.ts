import { readProjectTranscript } from '../../transcript.js';
import type { LintIssue, SessionContext } from '../../types.js';

/**
 * Flag a session that accumulates edits on the repo's DEFAULT branch without an
 * intervening commit.
 *
 * The motivating session ran for hours across review, fix, coverage and audit
 * phases and edited 25 files. Every one of those edits landed in the working
 * tree of `main`, uncommitted, and it surfaced only during a ship-readiness
 * audit at the very end -- no git-shaped signal fired along the way.
 *
 * Two things make that worse than untidy. Repo operating instructions commonly
 * say to branch before committing on the default branch, so the end state is
 * one the session was told to avoid. And on a machine running a fleet of
 * agents -- the sibling repo this came from had 11 locked worktrees and a
 * `main` whose HEAD moved three times during a single audit -- a large
 * uncommitted delta on a shared default branch is one `git checkout --` or
 * `git stash` away from being someone else's cleanup.
 *
 * The defect is ACCUMULATION, not the first write. A one-line typo fix on
 * `main` is normal; flagging it would make the rule noise.
 */

/** Branch names treated as the shared default. */
const DEFAULT_BRANCHES = new Set(['main', 'master']);

/**
 * Distinct files written on the default branch with no commit in between
 * before this fires. Set where a session stops looking like a quick fix and
 * starts looking like a feature's worth of work parked in a shared tree.
 */
const THRESHOLD = 10;

/** A command that lands the accumulated work, resetting the count. */
function isCommit(cmd: string): boolean {
  // `git commit` in any position (chained with && or ;), but NOT
  // `git commit --dry-run`, which lands nothing.
  return /\bgit\s+commit\b/.test(cmd) && !/--dry-run\b/.test(cmd);
}

/**
 * A command that moves the session off the default branch. Once the work is on
 * a topic branch the hazard is gone, so this resets too.
 */
function isBranchAway(cmd: string): boolean {
  return /\bgit\s+(checkout\s+-b|switch\s+-c|worktree\s+add)\b/.test(cmd);
}

export async function checkDefaultBranchAccumulation(ctx: SessionContext): Promise<LintIssue[]> {
  const { events } = await readProjectTranscript(ctx.currentProject);
  if (events.length === 0) return [];

  const ordered = [...events].sort((a, b) => a.timestamp - b.timestamp);

  // Distinct paths written since the last commit / branch-away, while the
  // session was on a default branch.
  const pending = new Set<string>();
  let branch = '';
  let firstWrite = '';

  for (const ev of ordered) {
    // The branch stamp rides along on records the harness emits; keep the last
    // one seen so a record without a stamp doesn't blank the state.
    if (ev.gitBranch) branch = ev.gitBranch;

    if (ev.kind === 'command') {
      if (isCommit(ev.text) || isBranchAway(ev.text)) {
        pending.clear();
        firstWrite = '';
      }
      continue;
    }

    if (ev.kind !== 'file-write') continue;
    // Only default-branch writes accumulate. A write with no branch stamp at
    // all is not attributable, so it is not counted -- a false clean beats a
    // finding pinned to a branch we never actually observed.
    if (!DEFAULT_BRANCHES.has(branch)) continue;
    if (pending.size === 0) firstWrite = ev.text;
    pending.add(ev.text);
  }

  if (pending.size < THRESHOLD) return [];

  const sample = [...pending].slice(0, 5);
  return [
    {
      severity: 'warning',
      check: 'session-default-branch-accumulation',
      ruleId: 'session-default-branch-accumulation/default-branch-accumulation',
      line: 0,
      message: `${pending.size} files edited on '${branch}' with no intervening commit`,
      detail:
        `First uncommitted write: ${firstWrite}\n` +
        `Sample: ${sample.join(', ')}${pending.size > sample.length ? ', ...' : ''}`,
      suggestion:
        'Commit as you go, or move the work to a topic branch (`git checkout -b`). ' +
        'A large uncommitted delta on a shared default branch is hard to review and, ' +
        'when other agent sessions share the checkout, one `git stash` or ' +
        '`git checkout --` away from being lost.',
    },
  ];
}
