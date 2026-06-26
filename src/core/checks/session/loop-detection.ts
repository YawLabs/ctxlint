import { resolve } from 'node:path';
import type { HistoryEntry, LintIssue, SessionContext } from '../../types.js';

const CONSECUTIVE_THRESHOLD = 3;
const CYCLE_REPEAT_THRESHOLD = 2;
const MAX_CYCLE_LENGTH = 3;
// findCyclicPatterns is O(N^2 * MAX_CYCLE_LENGTH). On a populated workstation
// history.jsonl can grow to 100k+ entries; 100k^2 is ~10B comparisons per
// cycle length and will wedge the session-audit tool. Bound the input.
const MAX_HISTORY_ENTRIES = 5000;
// Entries with the same sessionId but a gap this large between them belong to
// separate working stints, not one loop. Matters most for providers that omit
// sessionId (stored as ''): all their entries share one pseudo-session, and
// without a gap break a daily one-shot command would read as a 3+ repeat.
const SESSION_GAP_MS = 30 * 60 * 1000;

function normalizeProject(p: string): string {
  return resolve(p).replace(/\\/g, '/');
}

/**
 * Detect consecutive runs of the same command.
 * Returns each run's command, repeat count, and [startIdx, endIdx) span so
 * the cyclic scan can skip spans a consecutive-repeat already covered.
 */
function findConsecutiveRepeats(
  displays: string[],
): Array<{ command: string; count: number; startIdx: number; endIdx: number }> {
  const results: Array<{ command: string; count: number; startIdx: number; endIdx: number }> = [];
  let i = 0;

  while (i < displays.length) {
    let j = i + 1;
    while (j < displays.length && displays[j] === displays[i]) j++;
    const count = j - i;
    if (count >= CONSECUTIVE_THRESHOLD) {
      results.push({ command: displays[i], count, startIdx: i, endIdx: j });
    }
    i = j;
  }

  return results;
}

/**
 * Detect short repeating cycles in a sequence.
 * E.g. [A, B, A, B] is a cycle of length 2 repeated 2 times.
 *
 * `consecutiveSpans` are the [startIdx, endIdx) ranges already reported by the
 * consecutive-repeat check. A cycle whose span overlaps one of those is
 * suppressed so a run like [A,A,A, B,A,B,A,B] doesn't report the consecutive
 * A-run a second time as part of an [A,B] cycle that reaches back into it. An
 * interleaved cycle that sits entirely after the consecutive run still fires.
 */
function findCyclicPatterns(
  displays: string[],
  consecutiveSpans: Array<{ startIdx: number; endIdx: number }>,
): Array<{ cycle: string[]; repeats: number; startIdx: number }> {
  const results: Array<{ cycle: string[]; repeats: number; startIdx: number }> = [];

  for (let cycleLen = 2; cycleLen <= MAX_CYCLE_LENGTH; cycleLen++) {
    for (let start = 0; start <= displays.length - cycleLen * CYCLE_REPEAT_THRESHOLD; start++) {
      const cycle = displays.slice(start, start + cycleLen);

      // Don't flag cycles where every element is the same (already caught by consecutive check)
      if (cycle.every((c) => c === cycle[0])) continue;

      let repeats = 1;
      let pos = start + cycleLen;
      while (pos + cycleLen <= displays.length) {
        const next = displays.slice(pos, pos + cycleLen);
        if (next.every((v, idx) => v === cycle[idx])) {
          repeats++;
          pos += cycleLen;
        } else {
          break;
        }
      }

      if (repeats >= CYCLE_REPEAT_THRESHOLD) {
        const cycleEnd = start + cycleLen * repeats;

        // Skip a cycle whose span overlaps a consecutive-repeat finding — those
        // commands were already reported once by the consecutive check.
        const overlapsConsecutive = consecutiveSpans.some(
          (s) => s.startIdx < cycleEnd && start < s.endIdx,
        );
        if (overlapsConsecutive) continue;

        // Check we haven't already reported a subsuming pattern at this position
        const alreadyCovered = results.some(
          (r) => r.startIdx <= start && r.startIdx + r.cycle.length * r.repeats >= cycleEnd,
        );
        if (!alreadyCovered) {
          results.push({ cycle, repeats, startIdx: start });
        }
      }
    }
  }

  return results;
}

function splitAtGaps(group: HistoryEntry[]): string[][] {
  const segments: string[][] = [];
  let seg: string[] = [];
  for (let k = 0; k < group.length; k++) {
    if (k > 0 && group[k].timestamp - group[k - 1].timestamp > SESSION_GAP_MS) {
      segments.push(seg);
      seg = [];
    }
    seg.push(group[k].display);
  }
  segments.push(seg);
  return segments;
}

/**
 * Split the project's history into per-session command sequences. A loop is an
 * intra-session pathology: pooling sessions would flag routine reuse (a daily
 * `claude "/release"` is 3+ repeats across weeks) and let concurrent sessions
 * -- including cross-provider ones, since claude-code and codex-cli histories
 * are merged into one pool -- interleave into phantom A,B,A,B cycles no
 * session actually ran. Sessions are keyed by provider + sessionId (sessionIds
 * are only unique within a provider), and a session's sequence is further
 * split at SESSION_GAP_MS timestamp gaps so providers that omit sessionId
 * don't pool unrelated days into one pseudo-session.
 *
 * Single-command sessions get a second, merged pass: a headless respawn loop
 * (`claude -p "cmd"` re-spawned every few seconds) produces N one-command
 * sessions, each a below-threshold segment on its own. Merging them per
 * provider -- still split at SESSION_GAP_MS, so daily one-shots stay separate
 * -- keeps that pathology detectable. The merged stream feeds only the
 * consecutive-repeat scan: unrelated one-shots interleaved in time could
 * still synthesize phantom A,B,A,B cycles no session actually ran.
 */
function toSessionSegments(entries: HistoryEntry[]): {
  sessionSegments: string[][];
  mergedOneShotSegments: string[][];
} {
  const byGroup = new Map<string, HistoryEntry[]>();
  for (const e of entries) {
    const key = `${e.provider}::${e.sessionId}`;
    const group = byGroup.get(key);
    if (group) group.push(e);
    else byGroup.set(key, [e]);
  }

  const sessionSegments: string[][] = [];
  // `entries` arrives timestamp-sorted, so per-provider insertion order keeps
  // each one-shot list chronological without a re-sort.
  const oneShotsByProvider = new Map<string, HistoryEntry[]>();
  for (const group of byGroup.values()) {
    if (group.length === 1) {
      const e = group[0];
      const list = oneShotsByProvider.get(e.provider);
      if (list) list.push(e);
      else oneShotsByProvider.set(e.provider, [e]);
      continue;
    }
    sessionSegments.push(...splitAtGaps(group));
  }

  const mergedOneShotSegments: string[][] = [];
  for (const list of oneShotsByProvider.values()) {
    mergedOneShotSegments.push(...splitAtGaps(list));
  }

  return { sessionSegments, mergedOneShotSegments };
}

function toConsecutiveRepeatIssue(command: string, count: number): LintIssue {
  const truncated = command.length > 80 ? command.slice(0, 77) + '...' : command;
  return {
    severity: 'warning',
    check: 'session-loop-detection',
    ruleId: 'session-loop-detection/consecutive-repeat',
    line: 0,
    message: `Command run ${count} times consecutively: "${truncated}"`,
    suggestion:
      'An agent may be looping on this command. Check history.jsonl for context on what went wrong',
  };
}

/**
 * Detect agent looping patterns in session history:
 * - Same command run 3+ times consecutively
 * - Cyclic patterns (A,B,A,B or A,B,C,A,B,C)
 */
export async function checkLoopDetection(ctx: SessionContext): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];
  const currentNorm = normalizeProject(ctx.currentProject);

  // Filter to current project entries, sorted by timestamp. Entries with no
  // project at all are dropped (Codex CLI occasionally writes neither
  // `project` nor `cwd`; the scanner keeps those with project '') --
  // path.resolve('') is the linter's cwd, so they would otherwise attach to
  // whichever project is being linted. Entries without a timestamp are also
  // dropped (the scanner defaults them to 0): the SESSION_GAP_MS split and
  // the one-shot merge key off real timestamps, and an all-zero
  // pseudo-session never splits, so a routine daily one-shot would read as a
  // 3+ repeat. Cap to the most recent MAX_HISTORY_ENTRIES before running the
  // O(N^2) cycle scan -- a fresh loop is captured in the tail, so older
  // entries don't add signal.
  const filtered = ctx.history
    .filter(
      (e) => e.project !== '' && e.timestamp > 0 && normalizeProject(e.project) === currentNorm,
    )
    .sort((a, b) => a.timestamp - b.timestamp);
  const entries =
    filtered.length > MAX_HISTORY_ENTRIES ? filtered.slice(-MAX_HISTORY_ENTRIES) : filtered;

  if (entries.length < CONSECUTIVE_THRESHOLD) return issues;

  const { sessionSegments, mergedOneShotSegments } = toSessionSegments(entries);

  for (const displays of sessionSegments) {
    if (displays.length < CONSECUTIVE_THRESHOLD) continue;

    // Check for consecutive repeats
    const repeats = findConsecutiveRepeats(displays);
    for (const { command, count } of repeats) {
      issues.push(toConsecutiveRepeatIssue(command, count));
    }

    // Check for cyclic patterns, skipping any whose span a consecutive-repeat
    // finding already covers (so the same commands aren't reported twice).
    const consecutiveSpans = repeats.map((r) => ({ startIdx: r.startIdx, endIdx: r.endIdx }));
    const cycles = findCyclicPatterns(displays, consecutiveSpans);
    for (const { cycle, repeats: reps } of cycles) {
      const cycleStr = cycle.map((c) => (c.length > 40 ? c.slice(0, 37) + '...' : c)).join(' -> ');
      issues.push({
        severity: 'warning',
        check: 'session-loop-detection',
        ruleId: 'session-loop-detection/cyclic-pattern',
        line: 0,
        message: `Cyclic pattern repeated ${reps} times: ${cycleStr}`,
        suggestion:
          'An agent may be stuck in a loop. Check if a context file is missing instructions for this workflow',
      });
    }
  }

  // Consecutive-repeat only on the merged one-shot stream (see
  // toSessionSegments for why cycles are excluded from it).
  for (const displays of mergedOneShotSegments) {
    if (displays.length < CONSECUTIVE_THRESHOLD) continue;
    for (const { command, count } of findConsecutiveRepeats(displays)) {
      issues.push(toConsecutiveRepeatIssue(command, count));
    }
  }

  return issues;
}
