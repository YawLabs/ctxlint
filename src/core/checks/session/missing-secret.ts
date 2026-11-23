import { resolve, basename } from 'node:path';
import { readProjectTranscript, truncationNote } from '../../transcript.js';
import type { LintIssue, SessionContext, SiblingRepo } from '../../types.js';

/** Normalize a path for equality comparison across Windows/POSIX. */
function normalizePath(p: string): string {
  return resolve(p).replace(/\\/g, '/').toLowerCase();
}

/** Locates each `gh secret set` invocation on a line. */
const SECRET_SET_PREFIX = /\bgh\s+secret\s+set\b/g;
// Flags that take a value; their value token must be skipped when hunting for
// the secret NAME, so a flag-first ordering like `gh secret set --repo org/foo
// NAME -b x` doesn't capture `--repo` (or `org/foo`) as the name. NOTE: `-u`/
// `--user` is deliberately absent — it is a BOOLEAN flag, so listing it here
// would wrongly eat the real NAME in `gh secret set -u NPM_TOKEN`.
const VALUE_FLAGS = new Set([
  '--repo',
  '-R',
  '-b',
  '--body',
  '-a',
  '--app',
  '-e',
  '--env',
  '-o',
  '--org',
  '-r',
  '--repos',
  '-f',
  '--env-file',
  '-v',
  '--visibility',
]);

/**
 * Split the command text that follows `gh secret set` into shell words, up to
 * the first top-level command separator (`&&`, `||`, `;`, `|`, newline) --
 * a `--repo` on a later chained command belongs to that command, not this
 * one. Quotes, `$(...)` (nesting included) and backticks are kept inside one
 * word, so a body such as `-b $(echo x | tr a-z A-Z)` is one value rather
 * than four tokens whose second would be read as the NAME. Surrounding quotes
 * are stripped from each word.
 */
function shellWords(rest: string): string[] {
  const words: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let depth = 0;
  let tick = false;
  const flush = () => {
    if (cur) words.push(cur.replace(/^(["'])(.*)\1$/s, '$2'));
    cur = '';
  };
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (tick) {
      cur += c;
      if (c === '`') tick = false;
      continue;
    }
    if (depth > 0) {
      cur += c;
      if (c === '(') depth++;
      else if (c === ')') depth--;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === '`') {
      tick = true;
      cur += c;
    } else if (c === '$' && rest[i + 1] === '(') {
      depth = 1;
      cur += '$(';
      i++;
    } else if (c === '\n' || c === ';' || c === '|' || (c === '&' && rest[i + 1] === '&')) {
      break;
    } else if (/\s/.test(c)) {
      flush();
    } else {
      cur += c;
    }
  }
  flush();
  return words;
}

interface SecretSet {
  name: string;
  /** The `--repo`/`-R` value, when the command names one. */
  repo?: string;
}

/**
 * Parse every `gh secret set ...` on a line into its NAME and `--repo`
 * target. The NAME is the first non-flag word, skipping known flag+value
 * pairs (`--repo org/foo`, `-b xxx`) and bare flags; a command with no NAME
 * is dropped.
 */
function parseSecretSets(display: string): SecretSet[] {
  const found: SecretSet[] = [];
  for (const m of display.matchAll(SECRET_SET_PREFIX)) {
    const words = shellWords(display.slice(m.index + m[0].length));
    let name: string | undefined;
    let repo: string | undefined;
    // `--org` sets an organization secret, not a repo one: it says nothing
    // about which repo directory has the secret, so it binds nothing.
    let notRepoScoped = false;
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (!w.startsWith('-')) {
        name ??= w;
        continue;
      }
      if (/^(-o|--org)(=|$)/.test(w)) notRepoScoped = true;
      // `--repo=org/foo`, `-R=org/foo`
      const eq = w.match(/^(--repo|-R)=(.+)$/);
      if (eq) {
        repo = eq[2].replace(/^["']|["']$/g, '');
        continue;
      }
      if (VALUE_FLAGS.has(w)) {
        const val = words[++i];
        if ((w === '--repo' || w === '-R') && val) repo = val;
      }
    }
    if (name && !notRepoScoped) found.push({ name, repo });
  }
  return found;
}

/** The repo name from a `--repo` value, dropping any `owner/` segment. */
function repoBasename(repoSpec: string): string {
  return (repoSpec.split('/').pop() || repoSpec).toLowerCase();
}

/**
 * Does a `--repo owner/repo` (or bare `repo`) spec name this sibling? When the
 * spec carries an owner segment, match the full owner/repo against the
 * sibling's gitOrg/gitRemoteUrl so same-basename repos in different orgs
 * (orgA/ci vs orgB/ci) don't collide. Bare specs fall back to basename.
 */
function repoMatchesSibling(repoSpec: string, sib: SiblingRepo): boolean {
  const slash = repoSpec.indexOf('/');
  const sibBase = basename(normalizePath(sib.path));
  if (slash === -1) {
    // No owner segment — basename match is all we have.
    return repoBasename(repoSpec) === sibBase;
  }
  const owner = repoSpec.slice(0, slash).toLowerCase();
  const repoName = repoSpec.slice(slash + 1).toLowerCase();
  if (repoName !== sibBase) return false;
  // Repo name agrees. If the sibling carries git metadata, require the owner to
  // agree too so same-basename repos in different orgs (orgA/ci vs orgB/ci)
  // don't collide. Prefer gitOrg; otherwise scan the remote URL for
  // `owner/repo`. If the sibling has no git metadata at all there's no org to
  // disambiguate on, so fall back to the basename match we already confirmed.
  if (sib.gitOrg) return sib.gitOrg.toLowerCase() === owner;
  if (sib.gitRemoteUrl) {
    return sib.gitRemoteUrl.toLowerCase().includes(`${owner}/${repoName}`);
  }
  return true;
}

interface SecretRecord {
  name: string;
  repo?: string;
  project: string;
}

/**
 * Detect secrets set via `gh secret set` in agent history and in the current
 * project's transcripts. Flag a secret siblings have that this project lacks.
 *
 * Severity is warning, not error: the evidence is only what was typed or run
 * in a recorded session. A secret set in the GitHub web UI, by another
 * machine, or at org level never shows up here, so "not seen" is not proof
 * of "not set".
 */
export async function checkMissingSecret(ctx: SessionContext): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];
  const secrets: SecretRecord[] = [];

  // User-typed lines (history.jsonl) plus the commands the AGENT ran in this
  // project, which only the transcript records. Transcript commands are
  // attributed to the current project: that is the only project whose
  // transcripts are read.
  const transcript = await readProjectTranscript(ctx.currentProject);
  const lines: Array<{ display: string; project: string }> = [
    ...ctx.history.map((h) => ({ display: h.display, project: h.project })),
    ...transcript.events
      .filter((e) => e.kind === 'command')
      .map((e) => ({ display: e.text, project: ctx.currentProject })),
  ];

  for (const entry of lines) {
    for (const { name, repo } of parseSecretSets(entry.display)) {
      secrets.push({ name, repo, project: entry.project });
    }
  }

  if (secrets.length === 0) return issues;

  // Group secrets by name. Track project paths and `--repo owner/repo` specs
  // separately: paths match siblings by normalized-path equality, while repo
  // specs match by owner/repo identity (full owner-qualified when an owner
  // segment is present) so `orgA/ci` and `orgB/ci` don't collide.
  const byName = new Map<string, { projects: Set<string>; repos: Set<string> }>();
  for (const s of secrets) {
    if (!byName.has(s.name)) byName.set(s.name, { projects: new Set(), repos: new Set() });
    const bucket = byName.get(s.name)!;
    // A command that names `--repo` set the secret on THAT repo and says
    // nothing about the directory it was typed in: `gh secret set X --repo
    // org/bar` run from sibling foo is evidence about bar alone, and run from
    // the current project it must not mark the current project as having it.
    if (s.repo) {
      bucket.repos.add(s.repo);
      continue;
    }
    // A project-less history entry (Codex CLI records no working directory;
    // the scanner keeps those with project '') must not be path-matched:
    // normalizePath('') resolves to the linter's cwd, which IS the current
    // project in the dominant `ctxlint .` usage, so a project-less `gh secret
    // set` would read as "current project has the secret" and suppress a real
    // finding.
    if (s.project) bucket.projects.add(s.project);
  }

  // Check if current project is missing any secret that 2+ siblings have.
  // Use path equality (normalized) — earlier substring matching false-positived
  // when a sibling directory name contained the current project's basename
  // (e.g. `ctxlint-fork` matching a `ctxlint` current via basename contains).
  const currentNorm = normalizePath(ctx.currentProject);
  const currentBase = basename(currentNorm);
  // A capped transcript read may have missed the agent setting it here.
  const note = truncationNote(transcript);

  for (const [secretName, { projects, repos }] of byName) {
    const normalizedProjects = [...projects].map(normalizePath);
    const repoSpecs = [...repos];

    // Current project "has" the secret if a repo-less command was run in the
    // current project path, OR if a --repo flag value names this project's
    // basename (gh secret set --repo owner/REPO_BASE — the current project
    // has no remote owner to compare against, so basename is all we can match
    // on here).
    const currentHas =
      normalizedProjects.some((p) => p === currentNorm) ||
      repoSpecs.some((r) => repoBasename(r) === currentBase);

    if (currentHas) continue;

    // Need at least 2 other projects to have it. A sibling matches if a
    // repo-less command ran in its path, OR a --repo spec names it. For
    // owner-qualified specs (owner/repo) match the full owner/repo against the
    // sibling's git remote/org; for bare names fall back to basename.
    const siblingMatches = ctx.siblings.filter((sib) => {
      const sibNorm = normalizePath(sib.path);
      if (normalizedProjects.some((p) => p === sibNorm)) return true;
      return repoSpecs.some((r) => repoMatchesSibling(r, sib));
    });

    if (siblingMatches.length >= 2) {
      const sibNames = siblingMatches.map((s) => s.name).join(', ');
      issues.push({
        severity: 'warning',
        check: 'session-missing-secret',
        ruleId: 'session-missing-secret/missing-secret',
        line: 0,
        message: `GitHub secret "${secretName}" is set on ${siblingMatches.length} sibling repos (${sibNames}) but not on this project`,
        suggestion:
          `If this project needs it, run: gh secret set ${secretName} --repo <owner>/<repo>. ` +
          'Check `gh secret list` first: a secret set in the web UI or at org level is not ' +
          'visible in session history.',
        detail:
          `Found in session history: ${siblingMatches.length} sibling repos had this secret set` +
          (note ? `\n${note}` : ''),
      });
    }
  }

  return issues;
}
