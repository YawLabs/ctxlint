import { resolve } from 'node:path';
import type { LintIssue, SessionContext } from '../../types.js';

const CONSECUTIVE_THRESHOLD = 3;
const CYCLE_REPEAT_THRESHOLD = 2;
const MAX_CYCLE_LENGTH = 3;
// findCyclicPatterns is O(N^2 * MAX_CYCLE_LENGTH). On a populated workstation
// history.jsonl can grow to 100k+ entries; 100k^2 is ~10B comparisons per
// cycle length and will wedge the session-audit tool. Bound the input.
const MAX_HISTORY_ENTRIES = 5000;

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
          (r) =>
            r.startIdx <= start &&
            r.startIdx + r.cycle.length * r.repeats >= cycleEnd,
        );
        if (!alreadyCovered) {
          results.push({ cycle, repeats, startIdx: start });
        }
      }
    }
  }

  return results;
}

/**
 * Detect agent looping patterns in session history:
 * - Same command run 3+ times consecutively
 * - Cyclic patterns (A,B,A,B or A,B,C,A,B,C)
 */
export async function checkLoopDetection(ctx: SessionContext): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];
  const currentNorm = normalizeProject(ctx.currentProject);

  // Filter to current project entries, sorted by timestamp. Cap to the most
  // recent MAX_HISTORY_ENTRIES before running the O(N^2) cycle scan -- a fresh
  // loop is captured in the tail, so older entries don't add signal.
  const filtered = ctx.history
    .filter((e) => normalizeProject(e.project) === currentNorm)
    .sort((a, b) => a.timestamp - b.timestamp);
  const entries =
    filtered.length > MAX_HISTORY_ENTRIES ? filtered.slice(-MAX_HISTORY_ENTRIES) : filtered;

  if (entries.length < CONSECUTIVE_THRESHOLD) return issues;

  const displays = entries.map((e) => e.display);

  // Check for consecutive repeats
  const repeats = findConsecutiveRepeats(displays);
  for (const { command, count } of repeats) {
    const truncated = command.length > 80 ? command.slice(0, 77) + '...' : command;
    issues.push({
      severity: 'warning',
      check: 'session-loop-detection',
      ruleId: 'session-loop-detection/consecutive-repeat',
      line: 0,
      message: `Command run ${count} times consecutively: "${truncated}"`,
      suggestion:
        'An agent may be looping on this command. Check history.jsonl for context on what went wrong',
    });
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

  return issues;
}
