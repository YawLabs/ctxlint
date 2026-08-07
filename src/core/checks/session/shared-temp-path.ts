import type { HistoryEntry, LintIssue, SessionContext } from '../../types.js';

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
 * consuming something another tool produced deliberately.
 *
 * Deliberately NOT flagged:
 *   - `mktemp` / `mktemp -d` output, and any path carrying a PID, `$$`, a random
 *     suffix or a session id. Those are the CORRECT form and appear constantly in
 *     the same transcripts; flagging them would bury the real finding.
 *   - Write-only or read-only use of a fixed temp path.
 *   - Paths under a per-session scratch directory the harness assigns.
 */

/** Fixed temp roots. `%TEMP%`/`$TMPDIR` included: same sharing semantics. */
const TEMP_ROOTS = [
  '/tmp/',
  '/var/tmp/',
  '$TMPDIR/',
  '${TMPDIR}/',
  '%TEMP%\\',
  '%TMP%\\',
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

/**
 * Commands that put bytes at a path. `copy`/`move` are the cmd.exe spellings --
 * agent transcripts on Windows use them interchangeably with cp/mv, and omitting
 * them means the write half of a pair goes unseen on exactly the platform where
 * the shared-`/tmp` hazard is worst (Git Bash maps a single temp dir across
 * every concurrent session).
 */
const WRITE_PATTERNS = [
  />\s*(\S+)/, // shell redirect
  /\bcp\s+\S+\s+(\S+)/, // cp src dest
  /\bmv\s+\S+\s+(\S+)/,
  /\bcopy\s+\S+\s+(\S+)/,
  /\bmove\s+\S+\s+(\S+)/,
  /\btee\s+(\S+)/,
  /writeFileSync\(\s*['"`]([^'"`]+)/,
  /\bcurl\b[^|]*-o\s+(\S+)/,
];

/** Commands that consume bytes from a path. */
const READ_PATTERNS = [
  /\bcp\s+(\S+)\s+\S+/,
  /\bcopy\s+(\S+)\s+\S+/,
  /\bcat\s+(\S+)/,
  /\btype\s+(\S+)/,
  /\bsource\s+(\S+)/,
  /\breadFileSync\(\s*['"`]([^'"`]+)/,
  /<\s*(\S+)/,
];

function normalize(raw: string): string {
  return raw.replace(/^['"]|['"]$/g, '').replace(/\\/g, '/').toLowerCase();
}

/** True when the path sits under a shared temp root with no per-run component. */
function isFixedTempPath(candidate: string): boolean {
  const p = normalize(candidate);
  const root = TEMP_ROOTS.map((r) => normalize(r)).find((r) => p.startsWith(r));
  if (!root) return false;
  // A bare root ("/tmp/") is a directory reference, not a file we can clobber.
  if (p.length <= root.length) return false;
  return !SCOPED_MARKERS.some((m) => p.includes(m.toLowerCase()));
}

function extract(line: string, patterns: RegExp[]): string[] {
  const found: string[] = [];
  for (const re of patterns) {
    for (const m of line.matchAll(new RegExp(re, 'g'))) {
      if (m[1]) found.push(m[1]);
    }
  }
  return found;
}

export async function checkSharedTempPath(ctx: SessionContext): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];

  // Written paths, keyed by normalized path -> the entry that wrote it. A later
  // write just refreshes the origin; what matters is that a write PRECEDED the
  // read, which is what makes the value clobberable by another session.
  const written = new Map<string, HistoryEntry>();
  const reported = new Set<string>();

  // History is scanned in order so "written, then read" is a real ordering
  // rather than mere co-occurrence.
  const ordered = [...ctx.history].sort((a, b) => a.timestamp - b.timestamp);

  for (const entry of ordered) {
    const line = entry.display;
    // A `mktemp` anywhere on the line means the path in play is per-run, even if
    // a literal temp path also appears (e.g. `T=$(mktemp) && cp /tmp/x "$T"`).
    const usesMktemp = /\bmktemp\b/.test(line);

    for (const candidate of extract(line, READ_PATTERNS)) {
      if (usesMktemp || !isFixedTempPath(candidate)) continue;
      const key = normalize(candidate);
      const origin = written.get(key);
      if (!origin || reported.has(key)) continue;
      reported.add(key);
      issues.push({
        severity: 'error',
        check: 'session-shared-temp-path',
        ruleId: 'session-shared-temp-path/shared-temp-path',
        line: 0,
        message: `Fixed temp path "${candidate}" is written and later read back`,
        detail:
          `Written by: ${origin.display.trim().slice(0, 120)}\n` +
          `Read by:    ${line.trim().slice(0, 120)}`,
        suggestion:
          'Use a per-run path instead: `T=$(mktemp)` in shell, or a session-scoped ' +
          'scratch directory. A literal path under a shared temp root can be ' +
          'overwritten by any concurrent session between the write and the read, ' +
          'and a restore then puts the wrong bytes into your workspace.',
      });
    }

    for (const candidate of extract(line, WRITE_PATTERNS)) {
      if (usesMktemp || !isFixedTempPath(candidate)) continue;
      written.set(normalize(candidate), entry);
    }
  }

  return issues;
}
