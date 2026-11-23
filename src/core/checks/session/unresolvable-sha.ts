import { basename } from 'node:path';
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
 * rather than guessing. And a failed resolution is not always "does not
 * resolve", so three more cases stay silent:
 *
 *   - An AMBIGUOUS short SHA: git found several objects with that prefix, so
 *     the commit exists.
 *   - A SHALLOW or PARTIAL clone: history is missing by design, so absence
 *     proves nothing.
 *   - A SHA the surrounding text attributes to ANOTHER repo ("fixed in
 *     yaw-mcp commit abc1234", "org/other@abc1234"): it was never meant to
 *     resolve here.
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

/** Characters of context kept on each side of a cited SHA. */
const CONTEXT_BEFORE = 36;
const CONTEXT_AFTER = 28;

/** A candidate SHA citation with enough context to report it. */
interface Citation {
  sha: string;
  /** The SHA with a short stretch of its line on either side, for the detail. */
  context: string;
  /** The text before the SHA within the cue window, for the other-repo test. */
  window: string;
}

export function extractShaCitations(text: string): Citation[] {
  const out: Citation[] = [];
  const seen = new Set<string>();

  for (const rawLine of stripFences(text).split('\n')) {
    // Drop whole UUIDs first: every one contributes an 8- and a 12-char hex
    // run that would otherwise be extracted (memory frontmatter carries an
    // `originSessionId` UUID on essentially every file).
    const line = rawLine.replace(UUID, ' ');
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
      // A memory line can be a paragraph; the finding needs the SHA and the
      // few words that cite it, not the rest of what the memory says.
      const head = before.length > CONTEXT_BEFORE ? `...${before.slice(-CONTEXT_BEFORE)}` : before;
      const tail = after.length > CONTEXT_AFTER ? `${after.slice(0, CONTEXT_AFTER)}...` : after;
      out.push({ sha, context: `${head}${sha}${tail}`.trim(), window });
    }
  }
  return out;
}

/**
 * What a failed `git cat-file -t` means. git reports an ambiguous prefix as
 * "short object ID <sha> is ambiguous" (then "Not a valid object name"); the
 * commit exists, the citation is just too short to name it uniquely.
 */
export function classifyResolveError(message: string): 'ambiguous' | 'missing' {
  return /\bis ambiguous\b/i.test(message) ? 'ambiguous' : 'missing';
}

/**
 * What may sit between a repo name and the SHA it owns: `@` (`yaw-mcp@sha`),
 * or a commit/sha cue (`yaw-mcp commit sha`, `yaw-mcp's sha sha`). Anchored at
 * the end of the window, so the name has to be right before the SHA.
 */
const REPO_TO_SHA = String.raw`(?:'s)?(?:\s*@\s*|\s+(?:commit|sha)\s+)$`;

/**
 * A forge commit URL ending right before the SHA: `github.com/o/repo/commit/`,
 * GitLab's `/-/commit/` (with nested groups), `/commits/`, `/tree/`, `/blob/`
 * and a PR's `/pull/12/commits/`. Captures the repo segment, minus `.git`.
 */
const COMMIT_URL =
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\/(?:[\w.-]+\/)*?([\w.-]+?)(?:\.git)?(?:\/-)?\/(?:commits?|tree|blob|pull\/\d+\/commits)\/$/;

/**
 * True when the text just before a SHA attributes it to a different repo: a
 * sibling's name, or an `owner/repo` spec whose repo is not this one, directly
 * followed by `@` or a commit/sha cue and then the SHA, or a commit URL for a
 * repo other than this one. A repo named anywhere else in the window ("Unlike
 * yaw-mcp, CI here was removed in commit ...") or a file path (`src/cli.ts
 * commit ...`) leaves the citation pointing here.
 */
function namesOtherRepo(window: string, ctx: SessionContext): boolean {
  const current = basename(ctx.currentProject.replace(/\\/g, '/')).toLowerCase();
  const lower = window.toLowerCase();
  const url = COMMIT_URL.exec(lower);
  if (url) return url[1] !== current;
  for (const sib of ctx.siblings) {
    const name = sib.name.toLowerCase();
    if (!name || name === current) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?:^|[^\\w/.-])${escaped}${REPO_TO_SHA}`).test(lower)) return true;
  }
  const spec = new RegExp(String.raw`(?:^|[\s(])([\w.-]+)\/([\w.-]+)${REPO_TO_SHA}`).exec(lower);
  if (spec) {
    // `src/cli.ts`, `docs/notes.md`: a file path, not a repo.
    const fileLike = (seg: string) => /\.[a-z0-9]+$/.test(seg);
    if (!fileLike(spec[1]) && !fileLike(spec[2]) && spec[2] !== current) return true;
  }
  return false;
}

/** True for a shallow or partial clone, where history is incomplete by design. */
async function incompleteHistory(git: ReturnType<typeof getGit>): Promise<boolean> {
  try {
    if ((await git.raw(['rev-parse', '--is-shallow-repository'])).trim() === 'true') return true;
  } catch {
    // Too old a git to answer: fall through to the partial-clone probe.
  }
  try {
    const partial = await git.raw(['config', '--get', 'extensions.partialClone']);
    if (partial.trim()) return true;
  } catch {
    // `git config --get` exits 1 when the key is unset.
  }
  return false;
}

/**
 * `maxResolve` overrides the lookup budget; tests use it to reach the cap
 * without spawning dozens of git processes.
 */
export async function checkUnresolvableSha(
  ctx: SessionContext,
  { maxResolve = MAX_RESOLVE }: { maxResolve?: number } = {},
): Promise<LintIssue[]> {
  const projectMemories = ctx.memories.filter((m) =>
    projectDirMatchesPath(m.projectDir, ctx.currentProject),
  );
  if (projectMemories.length === 0) return [];

  // Resolution is the whole rule. Without a repo there is nothing to resolve
  // against, so report nothing rather than falling back to the shape.
  if (!(await isGitRepo(ctx.currentProject))) return [];
  const git = getGit(ctx.currentProject);
  // A shallow or partial clone is missing commits by design; a miss there
  // says nothing about whether the memory's citation is stale.
  if (await incompleteHistory(git)) return [];

  const resolvedCache = new Map<string, boolean>();
  let budget = maxResolve;
  let undecided = 0;

  async function resolves(sha: string): Promise<boolean | null> {
    const cached = resolvedCache.get(sha);
    if (cached !== undefined) return cached;
    if (budget <= 0) return null; // over budget -- undecided, stays silent
    budget--;
    let ok: boolean;
    try {
      const type = await git.raw(['cat-file', '-t', sha]);
      ok = type.trim().length > 0;
    } catch (err) {
      // An ambiguous prefix names several existing objects: not dead.
      ok = classifyResolveError(err instanceof Error ? err.message : String(err)) === 'ambiguous';
    }
    resolvedCache.set(sha, ok);
    return ok;
  }

  const pending: Array<{ mem: (typeof projectMemories)[number]; dead: Citation[] }> = [];

  for (const mem of projectMemories) {
    const dead: Citation[] = [];
    for (const cite of extractShaCitations(mem.content)) {
      if (namesOtherRepo(cite.window, ctx)) continue;
      const ok = await resolves(cite.sha);
      if (ok === null) undecided++;
      else if (!ok) dead.push(cite);
    }
    if (dead.length > 0) pending.push({ mem, dead });
  }

  // Said on every finding, since any of them may be one of several.
  const budgetNote =
    undecided > 0
      ? `\n${undecided} more citation(s) were not checked: the lookup budget of ${maxResolve} per run was reached.`
      : '';

  const issues: LintIssue[] = [];
  for (const { mem, dead } of pending) {
    const name = mem.name || mem.filePath.split(/[/\\]/).pop() || 'unknown';
    const list = dead.map((d) => d.sha).join(', ');
    issues.push({
      severity: 'warning',
      check: 'session-unresolvable-sha',
      ruleId: 'session-unresolvable-sha/unresolvable-sha',
      line: 0,
      message: `Memory "${name}" cites ${dead.length} commit(s) that do not resolve in this repository: ${list}`,
      detail: dead.map((d) => `${d.sha}: ${d.context}`).join('\n') + budgetNote,
      suggestion:
        `Re-resolve the citation and update ${mem.filePath}. A squash-merge or rebase ` +
        'rewrites SHAs, so a memory written before the merge points at a commit that no ' +
        'longer exists -- cite the landed commit, or the PR number, which survives the rewrite.',
    });
  }

  return issues;
}
