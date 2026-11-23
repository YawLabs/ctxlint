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

/** A project path for comparison; case-folded on win32, where drive case varies. */
function normalizeProject(p: string): string {
  const slashed = resolve(p).replace(/\\/g, '/');
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
}

/**
 * Programs whose name at the head of an entry marks it as a shell command.
 * Deliberately excludes words that double as English (`make`, `go`, `find`,
 * `yes`, `test`, `open`): those are in AMBIGUOUS_PROGRAMS instead.
 */
const PROGRAMS = new Set([
  'git',
  'gh',
  'npm',
  'pnpm',
  'yarn',
  'npx',
  'bun',
  'bunx',
  'node',
  'deno',
  'tsx',
  'python',
  'python3',
  'pip',
  'pip3',
  'uv',
  'poetry',
  'cargo',
  'rustc',
  'docker',
  'kubectl',
  'helm',
  'terraform',
  'ls',
  'cd',
  'cat',
  'rm',
  'cp',
  'mv',
  'mkdir',
  'touch',
  'echo',
  'grep',
  'rg',
  'sed',
  'awk',
  'curl',
  'wget',
  'ssh',
  'scp',
  'tsc',
  'vitest',
  'jest',
  'pytest',
  'eslint',
  'biome',
  'prettier',
  'ruff',
  'claude',
  'codex',
  'aider',
  'mvn',
  'gradle',
  'dotnet',
  'brew',
  'apt',
  'sudo',
  'chmod',
  'tail',
  'head',
  'ps',
  'kill',
  'pwsh',
  'powershell',
  'bash',
  'sh',
  'zsh',
]);

/** Program names that are also everyday words; they need a command-shaped rest. */
const AMBIGUOUS_PROGRAMS = new Set(['make', 'go', 'find', 'test', 'open', 'sort', 'which']);

/** Words that mark the rest of an entry as prose rather than arguments. */
const PROSE_WORDS =
  /\b(?:the|a|an|it|this|that|me|please|sure|and|to|of|for|with|so|is|are|faster|better)\b/i;

/**
 * True when a history entry is a command rather than conversation. History
 * holds what the user TYPED -- mostly prose ("continue", "yes", "fix the
 * tests") -- and repeating a prompt is not a looping command. Counted:
 * bash-mode lines (`!cmd`), slash commands (`/name`), and lines whose first
 * word (after `VAR=value` assignments) is a known program or an explicit path
 * to one (`./build.sh`).
 */
function isCommandShaped(display: string): boolean {
  const line = display.trim();
  if (line.startsWith('!')) return line.length > 1;
  if (/^\/[A-Za-z][\w:-]*(?:\s|$)/.test(line)) return true;
  const words = line.split(/\s+/);
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=\S*$/.test(words[i])) i++;
  const head = words[i];
  if (!head) return false;
  if (/^\.{1,2}[\\/]/.test(head)) return true;
  const program = head.toLowerCase();
  if (PROGRAMS.has(program)) return true;
  if (AMBIGUOUS_PROGRAMS.has(program)) return !PROSE_WORDS.test(words.slice(i + 1).join(' '));
  return false;
}

/** A `NAME=value` shell assignment word. */
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=\S*$/;
/** Flags whose value is a credential (`curl -u user:pw`, `--token x`). */
const CREDENTIAL_FLAG = /^(?:-u|-p|--user|--password|--passwd|--token|--auth|--api-key|--secret)$/;

/**
 * The part of a command shown in a finding: its first three words, at most 60
 * characters. Enough to recognise the command; its arguments can carry
 * secrets (`-b <token>`) or the rest of a pasted prompt, and the finding does
 * not need them. Credentials that can still fall inside those words are
 * masked: every `NAME=value` assignment is shown as `NAME=...` (leading ones
 * do not count toward the three words), URL userinfo as `scheme://...@`, and
 * the value of a credential flag (`-u user:pw`, `--token=x`) as `...`.
 */
function commandHead(command: string): string {
  let words = command.trim().split(/\s+/);
  const bang = words[0]?.startsWith('!') ? '!' : '';
  if (bang) words = [words[0].slice(1), ...words.slice(1)].filter((w) => w !== '');
  let i = 0;
  while (i < words.length && ASSIGNMENT.test(words[i])) i++;
  const shown = words.slice(0, i + 3).map((w, k, arr) => {
    if (k > 0 && CREDENTIAL_FLAG.test(arr[k - 1])) return '...';
    const assign = ASSIGNMENT.exec(w);
    if (assign) return `${assign[1]}=...`;
    const flag = /^(-{1,2}[A-Za-z][\w-]*)=/.exec(w);
    if (flag && CREDENTIAL_FLAG.test(flag[1])) return `${flag[1]}=...`;
    return w.replace(/(\b[A-Za-z][\w+.-]*:\/\/)[^/\s@]*@/g, '$1...@');
  });
  let head = bang + shown.join(' ');
  let cut = words.length > i + 3;
  if (head.length > 60) {
    head = head.slice(0, 57);
    cut = true;
  }
  return cut ? `${head}...` : head;
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

/** Mints a value equal to no other, standing in for a non-command entry. */
let breakerSeq = 0;

function splitAtGaps(group: HistoryEntry[]): string[][] {
  const segments: string[][] = [];
  let seg: string[] = [];
  for (let k = 0; k < group.length; k++) {
    if (k > 0 && group[k].timestamp - group[k - 1].timestamp > SESSION_GAP_MS) {
      segments.push(seg);
      seg = [];
    }
    // A conversational prompt stays in the sequence as a unique breaker: it
    // separates the commands on either side (a prompt between two runs means
    // the user stepped in) but can never match anything, so it neither forms
    // a run nor a cycle of its own.
    const d = group[k].display;
    seg.push(isCommandShaped(d) ? d : `\u0000prompt:${++breakerSeq}`);
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
  return {
    severity: 'warning',
    check: 'session-loop-detection',
    ruleId: 'session-loop-detection/consecutive-repeat',
    line: 0,
    message: `Command run ${count} times consecutively: "${commandHead(command)}"`,
    suggestion:
      'An agent may be looping on this command. Check history.jsonl for context on what went wrong',
  };
}

/**
 * Detect agent looping patterns in session history:
 * - Same command run 3+ times consecutively
 * - Cyclic patterns (A,B,A,B or A,B,C,A,B,C)
 *
 * Only command-shaped entries take part (see `isCommandShaped`); prompts stay
 * in the sequence as breakers that match nothing. Findings echo only the
 * command's head (`commandHead`), never its arguments.
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
      const cycleStr = cycle.map(commandHead).join(' -> ');
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
