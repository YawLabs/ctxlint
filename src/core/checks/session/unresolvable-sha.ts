import { getGit, isGitRepo } from '../../../utils/git.js';
import { projectDirMatchesPath } from '../../session-parser.js';
import type { LintIssue, SessionContext } from '../../types.js';

/**
 * Flag a memory that cites a git SHA which no longer resolves in the repo.
 *
 * `session/stale-memory` covers memories referencing dead PATHS. Memories also
 * accumulate SHA citations -- "CI was removed in 1b18b85", "landed as
 * `fc750e4`" -- and those rot faster than paths: a squash-merge invalidates
 * every SHA on the branch at once, and a rebase invalidates them silently. An
 * agent that reads such a memory and runs `git show <sha>` gets
 * `fatal: bad object` and has to re-derive the history it was told.
 *
 * The precision problem is that SHA-shaped is not SHA. Real memory files on a
 * working machine are full of hex-shaped tokens that are NOT commits:
 *
 *   originSessionId: 77bde817-610b-4f82-971d-1c2452b07917   (UUID)
 *   image `sha256:7e7b3ab9`                                 (digest prefix)
 *   product_ids: 939941, 1045755                            (decimal ids)
 *   `beadfaced` in the theme                                (hex-looking word)
 *
 * None of those resolve, so a resolve-only rule reports every one of them.
 * Two guards make the rule quiet enough to ship:
 *
 *   1. A CITATION CUE must precede the token on the same line ("commit",
 *      "SHA", "HEAD", "landed in", "reverted", ...). Prose that merely
 *      contains hex is not a commit claim.
 *   2. The shape filters below drop UUID members, digests, decimal ids and
 *      version fragments before any git call.
 *
 * Only then does `git cat-file -t` decide. Resolution -- not the pattern -- is
 * what makes the finding true, which is why a repo-less scan reports nothing
 * rather than guessing.
 *
 * Deliberately out of scope: MISATTRIBUTION. The motivating instance cited a
 * SHA that DOES resolve but is not the commit that made the change. Detecting
 * that means comparing the commit's diff against the surrounding prose claim --
 * a genuinely different, much fuzzier rule that must not be smuggled in here.
 */

/** SHA-shaped token: 7-40 hex characters. */
const HEX_TOKEN = /\b[0-9a-f]{7,40}\b/g;

/** Full UUIDs, removed before extraction -- their groups are hex-shaped. */
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * Words that make a hex token a COMMIT CLAIM rather than incidental hex. Must
 * appear within CUE_WINDOW characters before the token, on the same line.
 */
const CITATION_CUE =
  /\b(commit|commits|committed|sha|revision|revs?|git|head|tag|tagged|branch|pr|landed|merged|shipped|introduced|reverted|cherry-?picked|backported|fixed|removed|added|renamed|bumped|released)\b/i;

/** How far back on the line a cue counts. */
const CUE_WINDOW = 80;

/** Prefixes that mark the token as a digest or colour, not a commit. */
const DIGEST_PREFIX = /(sha\d{3}|md5|blake\d*|crc\d*)\s*[:=]\s*$/i;

/**
 * Cap on distinct SHAs resolved per run. Each `git cat-file` is a subprocess
 * (20-80ms on Windows) and session checks already read transcripts; an
 * unbounded scan of a large memory corpus would dominate the audit.
 */
const MAX_RESOLVE = 40;

/** Strip fenced code blocks -- a SHA inside a fence is sample input, not a claim. */
function stripFences(text: string): string {
  const lines = text.split('\n');
  let inFence = false;
  return lines
    .map((line) => {
      if (line.trimStart().startsWith('```')) {
        inFence = !inFence;
        return '';
      }
      return inFence ? '' : line;
    })
    .join('\n');
}

/** A candidate SHA citation with enough context to report it. */
interface Citation {
  sha: string;
  /** The line it was found on, trimmed for the detail block. */
  context: string;
}

export function extractShaCitations(text: string): Citation[] {
  const out: Citation[] = [];
  const seen = new Set<string>();

  for (const rawLine of stripFences(text).split('\n')) {
    // Drop whole UUIDs first: every one contributes an 8- and a 12-char hex
    // run that would otherwise be extracted (memory frontmatter carries an
    // `originSessionId` UUID on essentially every file).
    const line = rawLine.replace(UUID, ' ');
    HEX_TOKEN.lastIndex = 0;
    for (const m of line.matchAll(HEX_TOKEN)) {
      const sha = m[0];
      const start = m.index ?? 0;
      const before = line.slice(0, start);
      const after = line.slice(start + sha.length);

      // Pure decimal is an id, a timestamp or a version -- not worth the
      // subprocess, and a real all-digit SHA is rare enough that silence wins.
      if (/^\d+$/.test(sha)) continue;
      // `#a1b2c3ff` colour, `0xdeadbeef` literal.
      if (/[#]$/.test(before) || /0x$/i.test(before)) continue;
      // `sha256:7e7b3ab9`.
      if (DIGEST_PREFIX.test(before)) continue;
      // Adjacent to a hyphen or dot on either side: a UUID remnant, a hashed
      // filename (`main-3f9a2bc.js`), or a dotted version fragment.
      if (/[-.]$/.test(before) && /[\w]$/.test(before.slice(0, -1))) continue;
      if (/^[-.][0-9a-z]/i.test(after)) continue;
      // Part of a longer path segment.
      if (/[/\\]$/.test(before) && /^[/\\]/.test(after)) continue;

      const window = before.slice(-CUE_WINDOW);
      if (!CITATION_CUE.test(window)) continue;

      if (seen.has(sha)) continue;
      seen.add(sha);
      out.push({ sha, context: rawLine.trim().slice(0, 160) });
    }
  }
  return out;
}

export async function checkUnresolvableSha(ctx: SessionContext): Promise<LintIssue[]> {
  const projectMemories = ctx.memories.filter((m) =>
    projectDirMatchesPath(m.projectDir, ctx.currentProject),
  );
  if (projectMemories.length === 0) return [];

  // Resolution is the whole rule. Without a repo there is nothing to resolve
  // against, so report nothing rather than falling back to the shape.
  if (!(await isGitRepo(ctx.currentProject))) return [];
  const git = getGit(ctx.currentProject);

  const resolvedCache = new Map<string, boolean>();
  let budget = MAX_RESOLVE;

  async function resolves(sha: string): Promise<boolean | null> {
    const cached = resolvedCache.get(sha);
    if (cached !== undefined) return cached;
    if (budget <= 0) return null; // over budget -- treat as undecided, stay silent
    budget--;
    let ok: boolean;
    try {
      const type = await git.raw(['cat-file', '-t', sha]);
      ok = type.trim().length > 0;
    } catch {
      ok = false;
    }
    resolvedCache.set(sha, ok);
    return ok;
  }

  const issues: LintIssue[] = [];

  for (const mem of projectMemories) {
    const dead: Citation[] = [];
    for (const cite of extractShaCitations(mem.content)) {
      const ok = await resolves(cite.sha);
      if (ok === false) dead.push(cite);
    }
    if (dead.length === 0) continue;

    const name = mem.name || mem.filePath.split(/[/\\]/).pop() || 'unknown';
    const list = dead.map((d) => d.sha).join(', ');
    issues.push({
      severity: 'warning',
      check: 'session-unresolvable-sha',
      ruleId: 'session-unresolvable-sha/unresolvable-sha',
      line: 0,
      message: `Memory "${name}" cites ${dead.length} commit(s) that do not resolve in this repository: ${list}`,
      detail: dead.map((d) => `${d.sha}: ${d.context}`).join('\n'),
      suggestion:
        `Re-resolve the citation and update ${mem.filePath}. A squash-merge or rebase ` +
        'rewrites SHAs, so a memory written before the merge points at a commit that no ' +
        'longer exists -- cite the landed commit, or the PR number, which survives the rewrite.',
    });
  }

  return issues;
}
