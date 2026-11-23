import { statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { isOutsideRelative } from '../../../utils/fs.js';
import { COMMIT_SUMMARY_LINE, readProjectTranscript, truncationNote } from '../../transcript.js';
import type { TranscriptEvent } from '../../transcript.js';
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
 *
 * Only writes inside the project count: a session's scratchpad, its memory
 * files under the Claude config dir and edits to sibling repos are not this
 * repo's working tree. Each session accumulates on its own, so a new session
 * starts empty.
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
 * True when the command's output carried git's commit summary line. The
 * transcript reader sets `commitLanded` from the FULL output, so a long hook
 * or push log around the line cannot hide it; the excerpt test is a fallback
 * for events built without that field.
 */
function commitLanded(ev: TranscriptEvent): boolean {
  return ev.commitLanded === true || COMMIT_SUMMARY_LINE.test(ev.outputExcerpt ?? '');
}

/** True when `arg`, read relative to the project, names an existing file. */
function namesFile(arg: string, project: string): boolean {
  try {
    return statSync(resolve(project, arg)).isFile();
  } catch {
    return false;
  }
}

/**
 * How a command moves the session off its current branch:
 *   - 'created': it creates one (`checkout -b/-B/--orphan`, `switch
 *     -c/-C/--create/--orphan`, `worktree add`). The work is going elsewhere,
 *     so the count resets at once.
 *   - 'maybe': it may switch to an existing one (`switch <x>`, `checkout
 *     <x>`). Whether it did is decided by the session's next branch stamp:
 *     `git checkout package.json` (a restore without `--`), `git checkout
 *     HEAD~1 <file>` and switching TO main while on main all leave it on the
 *     default branch.
 * `git checkout -- <path>`, `git checkout .`, a glob, or an argument naming an
 * existing file restore files instead and are never a branch move.
 */
function branchMove(cmd: string, project: string): 'created' | 'maybe' | null {
  let move: 'created' | 'maybe' | null = null;
  for (const m of cmd.matchAll(/\bgit\s+(checkout|switch|worktree\s+add)\b([^;&|\n]*)/g)) {
    if (m[1] !== 'checkout' && m[1] !== 'switch') return 'created'; // worktree add
    const args = m[2].trim().split(/\s+/).filter(Boolean);
    const creates =
      m[1] === 'checkout'
        ? ['-b', '-B', '--orphan']
        : ['-c', '-C', '--create', '--force-create', '--orphan'];
    if (args.some((a) => creates.includes(a) || creates.some((c) => a.startsWith(`${c}=`)))) {
      return 'created';
    }
    if (m[1] === 'checkout' && args.includes('--')) continue;
    const operands = args.filter((a) => !a.startsWith('-') || a === '-');
    if (operands.length === 0) continue;
    if (operands.some((a) => namesFile(a, project))) continue;
    if (m[1] === 'checkout' && operands.some((a) => a === '.' || a.includes('*'))) continue;
    move = 'maybe';
  }
  return move;
}

/** True when `path` lies inside `project` (separator- and, on win32, case-insensitive). */
function inProject(path: string, project: string): boolean {
  const norm = (p: string) => {
    const slashed = resolve(p).replace(/\\/g, '/');
    return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
  };
  const rel = relative(norm(project), norm(path));
  return rel !== '' && !isOutsideRelative(rel);
}

interface Accumulation {
  pending: Set<string>;
  /** The default branch the pending writes landed on. */
  branch: string;
  firstWrite: string;
  sessionId: string;
}

export async function checkDefaultBranchAccumulation(ctx: SessionContext): Promise<LintIssue[]> {
  const read = await readProjectTranscript(ctx.currentProject);
  if (read.events.length === 0) return [];

  // Reads are left out of the walk. The branch tracker below takes the stamp of
  // EVERY event it passes, so interleaving Reads would let a Read's stamp decide
  // which branch a later unstamped write is attributed to.
  const ordered = read.events
    .filter((e) => e.kind !== 'file-read')
    .sort((a, b) => a.timestamp - b.timestamp);

  // Per session: the last branch stamp seen, and the writes accumulated since
  // that session last committed or branched away.
  const branchOf = new Map<string, string>();
  const acc = new Map<string, Accumulation>();
  const accOf = (ev: TranscriptEvent): Accumulation => {
    let a = acc.get(ev.sessionId);
    if (!a) {
      a = { pending: new Set(), branch: '', firstWrite: '', sessionId: ev.sessionId };
      acc.set(ev.sessionId, a);
    }
    return a;
  };

  // Sessions that ran a possible branch switch whose outcome the next branch
  // stamp has not yet shown.
  const awaitingStamp = new Set<string>();

  for (const ev of ordered) {
    // The branch stamp rides along on records the harness emits; keep the last
    // one seen so a record without a stamp doesn't blank the state.
    if (ev.gitBranch) {
      // The stamps are ground truth for a `switch <x>` / `checkout <x>`: it
      // moved the session only if the next stamp is off the default branch.
      if (awaitingStamp.delete(ev.sessionId) && !DEFAULT_BRANCHES.has(ev.gitBranch)) {
        accOf(ev).pending.clear();
      }
      branchOf.set(ev.sessionId, ev.gitBranch);
    }
    const branch = branchOf.get(ev.sessionId) ?? '';

    if (ev.kind === 'command') {
      // A commit that failed (hook rejected it, nothing staged) landed
      // nothing, so the pending set stands; a failed checkout moved nothing.
      // The error flag covers the whole chain, though: in `git commit && git
      // push` with the push rejected, the commit's own `[branch sha]` line
      // shows it landed.
      if (ev.isError === true && !(isCommit(ev.text) && commitLanded(ev))) continue;
      if (isCommit(ev.text)) {
        // A commit lands the shared working tree, whichever session typed it.
        for (const a of acc.values()) a.pending.clear();
        continue;
      }
      const move = branchMove(ev.text, ctx.currentProject);
      if (move === 'created') accOf(ev).pending.clear();
      // Checked from the NEXT stamp on: this record's own stamp was taken
      // before the command ran.
      else if (move === 'maybe') awaitingStamp.add(ev.sessionId);
      continue;
    }

    if (ev.kind !== 'file-write') continue;
    if (!inProject(ev.text, ctx.currentProject)) continue;
    // Only default-branch writes accumulate. A write with no branch stamp at
    // all is not attributable, so it is not counted -- a false clean beats a
    // finding pinned to a branch we never actually observed.
    if (!DEFAULT_BRANCHES.has(branch)) continue;
    const a = accOf(ev);
    if (a.pending.size === 0) {
      a.firstWrite = ev.text;
      a.branch = branch;
    }
    a.pending.add(ev.text);
  }

  // One finding: the largest uncommitted accumulation any session ended with.
  const worst = [...acc.values()].sort((x, y) => y.pending.size - x.pending.size)[0];
  if (!worst || worst.pending.size < THRESHOLD) return [];

  const sample = [...worst.pending].slice(0, 5);
  const note = truncationNote(read);
  return [
    {
      severity: 'warning',
      check: 'session-default-branch-accumulation',
      ruleId: 'session-default-branch-accumulation/default-branch-accumulation',
      line: 0,
      message: `${worst.pending.size} files edited on '${worst.branch}' with no intervening commit`,
      detail:
        `First uncommitted write: ${worst.firstWrite}\n` +
        `Sample: ${sample.join(', ')}${worst.pending.size > sample.length ? ', ...' : ''}` +
        (note ? `\n${note}` : ''),
      suggestion:
        'Commit as you go, or move the work to a topic branch (`git checkout -b`). ' +
        'A large uncommitted delta on a shared default branch is hard to review and, ' +
        'when other agent sessions share the checkout, one `git stash` or ' +
        '`git checkout --` away from being lost.',
    },
  ];
}
