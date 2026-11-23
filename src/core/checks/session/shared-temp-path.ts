import { resolve } from 'node:path';
import { readProjectTranscript, truncationNote } from '../../transcript.js';
import type { LintIssue, SessionContext } from '../../types.js';

/** One scanned line: a command string plus where it came from. */
interface Scanned {
  display: string;
  timestamp: number;
}

/** Where a qualifying path was seen: the verb that touched it, and the path as written. */
interface Touch {
  verb: string;
  path: string;
}

/**
 * Flag a fixed, non-session-scoped temp path that is WRITTEN and later READ back.
 *
 * Why this is a real defect and not tidiness: `/tmp` is process-global, and under
 * Git Bash on Windows it is shared across every concurrent agent session on the
 * machine. An agent that backs a file up to a literal path, mutates the original,
 * then restores from that path is racing every other session that picked the same
 * obvious name.
 *
 * The motivating incident: an agent measuring a packaging change ran
 *
 *     node -e '...writeFileSync("/tmp/pkg.bak", readFileSync("package.json"))...'
 *     npm pack --dry-run
 *     cp /tmp/pkg.bak package.json
 *
 * Between the write and the `cp`, a concurrent session working a sibling repo
 * used the same `/tmp/pkg.bak`. The restore wrote a DIFFERENT package's manifest
 * into the repo -- wrong name, version, bin and dependencies -- and it was caught
 * only because the harness surfaced the external modification. A release from
 * that tree would have published under the wrong identity.
 *
 * The pair is the signal, not either half. A scratch file that is never read back
 * cannot be clobbered into the workspace, and a read with no matching write is
 * consuming something another tool produced deliberately. Both halves in ONE
 * session is the motivating shape: the clobber comes from a concurrent session
 * in between, which the transcript of this one never shows.
 *
 * Deliberately NOT flagged:
 *   - `mktemp` / `mktemp -d` output, and any path carrying a PID, `$$`, a random
 *     suffix or a session id (a literal UUID counts). Those are the CORRECT form
 *     and appear constantly in the same transcripts; flagging them would bury
 *     the real finding.
 *   - Write-only or read-only use of a fixed temp path.
 *   - Paths under a per-session scratch directory the harness assigns
 *     (`<tmp>/claude/<id>/<session>/scratchpad/...`, or any `scratchpad`
 *     segment under a temp root).
 */

/**
 * Fixed temp roots, matched against the normalized path (forward slashes,
 * lowercase). `%TEMP%`/`$TMPDIR`/`$TEMP` included, and the absolute Windows
 * temp dirs in both drive and Git Bash spellings: same sharing semantics.
 */
const TEMP_ROOTS: RegExp[] = [
  /^\/tmp\//,
  /^\/var\/tmp\//,
  /^\$\{?(?:tmpdir|temp|tmp)\}?\//,
  /^%(?:temp|tmp)%\//,
  /^(?:[a-z]:|\/[a-z])\/users\/[^/]+\/appdata\/local\/temp\//,
  /^(?:[a-z]:|\/[a-z])\/windows\/temp\//,
];

/**
 * A path component that makes the name unique per run. `mktemp` is handled
 * separately because it appears as a command, not as part of the path.
 */
const SCOPED_MARKERS = [
  '$$',
  '$pid',
  '${pid}',
  'mktemp',
  '$random',
  '${random}',
  '$session',
  '${session}',
  '$uuid',
  '${uuid}',
];

/** A literal session id / UUID, or a long random hex run, anywhere in the path. */
const SCOPED_LITERAL = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}/;

/** A harness-assigned per-session scratch directory under a temp root. */
const SCRATCH_DIR = /\/scratchpad(?:\/|$)/;

/**
 * Commands that put bytes at a path, each with the verb reported for it.
 * `copy`/`move` are the cmd.exe spellings -- agent transcripts on Windows use
 * them interchangeably with cp/mv, and omitting them means the write half of a
 * pair goes unseen on exactly the platform where the shared-`/tmp` hazard is
 * worst (Git Bash maps a single temp dir across every concurrent session).
 */
const WRITE_PATTERNS: Array<[RegExp, string]> = [
  [/>\s*(\S+)/, '>'], // shell redirect
  [/\bcp\s+\S+\s+(\S+)/, 'cp'], // cp src dest
  [/\bmv\s+\S+\s+(\S+)/, 'mv'],
  [/\bcopy\s+\S+\s+(\S+)/, 'copy'],
  [/\bmove\s+\S+\s+(\S+)/, 'move'],
  [/\btee\s+(\S+)/, 'tee'],
  [/writeFileSync\(\s*['"`]([^'"`]+)/, 'writeFileSync'],
  [/\bcurl\b[^|]*-o\s+(\S+)/, 'curl -o'],
];

/** Commands that consume bytes from a path. */
const READ_PATTERNS: Array<[RegExp, string]> = [
  [/\bcp\s+(\S+)\s+\S+/, 'cp'],
  [/\bcopy\s+(\S+)\s+\S+/, 'copy'],
  [/\bcat\s+(\S+)/, 'cat'],
  [/\btype\s+(\S+)/, 'type'],
  [/\bsource\s+(\S+)/, 'source'],
  [/\b(?:tail|head)\s+(?:-\S+\s+(?:\d+\s+)?)*(\S+)/, 'tail/head'],
  // `grep [flags] PATTERN FILE`: the first word after the pattern.
  [/\bgrep\s+(?:-\S+\s+)*\S+\s+(\S+)/, 'grep'],
  // `diff A B`: either side is a read.
  [/\bdiff\s+(?:-\S+\s+)*(\S+)/, 'diff'],
  [/\bdiff\s+(?:-\S+\s+)*\S+\s+(\S+)/, 'diff'],
  // Running a script from the path executes whatever bytes are there.
  [/\b(?:node|bash|sh|python3?)\s+(?:-\S+\s+)*(\S+)/, 'run'],
  [/\breadFileSync\(\s*['"`]([^'"`]+)/, 'readFileSync'],
  // Input redirect. `(?!<)` excludes heredocs (`<<'EOF'`), and the leading
  // boundary plus the restricted character class keep it from matching a `<`
  // that is part of a comparison, an HTML fragment, or another operator --
  // a bare /<\s*(\S+)/ matched unrelated text in real transcripts.
  [/(?:^|\s)<(?!<)\s*([^\s<>|&;]+)/, '<'],
];

/**
 * Strip surrounding quotes and trailing shell punctuation. Quotes are stripped
 * REPEATEDLY: a token lifted out of an already-quoted command arrives as
 * `""$TMPDIR/x""`, and trimming a single layer leaves the stray pair in the
 * reported path. A token taken from `(cmd > /tmp/x;)` or `cat /tmp/x)` carries
 * the `;`/`)` that ends the subshell, which is not part of the name.
 */
function unquote(raw: string): string {
  let s = raw;
  let prev: string;
  do {
    prev = s;
    s = s.replace(/^[('"`]+|['"`;),&|]+$/g, '');
  } while (s !== prev);
  return s;
}

function normalize(raw: string): string {
  return unquote(raw).replace(/\\/g, '/').toLowerCase();
}

/** True when the path sits under a shared temp root with no per-run component. */
function isFixedTempPath(candidate: string): boolean {
  const p = normalize(candidate);
  const root = TEMP_ROOTS.map((r) => p.match(r)?.[0]).find((m) => m !== undefined);
  if (!root) return false;
  // A bare root ("/tmp/") is a directory reference, not a file we can clobber.
  if (p.length <= root.length) return false;
  if (SCRATCH_DIR.test(p) || SCOPED_LITERAL.test(p)) return false;
  return !SCOPED_MARKERS.some((m) => p.includes(m.toLowerCase()));
}

function extract(line: string, patterns: Array<[RegExp, string]>): Touch[] {
  const found: Touch[] = [];
  for (const [re, verb] of patterns) {
    for (const m of line.matchAll(new RegExp(re, 'g'))) {
      if (m[1]) found.push({ verb, path: m[1] });
    }
  }
  return found;
}

/**
 * A project path for comparison. Case-folded on win32, where the drive letter
 * (and any segment) may be cased differently by ctxlint and by the harness --
 * the transcript side folds the same way (`projectDirCandidates`).
 */
function normalizeProject(p: string): string {
  const slashed = resolve(p).replace(/\\/g, '/');
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
}

export async function checkSharedTempPath(ctx: SessionContext): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];

  // Written paths, keyed by normalized path -> how it was written. A later
  // write just refreshes the origin; what matters is that a write PRECEDED the
  // read, which is what makes the value clobberable by another session.
  const written = new Map<string, Touch>();
  const reported = new Set<string>();

  // The commands that matter are the ones the AGENT ran, and those live in the
  // session transcript -- `history.jsonl` records only what the user typed, so
  // scanning it alone would leave this rule inert against the very incident it
  // was written for. User-typed lines are still included (a `!`-prefixed shell
  // command carries exactly the same hazard), but only this project's: a pair
  // typed in another repo is that repo's finding. Project-less entries are
  // dropped -- `resolve('')` is the linter's cwd, which would attach them to
  // whichever project is being linted.
  const currentNorm = normalizeProject(ctx.currentProject);
  const transcript = await readProjectTranscript(ctx.currentProject);
  const scanned: Scanned[] = [
    ...transcript.events
      .filter((e) => e.kind === 'command')
      .map((e) => ({ display: e.text, timestamp: e.timestamp })),
    ...ctx.history
      .filter((h) => h.project !== '' && normalizeProject(h.project) === currentNorm)
      .map((h) => ({ display: h.display, timestamp: h.timestamp })),
  ];

  // Scanned in order so "written, then read" is a real ordering rather than
  // mere co-occurrence.
  const ordered = scanned.sort((a, b) => a.timestamp - b.timestamp);
  const note = truncationNote(transcript);

  for (const entry of ordered) {
    const line = entry.display;
    // A `mktemp` anywhere on the line means the path in play is per-run, even if
    // a literal temp path also appears (e.g. `T=$(mktemp) && cp /tmp/x "$T"`).
    const usesMktemp = /\bmktemp\b/.test(line);

    for (const read of extract(line, READ_PATTERNS)) {
      if (usesMktemp || !isFixedTempPath(read.path)) continue;
      const key = normalize(read.path);
      const origin = written.get(key);
      if (!origin || reported.has(key)) continue;
      reported.add(key);
      // Only the verb and the path are echoed. The rest of a command line can
      // carry tokens, bodies or URLs, and the finding needs none of it.
      issues.push({
        severity: 'error',
        check: 'session-shared-temp-path',
        ruleId: 'session-shared-temp-path/shared-temp-path',
        line: 0,
        message: `Fixed temp path "${unquote(read.path)}" is written and later read back`,
        detail:
          `Written by: ${origin.verb} ${unquote(origin.path)}\n` +
          `Read by:    ${read.verb} ${unquote(read.path)}` +
          (note ? `\n${note}` : ''),
        suggestion:
          'Use a per-run path instead: `T=$(mktemp)` in shell, or a session-scoped ' +
          'scratch directory. A literal path under a shared temp root can be ' +
          'overwritten by any concurrent session between the write and the read, ' +
          'and a restore then puts the wrong bytes into your workspace.',
      });
    }

    for (const write of extract(line, WRITE_PATTERNS)) {
      if (usesMktemp || !isFixedTempPath(write.path)) continue;
      written.set(normalize(write.path), write);
    }
  }

  return issues;
}
