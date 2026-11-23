import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { fileExists, loadPackageJson, stripBom } from '../../utils/fs.js';
import type { PackageJson } from '../../utils/fs.js';
import { closestMatch } from './closest-match.js';
import {
  analyzeMaskedExitStatus,
  fenceBlocks,
  NPM_LIFECYCLE_SHORTHANDS,
  pipefailInScope,
} from './exit-status.js';
import type { FenceBlock, MaskedExitStatus } from './exit-status.js';
import { findBinInvocations, knownSubcommands, ownedBins } from './cli-subcommands.js';
import type { BinInvocation } from './cli-subcommands.js';
import {
  findGradleBuildRoot,
  gradleProjectRefs,
  gradleUsesWrapper,
  readGradleProjectSet,
  unresolvedGradleProject,
} from './gradle-projects.js';
import type { GradleProjectSet } from './gradle-projects.js';
import {
  mavenBaseDirs,
  mavenSelectors,
  readMavenReactor,
  realPath,
  selectorMatches,
} from './maven-modules.js';
import type { ReactorProject } from './maven-modules.js';
import {
  htmlCommentLineMask,
  htmlCommentSpans,
  inlineCodeSpans,
  maskCodeSpans,
  stripInlineHtmlComments,
} from '../../utils/markdown.js';
import type { ParsedContextFile, LintIssue, CommandReference } from '../types.js';

// Match npm/pnpm/yarn/bun script invocations. `run` is required for npm
// (bare `npm install` is never a script reference; npm's four lifecycle
// shorthands are NPM_SHORTHAND_PATTERN's job), optional for pnpm/yarn/bun.
// Groups: [1] the non-npm manager, [2] an explicit `run`, [3] the candidate
// script name — [1] and [2] let scriptNameFromMatch exempt builtin
// subcommands (`pnpm install`, `yarn add`, ...) from script-name validation,
// and let the caller fall back to a bin or file for an implicit `run`.
const NPM_SCRIPT_PATTERN = /^(?:npm\s+run|(pnpm|yarn|bun)(?:\s+(run))?)\s+(\S+)/;
const MAKE_PATTERN = /^make\s+\S/;

// Subcommands that are package-manager builtins when invoked WITHOUT an
// explicit `run` (e.g. `pnpm install`, `yarn dlx foo`, `bun add zod`).
// These are not package.json script names and must not produce
// commands/script-not-found. Script-mapped shorthands (`pnpm test`,
// `yarn build`, ...) are deliberately absent — those DO resolve to
// scripts and stay validated.
const PM_BUILTIN_SUBCOMMANDS = new Set([
  'add',
  'approve-builds',
  'audit',
  'bin',
  'cache',
  'ci',
  'config',
  'create',
  'dedupe',
  'dlx',
  'doctor',
  'env',
  'exec',
  'fetch',
  'global',
  'help',
  'i',
  'import',
  'info',
  'init',
  'install',
  'licenses',
  'link',
  'list',
  'login',
  'logout',
  'ls',
  'node',
  'npm',
  'outdated',
  'pack',
  'patch',
  'patch-commit',
  'prune',
  'publish',
  'rebuild',
  'remove',
  'rm',
  'root',
  'run',
  'self-update',
  'set',
  'setup',
  'store',
  'team',
  'un',
  'uninstall',
  'unlink',
  'up',
  'update',
  'upgrade',
  'version',
  'whoami',
  'why',
  'workspace',
  'workspaces',
  'x',
]);

// Subcommands that a SPECIFIC manager runs via a BUILTIN rather than a
// package.json script, so `<manager> <sub>` (without explicit `run`) must not
// be script-validated. `bun test` is the live false positive: it always runs
// Bun's builtin test runner with no `test` script required — unlike
// `npm/pnpm/yarn test`, which DO resolve to a script and stay validated.
// Keyed by manager (these are NOT shared across managers like
// PM_BUILTIN_SUBCOMMANDS is, since `test` is a real script name for the others).
const PM_MANAGER_BUILTINS: Record<string, Set<string>> = {
  bun: new Set(['test']),
};

function isManagerBuiltin(manager: string, sub: string): boolean {
  return PM_MANAGER_BUILTINS[manager]?.has(sub) ?? false;
}

/**
 * A script name that is documentation shorthand, not a script: a marked
 * placeholder (`npm run <script>`, `pnpm {name}`, `yarn $SCRIPT`, `...`) or a
 * generic stand-in name (`npm run script-name`). Same idea as the Gradle and
 * Maven placeholder filters.
 */
const SCRIPT_PLACEHOLDER = /[<>{}$*%[\]]|\.\.\.|^(?:script|task|command)(?:[-_]?name)?$/i;

/**
 * Resolve the script name from an NPM_SCRIPT_PATTERN match, or null when the
 * captured token is not actually a script name: a flag (`pnpm -r build` —
 * the real script is unknowable without parsing pnpm's flag table), a
 * placeholder, a shared package-manager builtin invoked without an explicit
 * `run`, or a manager-specific builtin (`bun test`).
 */
function scriptNameFromMatch(match: RegExpMatchArray): string | null {
  const [, manager, explicitRun, name] = match;
  if (name.startsWith('-')) return null;
  if (SCRIPT_PLACEHOLDER.test(name)) return null;
  if (manager && !explicitRun && PM_BUILTIN_SUBCOMMANDS.has(name)) return null;
  if (manager && !explicitRun && isManagerBuiltin(manager, name)) return null;
  return name;
}

/**
 * `npm <word>` for the words docs commonly use as if they were shorthands.
 * npm runs a script without `run` ONLY for its lifecycle commands (test, with
 * its `t`/`tst` aliases, start, stop, restart); every other word here is an
 * unknown npm command whether or not a script of that name exists. pnpm, yarn
 * and bun take an implicit `run` for any name and are handled by
 * NPM_SCRIPT_PATTERN, so they never reach this pattern. The lookahead keeps
 * `npm test-unit` from reading as `npm test`. The lifecycle half comes from
 * NPM_LIFECYCLE_SHORTHANDS (exit-status.ts), which exit-status-masked uses to
 * resolve the same `npm <word>` to its script, so the two cannot drift.
 */
const NPM_SHORTHAND_PATTERN = new RegExp(
  `^npm\\s+(${[
    ...Object.keys(NPM_LIFECYCLE_SHORTHANDS),
    'build',
    'dev',
    'lint',
    'format',
    'check',
    'typecheck',
    'type-check',
    'clean',
    'serve',
    'preview',
    'e2e',
  ].join('|')})(?=\\s|$)`,
);

/**
 * Extract the package name from an `npx` command. Walks past leading flags
 * (`-y`, `--yes`, `--silent`, ...) and honors `-p` / `--package` overrides.
 * Returns null when no package can be identified.
 *
 * Earlier behavior only inspected the first whitespace-delimited token after
 * `npx`, so `npx -y @scope/typo` skipped validation entirely (the `-y` was
 * captured, then `startsWith('-')` short-circuited).
 */
function extractNpxPackage(cmd: string): string | null {
  if (!/^npx\b/.test(cmd)) return null;
  const tokens = cmd.split(/\s+/).slice(1);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-p' || t === '--package') {
      const v = tokens[i + 1];
      if (v && !v.startsWith('-')) return v;
      continue;
    }
    if (t.startsWith('-p=') || t.startsWith('--package=')) {
      return t.slice(t.indexOf('=') + 1) || null;
    }
    if (t.startsWith('-')) continue;
    return t;
  }
  return null;
}

// Node tools run bare (`vitest run`, `tsc --noEmit`), checked for availability
// against the dependencies. Node-only: a Python tool such as pytest must not
// be here, or a Python repo is told its package.json is missing. Like the
// script/shorthand/npx branches, this one is gated on a parsed package.json;
// when there is none every such branch silently no-ops, so we track whether
// any reference WOULD have been checked and emit a single info diagnostic
// (asymmetric otherwise with the make-target branch, which has its own
// no-makefile error).
const PKG_DEPENDENT_TOOL_PATTERN = /^(vitest|jest|mocha|eslint|prettier|tsc)\b/;

// Bin names whose npm package is named differently, consulted by
// resolvesAsBin. Without it `tsc` is looked up verbatim in deps and any
// project linted without node_modules (fresh checkout, CI) gets a false
// tool-not-found / npx-not-in-deps despite typescript being in
// devDependencies. Covers the bins docs commonly invoke whose package name
// diverges; identity mappings (vitest, eslint, prettier, ...) need no entry.
// The node_modules/.bin fallback keeps using the BIN name.
const BIN_TO_PACKAGE: Record<string, string[]> = {
  tsc: ['typescript'],
  tsserver: ['typescript'],
  biome: ['@biomejs/biome'],
  playwright: ['@playwright/test'],
  netlify: ['netlify-cli'],
  changeset: ['@changesets/cli'],
};

function wouldNeedPackageJson(cmd: string): boolean {
  // Builtin subcommands / flag-first / placeholder invocations are never
  // validated, so they must not trigger the package-json-missing info either.
  const scriptMatch = cmd.match(NPM_SCRIPT_PATTERN);
  if (scriptMatch) return scriptNameFromMatch(scriptMatch) !== null;
  return (
    NPM_SHORTHAND_PATTERN.test(cmd) || /^npx\b/.test(cmd) || PKG_DEPENDENT_TOOL_PATTERN.test(cmd)
  );
}

/**
 * The package.json files and directories a context file's Node commands
 * resolve against: every directory from the context file's own up to the
 * project root (nearest first), and the parseable package.json files among
 * them. A nested package (`packages/web/CLAUDE.md`) therefore gets its own
 * scripts, while dependencies hoisted to a workspace root still count.
 */
interface PackageScope {
  dirs: string[];
  manifests: Array<{ dir: string; pkg: PackageJson }>;
}

/**
 * Directories from the context file's up to `projectRoot`, nearest first. A
 * context file outside the project root yields just the root.
 */
function dirsUpToRoot(contextFile: string, projectRoot: string): string[] {
  const root = path.resolve(projectRoot);
  let dir = path.dirname(path.resolve(contextFile));
  const outside = (d: string): boolean => {
    const rel = path.relative(root, d);
    return rel.startsWith('..') || path.isAbsolute(rel);
  };
  if (outside(dir)) return [root];
  const dirs: string[] = [];
  for (;;) {
    dirs.push(dir);
    if (path.relative(root, dir) === '') return dirs;
    const parent = path.dirname(dir);
    if (parent === dir) return dirs;
    dir = parent;
  }
}

function packageScope(contextFile: string, projectRoot: string): PackageScope {
  const dirs = dirsUpToRoot(contextFile, projectRoot);
  const manifests: PackageScope['manifests'] = [];
  for (const dir of dirs) {
    const pkg = loadPackageJson(dir);
    if (pkg) manifests.push({ dir, pkg });
  }
  return { dirs, manifests };
}

function hasOwnKey(record: Record<string, string> | undefined, key: string): boolean {
  return typeof record === 'object' && record !== null && Object.hasOwn(record, key);
}

function dependsOn(pkg: PackageJson, name: string): boolean {
  return [
    pkg.dependencies,
    pkg.devDependencies,
    pkg.peerDependencies,
    pkg.optionalDependencies,
  ].some((deps) => hasOwnKey(deps, name));
}

/** Whether any package.json in scope defines `name` as a script. */
function scriptDefined(scope: PackageScope, name: string): boolean {
  return scope.manifests.some((m) => hasOwnKey(m.pkg.scripts, name));
}

/** `prettier@3` -> `prettier`, `@scope/pkg@1.2.0` -> `@scope/pkg`. */
function stripVersion(spec: string): string {
  const at = spec.indexOf('@', 1);
  return at > 0 ? spec.slice(0, at) : spec;
}

/**
 * Whether `spec` (a bin or package name, optionally `@version`ed) is
 * something the project can run: a dependency (directly, or through
 * BIN_TO_PACKAGE for a bin whose package is named differently), the
 * project's own package or one of its own bins, or a bin in a
 * node_modules/.bin at or above the context file. The one resolver behind
 * npx-not-in-deps, tool-not-found and the pnpm/yarn/bun bin fallback.
 */
function resolvesAsBin(spec: string, scope: PackageScope): boolean {
  const name = stripVersion(spec);
  const scoped = name.startsWith('@');
  const binName = name.slice(name.lastIndexOf('/') + 1);
  for (const { pkg } of scope.manifests) {
    if (pkg.name === name || dependsOn(pkg, name)) return true;
    if (scoped) continue;
    const aliases = Object.hasOwn(BIN_TO_PACKAGE, name) ? BIN_TO_PACKAGE[name] : [];
    if (aliases.some((p) => dependsOn(pkg, p))) return true;
    if (ownedBins(pkg).some((b) => b.name === name)) return true;
  }
  return scope.dirs.some((d) => fileExists(path.join(d, 'node_modules', '.bin', binName)));
}

/** `bun src/main.ts`, `yarn ./scripts/x.js`: a file, which the manager runs directly. */
function looksLikeFilePath(token: string): boolean {
  return /[\\/]/.test(token) || /\.(?:[cm]?[jt]sx?|json)$/.test(token);
}

/**
 * Load the Bash command prefixes DENIED in the project's
 * `.claude/settings.json` / `.claude/settings.local.json`. Claude Code deny
 * entries are tool matchers (`Bash(npx netlify deploy:*)`); we unwrap the
 * `Tool(...)` wrapper and strip the trailing `:*` / `*` matcher wildcard,
 * leaving the command prefix. A command the user has explicitly DENIED is one
 * they've told the agent never to run, so the "add it to devDependencies"
 * nudge from npx-not-in-deps is noise for it -- these prefixes let
 * checkCommands suppress that finding. Project-scoped only (never the
 * user-global settings), matching the posture of the other command checks; a
 * missing or unparseable file yields no prefixes (no suppression, behavior
 * unchanged for the common no-settings case).
 */
function loadDeniedCommandPrefixes(projectRoot: string): string[] {
  const prefixes: string[] = [];
  for (const rel of ['settings.json', 'settings.local.json']) {
    let content: string;
    try {
      content = stripBom(fs.readFileSync(path.join(projectRoot, '.claude', rel), 'utf-8'));
    } catch {
      continue; // missing file is expected
    }
    const data = parseJsonc(content, [], { allowTrailingComma: true }) as
      { permissions?: { deny?: unknown } } | undefined;
    const deny = data?.permissions?.deny;
    if (!Array.isArray(deny)) continue;
    for (const entry of deny) {
      if (typeof entry !== 'string') continue;
      // Unwrap a single Tool(...) wrapper, then strip the trailing :* / * matcher.
      const inner = entry.replace(/^[A-Za-z]+\((.*)\)$/, '$1');
      const prefix = inner.replace(/:?\*+$/, '').trim();
      if (prefix) prefixes.push(prefix);
    }
  }
  return prefixes;
}

/**
 * A command is DENIED when it exactly matches, or extends at a word boundary, a
 * deny prefix -- mirroring Claude Code's `Bash(prefix:*)` prefix semantics.
 * `npx netlify deploy --prod` is denied by the prefix `npx netlify deploy`;
 * `npx netlifyctl` is NOT (no space boundary), so an unrelated command sharing
 * a textual prefix keeps being validated.
 */
function isDeniedCommand(cmd: string, deniedPrefixes: string[]): boolean {
  return deniedPrefixes.some((p) => cmd === p || cmd.startsWith(`${p} `));
}

/**
 * A negation governing the command mention -- "**NEVER run `npx netlify
 * deploy` directly.**" -- means the doc cites the command to steer the agent
 * AWAY from it. Demanding that such a command RESOLVE (script exists, package
 * is a dependency, make target is defined, tool is installed) is backwards:
 * the doc's whole point is that nobody should run it. So every resolvability
 * rule in checkCommands skips these, gated once in the main loop. The negation
 * must PRECEDE the command within the same CLAUSE: scope ends at a sentence
 * terminator (`.` `!` `?`) or a clause boundary (`;`, spaced ` -- `, or an
 * em-dash), so "NEVER guess -- run `npx x` to check" and "Never use the UI;
 * deploy with `npx x`" keep flagging -- there the command is the RECOMMENDED
 * half of the line. Inline code spans in the prefix are masked (same-length
 * `#` filler, shared with tier-tokens.ts) so a token like `avoid-cycles`
 * inside backticks can't read as prose negation. Comparative framings
 * ("instead of", "rather than") are deliberately NOT negation tokens: in
 * "Instead of clicking around the UI, run `npx x`" the command is the
 * recommendation, and "use `npx x` rather than y" places the command before
 * the phrase anyway. Matching is case-insensitive because prohibition prose
 * is ("Do not run", "don't use", "NEVER run") -- over-suppressing a
 * warning-severity nudge is the cheap direction, per the module's
 * false-negative-over-false-positive posture. A negation turned back into a
 * requirement does NOT suppress: "Don't forget to run `npx x`", "Never push
 * without running `npx x`" (see negationTurnedRequirement, shared with the
 * list-lead path). Complements isDeniedCommand above: that credits an
 * explicit permissions.deny entry, this covers repos that write the
 * prohibition in prose without a matching deny rule.
 */
const PROHIBITION_TOKEN = /\b(?:never|don['’]?t|do\s+not|must\s+not|avoid)\b/i;

// Ends a prohibition's scope: sentence terminators plus clause boundaries.
// `\s--(?=\s|$)` is the spaced double-hyphen; requiring whitespace on both
// sides keeps `--prod`-style flags from splitting a clause.
const CLAUSE_TERMINATOR = /[.!?;—]|\s--(?=\s|$)/;

/**
 * Verbs that introduce a RECOMMENDATION. Used only to decide whether a comma
 * separates a prohibition from a following recommendation.
 */
const RECOMMENDATION_VERB = /\b(?:run|use|call|invoke|execute|prefer|deploy|install)\b/i;

/**
 * A comma is the most common way English separates "don't do X" from "do Y":
 * "Don't edit dist by hand, run `npx build-tool` instead." Treating the comma
 * as inert made the leading "Don't" govern the RECOMMENDED command and
 * suppressed a legitimate finding -- the same sentence with a semicolon was
 * flagged correctly, which is an indefensible split.
 *
 * A comma cannot simply join CLAUSE_TERMINATOR, because it is equally the way
 * English writes a prohibition LIST: "NEVER run `npx a`, `npx b`, or `npx c`"
 * must keep suppressing b and c. The discriminator is what follows the comma:
 * a recommendation verb ("run", "use", ...) means contrast, and the clause is
 * re-scoped to after the comma; anything else (a bare list continuation, "or",
 * "and") leaves the clause -- and its prohibition -- intact.
 *
 * Narrowing is not the same as un-suppressing. The narrowed tail is still
 * tested for its own prohibition, so "Never commit secrets, and never run
 * `npx leak-tool`" stays suppressed on the strength of the SECOND "never".
 *
 * Accepted limits, consistent with this module's false-negative-over-false-
 * positive posture -- closing any of them needs the verb/coordination analysis
 * the check deliberately avoids:
 *
 *  - Only the LAST comma is considered, so in a post-contrast LIST ("Don't do
 *    X, run `npx a`, `npx b`") the first item un-suppresses and later ones stay
 *    suppressed. Inconsistent, but in the safe direction for the later items.
 *  - A coordinated CONTINUATION of a prohibition whose tail happens to carry a
 *    recommendation verb ("Never install X, or run `npx y`") un-suppresses,
 *    because "or run" is indistinguishable from contrast by verb alone.
 *  - Inherited from CLAUSE_TERMINATOR, not introduced here: any `.` ends a
 *    clause, so a version or abbreviation mid-sentence ("Never run the v1.2
 *    tool `npx x`") truncates the clause and drops the prohibition.
 */
function narrowAtContrastComma(clause: string): string {
  const idx = clause.lastIndexOf(',');
  if (idx === -1) return clause;
  const tail = clause.slice(idx + 1);
  return RECOMMENDATION_VERB.test(tail) ? tail : clause;
}

/**
 * Core predicate: is the command starting at 0-based `offset` on `line`
 * governed by a preceding prohibition?
 */
function isProhibitedAt(rawLine: string, offset: number): boolean {
  // Blank any self-contained HTML comment first: its text is commentary, not
  // prose governing the command. Without this, "<!-- never --> run `npx foo`"
  // put "never" in the prefix and suppressed a legitimate finding. Both this
  // and the code-span mask below are length-preserving, so `offset` -- computed
  // against the raw line -- stays valid throughout.
  const line = stripInlineHtmlComments(rawLine);
  // Mask inline code spans before the negation search -- span CONTENTS are
  // code, not prose.
  const masked = maskCodeSpans(line, inlineCodeSpans(line));
  // Everything before the command (opening backtick included, masked along
  // with the rest of the command's own span).
  const prefix = masked.slice(0, Math.max(0, offset));
  // Only the clause the command sits in can govern it.
  const clause = narrowAtContrastComma(prefix.split(CLAUSE_TERMINATOR).pop() ?? '');
  return PROHIBITION_TOKEN.test(clause) && !negationTurnedRequirement(clause);
}

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const HEADING = /^\s{0,3}#{1,6}\s/;

/**
 * A prohibition can also govern a whole LIST from the line that introduces it:
 *
 *     ## Never run these
 *
 *     - `npx netlify deploy`
 *     - `npm run release`
 *
 * True when line `lineNo` (1-based) is a list item and the nearest line above
 * the list -- skipping blank lines, other items and indented continuations --
 * is a heading or a `...:` intro line whose final clause carries a
 * prohibition (same clause rules as the same-line check). A paragraph under a
 * prohibition heading is NOT covered: only list items read as the forbidden
 * set, and prose ("Instead use `npx y`") is often the recommended way out.
 *
 * A lead whose negation is turned back into a requirement does NOT suppress:
 * "Never push without running:", "Don't forget to run:", "Do not merge until
 * you run:" all REQUIRE the list. The test is the text after the lead's last
 * prohibition token: an omission verb right after it (forget, skip), or a
 * without/until/unless condition that itself runs something, means the
 * negation governs something else (pushing, forgetting), not the commands. A
 * plain condition ("Never run these without approval:") still prohibits.
 * isProhibitedAt applies that test to the lead's final clause, the same rule
 * the same-line check uses ("Don't forget to run `npx x`" flags too).
 */
function isProhibitedByListLead(lines: string[], lineNo: number): boolean {
  if (!LIST_ITEM.test(lines[lineNo - 1] ?? '')) return false;
  for (let i = lineNo - 2; i >= 0; i--) {
    const line = lines[i];
    if (line.trim() === '' || LIST_ITEM.test(line) || /^\s+\S/.test(line)) continue;
    if (!HEADING.test(line) && !line.trimEnd().endsWith(':')) return false;
    return isProhibitedAt(line, line.length);
  }
  return false;
}

/**
 * Verbs that, right after a never/don't/avoid, negate the negation itself:
 * "don't forget Y", "never skip Y", "do not fail to Y" all require Y.
 */
const NEGATED_OMISSION =
  /^\s*(?:forget(?:ting)?|skip(?:ping)?|omit(?:ting)?|neglect(?:ing)?|fail(?:ing)?\s+to)\b/i;

/**
 * A condition after the negation: "never X without Y", "do not X until Y".
 * It is a requirement on the list only when the condition itself runs
 * something ("without running:", "until you run:"); "Never run these without
 * approval:" or "Don't run these until main is green:" keep the commands as
 * the forbidden set.
 */
const CONDITION = /\b(?:without|until|unless)\b/i;
const EXECUTION_VERB =
  /\b(?:run(?:ning)?|us(?:e|ing)|call(?:ing)?|invok(?:e|ing)|execut(?:e|ing)|execs?)\b/i;

/**
 * True when the text after `line`'s last prohibition token reads as a
 * requirement. `line` may already be code-span masked (isProhibitedAt passes
 * its masked clause); masking again is a no-op.
 */
function negationTurnedRequirement(line: string): boolean {
  const masked = maskCodeSpans(line, inlineCodeSpans(line));
  let end = -1;
  for (const m of masked.matchAll(new RegExp(PROHIBITION_TOKEN.source, 'gi'))) {
    end = (m.index ?? 0) + m[0].length;
  }
  if (end < 0) return false;
  const tail = masked.slice(end);
  if (NEGATED_OMISSION.test(tail)) return true;
  const cond = CONDITION.exec(tail);
  return cond !== null && EXECUTION_VERB.test(tail.slice(cond.index + cond[0].length));
}

/** `ref.column` is 1-based and points at the first char of the command. */
function isProhibitedRef(lines: string[], ref: CommandReference): boolean {
  return (
    isProhibitedAt(lines[ref.line - 1] ?? '', ref.column - 1) ||
    isProhibitedByListLead(lines, ref.line)
  );
}

/**
 * BinInvocation carries no column (its candidates are reconstructed from
 * fenced lines and code spans), so locate the command text on its line. A
 * miss yields `false` -- never suppress on a guess.
 */
function isProhibitedInvocation(lines: string[], inv: BinInvocation): boolean {
  if (isProhibitedByListLead(lines, inv.line)) return true;
  const line = lines[inv.line - 1] ?? '';
  // findBinInvocations builds its non-fence candidates from inline code spans,
  // so prefer the span whose content IS this invocation -- an exact identity,
  // not a substring search. A plain indexOf picked the wrong occurrence in both
  // directions whenever the text appears twice on a line:
  //   "The `<bin> doctor` check is gone; never run `<bin> doctor`."
  //     -> matched the UN-BACKTICKED prose mention at the head of the line, so
  //        the prefix was "The " and the prohibition after the `;` was missed.
  //   "Never run `<bin> doctor --json` in CI; run `<bin> doctor` locally."
  //     -> for the second, AFFIRMATIVE invocation it matched inside the FIRST
  //        span (the shorter command is a prefix of the longer one), inheriting
  //        that span's prohibition and suppressing a finding that should fire.
  // Fenced candidates have no prose prefix, and the `$ ` prompt form is a
  // whole-line candidate; both fall through to the search, where a miss
  // declines to suppress rather than guessing.
  for (const span of inlineCodeSpans(line)) {
    if (span.content.trim() === inv.cmd) return isProhibitedAt(line, span.start);
  }
  const idx = line.indexOf(inv.cmd);
  return idx < 0 ? false : isProhibitedAt(line, idx);
}

export async function checkCommands(
  file: ParsedContextFile,
  projectRoot: string,
): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];
  // Script, npx and tool references resolve against the nearest package.json
  // at or above the context file (see PackageScope); `pkgJson` is that nearest
  // one, null when none in scope parses.
  const scope = packageScope(file.filePath, projectRoot);
  const pkgJson = scope.manifests[0]?.pkg ?? null;
  const makefiles = scope.dirs.flatMap((d) => {
    const m = loadMakefile(d);
    return m ? [m] : [];
  });
  const deniedPrefixes = loadDeniedCommandPrefixes(projectRoot);
  const contentLines = file.content.split('\n');
  // Commands written inside an HTML comment are commentary ABOUT a command,
  // not commands to run -- "<!-- we used to run `npx old-tool` here -->" was
  // reported as a missing dependency. The parser has no comment handling, so
  // the filter lives here. Comment lines ONLY: the parser deliberately extracts
  // commands from shell fences, so fenced content must keep flowing through.
  // findBinInvocations already applies the same rule to its own scan.
  // Two granularities, because a self-contained comment does NOT make its line
  // non-prose (a real rule may carry a trailing annotation). The line mask
  // catches multi-line comment bodies; the span check catches a reference whose
  // own column sits inside a single-line comment.
  const commentLines = htmlCommentLineMask(contentLines);
  const inHtmlComment = (line: number, column: number): boolean => {
    if (commentLines[line - 1] === true) return true;
    const offset = column - 1;
    return htmlCommentSpans(contentLines[line - 1] ?? '').some(
      (s) => offset >= s.start && offset < s.end,
    );
  };

  // When package.json can't be loaded, all the script/shorthand/npx/tool
  // branches below silently skip. Surface that ONCE if any reference would
  // otherwise have been validated, so the skip isn't invisible.
  if (!pkgJson) {
    // Same gate as the dispatch loop: a command the doc only forbids would not
    // have been validated even WITH a package.json, so it must not be the
    // reference that triggers the "checks skipped" notice either.
    const skipped = file.references.commands.find(
      (ref) =>
        wouldNeedPackageJson(ref.value) &&
        !inHtmlComment(ref.line, ref.column) &&
        !isDeniedCommand(ref.value, deniedPrefixes) &&
        !isProhibitedRef(contentLines, ref),
    );
    if (skipped) {
      issues.push({
        severity: 'info',
        check: 'commands',
        ruleId: 'commands/package-json-missing',
        line: skipped.line,
        message: 'package.json missing or unparseable — command checks skipped',
        suggestion:
          'Add a parseable package.json at the project root so script, npx, and tool references can be validated.',
      });
    }
  }

  // The project's OWN binaries are the root package's.
  issues.push(
    ...checkUnknownSubcommand(
      file,
      projectRoot,
      loadPackageJson(projectRoot),
      deniedPrefixes,
      contentLines,
    ),
  );

  const jvmCache: JvmBuildCache = { gradle: new Map(), maven: new Map() };

  for (const ref of file.references.commands) {
    // Above the exit-status check too: a command inside a comment should
    // produce NO finding of any kind, not just no resolvability finding.
    if (inHtmlComment(ref.line, ref.column)) continue;
    const cmd = ref.value;

    // commands/exit-status-masked -- runs BEFORE the dispatch below and does
    // not `continue`, because the masked pipelines are also npx/script/tool
    // references and every one of those branches short-circuits the loop.
    // A finding here is about the command's SHAPE, not its resolvability, so
    // the two are independent and may both fire on one line.
    const masked =
      analyzeMaskedExitStatus(cmd, pkgJson?.scripts) ??
      maskedByNextLine(contentLines, ref, pkgJson?.scripts);
    if (masked && !pipefailInScope(file.content, ref.line)) {
      const why =
        masked.kind === 'success-claim'
          ? 'the success claim cannot fail'
          : '`$?` reports the filter, not the verifier';
      issues.push({
        severity: 'warning',
        check: 'commands',
        ruleId: 'commands/exit-status-masked',
        line: ref.line,
        message: `"${cmd}" — exit status comes from "${masked.filter}", not "${masked.verifier}"; ${why}`,
        suggestion:
          'Add `set -o pipefail` before the pipeline, drop the filter, or read ' +
          '`${PIPESTATUS[0]}` instead of `$?`.',
      });
    }

    // Every branch below reports the same thing in different words: this
    // command does not RESOLVE. When the doc cites the command only to forbid
    // it -- an explicit permissions.deny entry, or a prose prohibition -- there
    // is nothing to resolve and the finding is noise. Gate all of them once,
    // here, rather than per-branch: the previous code guarded only
    // npx-not-in-deps, so "NEVER run `tsc --noEmit` here." still produced
    // commands/tool-not-found.
    //
    // exit-status-masked above is deliberately NOT gated. It reports the
    // command's SHAPE, which is worth flagging even in an example the reader is
    // told never to run -- a doc that demonstrates a masked pipeline teaches the
    // masked pipeline.
    if (isDeniedCommand(cmd, deniedPrefixes) || isProhibitedRef(contentLines, ref)) continue;

    // Gradle project paths and Maven module selectors. Each returns null when
    // the command is not that tool's invocation, so an ordinary command falls
    // through to the branches below.
    const gradleIssues = checkGradleProjects(file, ref, projectRoot, jvmCache);
    if (gradleIssues) {
      issues.push(...gradleIssues);
      continue;
    }
    const mavenIssues = checkMavenModules(file, ref, projectRoot, jvmCache);
    if (mavenIssues) {
      issues.push(...mavenIssues);
      continue;
    }

    // Scripts and make targets resolve in the directory the command runs in,
    // which a `cd` earlier in the same snippet moves somewhere unknown.
    const cdEarlier = (): boolean => cdEarlierInFence(file.content, ref.line);

    // npm/pnpm/yarn/bun script references
    const scriptMatch = cmd.match(NPM_SCRIPT_PATTERN);
    if (scriptMatch) {
      if (!pkgJson || cdEarlier()) continue;
      const scriptName = scriptNameFromMatch(scriptMatch);
      if (scriptName === null || scriptDefined(scope, scriptName)) continue;
      // Without an explicit `run`, pnpm/yarn/bun fall back to a dependency's
      // bin (`pnpm vitest run`) or a file (`bun src/main.ts`) when no script
      // has the name.
      const [, manager, explicitRun] = scriptMatch;
      if (manager && !explicitRun) {
        if (looksLikeFilePath(scriptName) || resolvesAsBin(scriptName, scope)) continue;
      }
      issues.push(missingScript(cmd, scriptName, pkgJson, ref.line));
      continue;
    }

    // npm without `run`: only the lifecycle commands run a script.
    const shorthandMatch = cmd.match(NPM_SHORTHAND_PATTERN);
    if (shorthandMatch) {
      if (!pkgJson || cdEarlier()) continue;
      const word = shorthandMatch[1];
      const script = Object.hasOwn(NPM_LIFECYCLE_SHORTHANDS, word)
        ? NPM_LIFECYCLE_SHORTHANDS[word]
        : undefined;
      if (!script) {
        issues.push({
          severity: 'error',
          check: 'commands',
          ruleId: 'commands/script-not-found',
          line: ref.line,
          message: `"${cmd}" — npm has no "${word}" shorthand; scripts other than test/start/stop/restart need \`npm run\``,
          suggestion: `Use "npm run ${word}"`,
        });
        continue;
      }
      if (!npmLifecycleResolves(scope, script)) {
        issues.push(missingScript(cmd, script, pkgJson, ref.line));
      }
      continue;
    }

    // npx package references. Denied/prohibited commands were already skipped
    // by the shared gate above the dispatch.
    if (/^npx\b/.test(cmd)) {
      const spec = pkgJson ? extractNpxPackage(cmd) : null;
      if (!spec || resolvesAsBin(spec, scope)) continue;
      issues.push({
        severity: 'warning',
        check: 'commands',
        ruleId: 'commands/npx-not-in-deps',
        line: ref.line,
        message: `"${cmd}" — "${stripVersion(spec)}" not found in dependencies`,
        suggestion:
          'If this is a global tool, consider adding it to devDependencies for reproducibility',
      });
      continue;
    }

    // Makefile targets
    if (MAKE_PATTERN.test(cmd)) {
      // `-C dir` / `-f file` pick a makefile somewhere else: neither "no
      // makefile here" nor a target lookup in this one would be about it.
      if (makeRetargets(cmd) || cdEarlier()) continue;
      if (makefiles.length === 0) {
        issues.push({
          severity: 'error',
          check: 'commands',
          ruleId: 'commands/no-makefile',
          line: ref.line,
          message: `"${cmd}" — no Makefile found in project`,
        });
        continue;
      }
      const target = extractMakeTarget(cmd);
      if (target && !makefiles.some((m) => makefileMayDefine(m.content, target))) {
        issues.push({
          severity: 'error',
          check: 'commands',
          ruleId: 'commands/make-target-not-found',
          line: ref.line,
          message: `"${cmd}" — target "${target}" not found in ${makefiles[0].name}`,
        });
      }
      continue;
    }

    // Common tool availability
    const toolMatch = cmd.match(PKG_DEPENDENT_TOOL_PATTERN);
    if (toolMatch && pkgJson && !resolvesAsBin(toolMatch[1], scope)) {
      issues.push({
        severity: 'warning',
        check: 'commands',
        ruleId: 'commands/tool-not-found',
        line: ref.line,
        message: `"${cmd}" — "${toolMatch[1]}" not found in dependencies or node_modules/.bin`,
      });
    }
  }

  return issues;
}

function missingScript(
  cmd: string,
  scriptName: string,
  pkgJson: PackageJson,
  line: number,
): LintIssue {
  const available = Object.keys(pkgJson.scripts ?? {}).join(', ');
  return {
    severity: 'error',
    check: 'commands',
    ruleId: 'commands/script-not-found',
    line,
    message: `"${cmd}" — script "${scriptName}" not found in package.json`,
    suggestion: available ? `Available scripts: ${available}` : undefined,
  };
}

/**
 * Whether an npm lifecycle command has something to run. npm's own defaults
 * apply when the script is absent: `npm start` runs `node server.js` if that
 * file exists, and `npm restart` runs stop + start, so it resolves whenever
 * `start` does.
 */
function npmLifecycleResolves(scope: PackageScope, script: string): boolean {
  if (scriptDefined(scope, script)) return true;
  const startResolves = (): boolean =>
    scriptDefined(scope, 'start') ||
    scope.manifests.some((m) => fileExists(path.join(m.dir, 'server.js')));
  if (script === 'start') return startResolves();
  if (script === 'restart') return startResolves();
  return false;
}

/**
 * commands/exit-status-masked across two lines of one fence: the pipeline on
 * this line and the `$?` read on the next,
 *
 *     npx tsc --noEmit | head -20
 *     echo "exit=$?"
 *
 * which is the same defect as `...| head -20; echo "exit=$?"` on one line. Only
 * the `$?` shape spans lines (a success claim needs `&&`, which a newline is
 * not), and only when the next line is in the same fence: separate fences and
 * prose lines are separate shells.
 */
function maskedByNextLine(
  lines: string[],
  ref: CommandReference,
  scripts: Record<string, string> | undefined,
): MaskedExitStatus | null {
  const idx = ref.line - 1;
  const block = enclosingFence(lines, idx);
  if (!block || idx + 1 >= block.close) return null;
  const nextCmd = lines[idx + 1].trim().replace(/^[$>]\s+/, '');
  if (!nextCmd) return null;
  const masked = analyzeMaskedExitStatus(`${ref.value}; ${nextCmd}`, scripts);
  return masked?.kind === 'status-echo' ? masked : null;
}

/** The fenced block whose body holds 0-based line `idx`, if any. */
function enclosingFence(lines: string[], idx: number): FenceBlock | undefined {
  return fenceBlocks(lines).find((b) => b.open < idx && idx < b.close);
}

/**
 * commands/unknown-subcommand -- a documented invocation of THIS project's own
 * binary using a subcommand the CLI does not implement.
 *
 * Emits nothing unless the CLI's subcommand set resolved with confidence (see
 * cli-subcommands.ts for the tiered resolver and its bail-outs). Severity is
 * `error`: unlike a missing npm script, which fails loudly, an unknown
 * subcommand on an MCP server binary falls through to stdio startup and hangs.
 */
function checkUnknownSubcommand(
  file: ParsedContextFile,
  projectRoot: string,
  pkgJson: ReturnType<typeof loadPackageJson>,
  deniedPrefixes: string[],
  contentLines: string[],
): LintIssue[] {
  const bins = ownedBins(pkgJson);
  if (bins.length === 0) return [];

  // Resolve each bin's dispatch table at most once per file. The scanner needs
  // the same sets (an unprompted untagged fence is read only on evidence, and a
  // bareword after an ambiguous flag only when it is known), so it shares the
  // memo through `knownFor`.
  const resolved = new Map<string, Set<string> | null>();
  const knownFor = (name: string): Set<string> | null => {
    if (!resolved.has(name)) {
      const bin = bins.find((b) => b.name === name);
      resolved.set(name, bin ? knownSubcommands(projectRoot, bin.entry) : null);
    }
    return resolved.get(name) ?? null;
  };

  const invocations = findBinInvocations(file.content, new Set(bins.map((b) => b.name)), {
    packageName: pkgJson?.name,
    bins,
    knownFor,
  });
  if (invocations.length === 0) return [];

  const issues: LintIssue[] = [];

  for (const inv of invocations) {
    // Same resolvability gate as the main dispatch loop: an invocation the doc
    // cites only to forbid ("NEVER run `ctxlint doctor`") is not a broken doc.
    if (isDeniedCommand(inv.cmd, deniedPrefixes)) continue;
    if (isProhibitedInvocation(contentLines, inv)) continue;
    const known = knownFor(inv.bin);
    // null = the dispatch could not be read as a closed set. Silence beats a
    // confident-but-wrong "that subcommand does not exist".
    if (!known || known.size === 0) continue;
    if (known.has(inv.sub)) continue;

    const listed = [...known].sort().join(', ');
    issues.push({
      severity: 'error',
      check: 'commands',
      ruleId: 'commands/unknown-subcommand',
      line: inv.line,
      message: `"${inv.cmd}" — "${inv.sub}" is not a subcommand of ${inv.bin} (known: ${listed})`,
      suggestion: `Use one of the subcommands ${inv.bin} implements, or remove the invocation.`,
    });
  }
  return issues;
}

/** Build models read at most once per checkCommands call, keyed by directory. */
interface JvmBuildCache {
  gradle: Map<string, GradleProjectSet | null>;
  maven: Map<string, ReactorProject[] | null>;
}

/**
 * commands/gradle-project-not-found -- a Gradle task path whose PROJECT part
 * names no project of the build. See gradle-projects.ts for what counts as a
 * readable settings file and why everything else is silent.
 *
 * Returns null when `ref` is not a Gradle invocation (or retargets the build
 * with `-p`, `--include-build`, ...), so the caller keeps dispatching.
 */
function checkGradleProjects(
  file: ParsedContextFile,
  ref: CommandReference,
  projectRoot: string,
  cache: JvmBuildCache,
): LintIssue[] | null {
  const refs = gradleProjectRefs(ref.value);
  if (refs === null) return null;
  if (refs.length === 0 || cdEarlierInFence(file.content, ref.line)) return [];

  // `./gradlew` runs only where the wrapper is; plain `gradle` runs anywhere.
  const wrapper = gradleUsesWrapper(ref.value);
  const buildRoot = findGradleBuildRoot(file.filePath, projectRoot, wrapper);
  if (!buildRoot) return [];
  if (!cache.gradle.has(buildRoot)) cache.gradle.set(buildRoot, readGradleProjectSet(buildRoot));
  const set = cache.gradle.get(buildRoot);
  if (!set) return [];

  // A relative path (`clients:test`) resolves against the project of the
  // directory Gradle runs in. Only a context file sitting in the build root
  // pins that directory; elsewhere it is a guess, so skip relative paths.
  const atBuildRoot = path.resolve(path.dirname(file.filePath)) === path.resolve(buildRoot);

  const issues: LintIssue[] = [];
  for (const projectRef of refs) {
    if (!projectRef.absolute && !atBuildRoot) continue;
    const missing = unresolvedGradleProject(projectRef, set);
    if (!missing) continue;
    issues.push({
      severity: 'error',
      check: 'commands',
      ruleId: 'commands/gradle-project-not-found',
      line: ref.line,
      message: `"${ref.value}" — project "${missing}" not found in ${set.settingsFile}`,
      suggestion: closestSuggestion(missing, [...set.paths]),
    });
  }
  return issues;
}

/**
 * commands/maven-module-not-found -- a `-pl` / `-rf` selector that matches no
 * project of the reactor. See maven-modules.ts.
 *
 * Returns null when `ref` is not a Maven invocation (or re-roots the reactor
 * with `-f` / `-N`), so the caller keeps dispatching.
 */
function checkMavenModules(
  file: ParsedContextFile,
  ref: CommandReference,
  projectRoot: string,
  cache: JvmBuildCache,
): LintIssue[] | null {
  const selectors = mavenSelectors(ref.value);
  if (selectors === null) return null;
  if (selectors.length === 0 || cdEarlierInFence(file.content, ref.line)) return [];

  const bases: Array<{ dir: string; reactor: ReactorProject[] }> = [];
  for (const dir of mavenBaseDirs(file.filePath, projectRoot)) {
    if (!fs.existsSync(path.join(dir, 'pom.xml'))) continue;
    // `.mvn/maven.config` is prepended to every invocation; a `-f` or `-pl`
    // there changes what the documented command resolves against.
    if (mavenConfigRetargets(dir)) return [];
    if (!cache.maven.has(dir)) cache.maven.set(dir, readMavenReactor(dir));
    const reactor = cache.maven.get(dir);
    // A POM whose reactor cannot be enumerated might contain the module.
    if (!reactor) return [];
    bases.push({ dir, reactor });
  }
  if (bases.length === 0) return [];

  const issues: LintIssue[] = [];
  for (const { selector, option } of selectors) {
    // Maven 4 collects the reactor from the root even when started in a
    // subdirectory, and a path selector may point at a sibling (`../web`), so
    // each base's paths are matched against every base's projects.
    const allProjects = bases.flatMap((b) => b.reactor);
    if (bases.some((b) => selectorMatches(selector, allProjects, b.dir))) continue;
    // A path that leaves the linted directory from every base names a module
    // this lint cannot see (ctxlint run on `server/`, doc says `-pl ../client`).
    if (!selector.includes(':') && bases.every((b) => outside(projectRoot, b.dir, selector))) {
      continue;
    }
    // Reactor basedirs are real paths (readMavenReactor realpaths every POM);
    // relativize against the base's real path too, or a root reached through
    // a symlink or junction (macOS /var -> /private/var) yields `../../private/...`
    // candidates that never match.
    const baseReal = realPath(bases[0].dir) ?? bases[0].dir;
    const known = bases[0].reactor.flatMap((p) => [
      path.relative(baseReal, p.basedir).replace(/\\/g, '/'),
      ...(p.artifactId && !p.artifactId.includes('${') ? [`:${p.artifactId}`] : []),
    ]);
    issues.push({
      severity: 'error',
      check: 'commands',
      ruleId: 'commands/maven-module-not-found',
      line: ref.line,
      message: `"${ref.value}" — ${option} "${selector}" matches no module in the Maven reactor`,
      suggestion: closestSuggestion(selector, known.filter(Boolean)),
    });
  }
  return issues;
}

/**
 * True when an earlier line of the fenced block holding `line` (1-indexed)
 * changes directory. A snippet like
 *
 *     cd webapp/cas-server-webapp-tomcat
 *     ./gradlew :foo:bootRun
 *
 * runs the build tool somewhere the line itself does not say, so neither the
 * build root nor a relative module path can be trusted. Same fence scoping as
 * pipefailInScope in exit-status.ts.
 */
function cdEarlierInFence(content: string, line: number): boolean {
  const lines = content.split('\n');
  const idx = line - 1;
  const changesDir = (text: string): boolean => /(?:^|[\s;&|(])(?:cd|pushd)(?:\s|$)/.test(text);
  const block = enclosingFence(lines, idx);
  if (block) {
    for (let i = block.open + 1; i < idx; i++) if (changesDir(lines[i])) return true;
    return false;
  }
  // Outside a fence, a run of `$`-prompt lines is one shell session too:
  //     $ cd tools/other-build
  //     $ ./gradlew :foo:check
  for (let i = idx - 1; i >= 0 && /^\s*[$>]\s+\S/.test(lines[i]); i--) {
    if (changesDir(lines[i].replace(/^\s*[$>]\s+/, ''))) return true;
  }
  return false;
}

function outside(projectRoot: string, base: string, selector: string): boolean {
  const rel = path.relative(path.resolve(projectRoot), path.resolve(base, selector));
  return rel.startsWith('..') || path.isAbsolute(rel);
}

function mavenConfigRetargets(dir: string): boolean {
  try {
    const config = fs.readFileSync(path.join(dir, '.mvn', 'maven.config'), 'utf-8');
    // Separate (`-f pom.xml`), `=` and attached (`-fplatform/pom.xml`) forms;
    // `-fae`, `-ff`, `-fn` and `-fos` are fail-mode flags, not `-f`.
    return /(?:^|\s)(?:-f(?!(?:ae|f|n|os)(?:\s|$))|--file|-pl|--projects|-N|--non-recursive)/.test(
      config,
    );
  } catch {
    return false;
  }
}

/** `Did you mean "x"?` for the nearest candidate within a small edit distance. */
function closestSuggestion(target: string, candidates: string[]): string | undefined {
  const best = closestMatch(target, candidates, {
    ignoreCase: true,
    maxDistance: Math.max(2, Math.floor(target.length * 0.3)),
  });
  return best ? `Did you mean "${best.match}"?` : undefined;
}

/** The makefile names GNU make tries, in its own order. */
const MAKEFILE_NAMES = ['GNUmakefile', 'makefile', 'Makefile'];

/**
 * The makefile `make` would read in `dir`, or null when there is none. Names
 * are matched against the directory listing, not opened by name, so a
 * case-insensitive host neither reads `Makefile` as `makefile` (and words the
 * message wrongly) nor finds a `MAKEFILE` that make on Linux would not.
 */
function loadMakefile(dir: string): { name: string; content: string } | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of MAKEFILE_NAMES) {
    if (!entries.includes(name)) continue;
    try {
      return { name, content: stripBom(fs.readFileSync(path.join(dir, name), 'utf-8')) };
    } catch {
      // unreadable (a directory named Makefile, permissions): try the next name
    }
  }
  return null;
}

/**
 * Whether a `make` invocation reads a makefile other than the one in the
 * directory it runs from: `-C dir` / `--directory`, `-f file` / `--file` /
 * `--makefile`, separate or attached, including inside a short-flag bundle
 * (`-kC native`).
 */
function makeRetargets(cmd: string): boolean {
  return cmd
    .split(/\s+/)
    .slice(1)
    .some((t) => /^-[A-Za-z]*[Cf]/.test(t) || /^--(?:directory|file|makefile)(?:=|$)/.test(t));
}

/**
 * Extract the target of a `make` invocation. `NAME=value` overrides are
 * skipped (they don't consume the next token). Any flag token bails out
 * entirely: flags like `-j 4` / `-l 2` take a value, so the first non-flag
 * token may be a flag's argument rather than a target — a skipped validation
 * is safer than reporting a flag (or its value) as missing.
 */
function extractMakeTarget(cmd: string): string | null {
  for (const token of cmd.split(/\s+/).slice(1)) {
    if (token.startsWith('-')) return null;
    if (token.includes('=')) continue;
    return token;
  }
  return null;
}

/**
 * A rule line's target list: everything before the first `:` on a line that
 * does not start with a tab (a recipe). The `(?!:?=)` lookahead keeps
 * `target := value` / `target ::= value` variable assignments from counting
 * as rules; `[^:=#]` keeps `x = a:b` assignments and comments out, and the
 * `\n` in it keeps the match on ONE line -- without it a colon-less line such
 * as `ifeq ($(CI),true)` ran into the next rule's target list, its `$` opened
 * the target set and make-target-not-found never fired. Double-colon rules
 * (`target::`) still match.
 */
const RULE_LINE = /^ *([^\s#:=][^:=#\n]*):(?!:?=)/gm;

/** `include`, `-include` and `sinclude` pull in rules this lint cannot see. */
const INCLUDE_DIRECTIVE = /^ *(?:-|s)?include\s/m;

/**
 * Could `makefile` define `target`? True when some rule line lists it anywhere
 * in its target list (`build test: deps` defines both), or when the target set
 * is open: an include directive, a pattern rule (`%.o: %.c` builds `foo.o`) or
 * a computed target (`$(BIN):`) can each make any name a target, and a wrong
 * "target not found" is worse than silence. `.PHONY: target` lines
 * deliberately do NOT count as defining `target` -- .PHONY only marks
 * phony-ness; without its own rule line the target is still unrunnable.
 */
function makefileMayDefine(makefile: string, target: string): boolean {
  if (INCLUDE_DIRECTIVE.test(makefile)) return true;
  for (const m of makefile.matchAll(RULE_LINE)) {
    const targets = m[1].trim().split(/\s+/);
    if (targets.some((t) => t.includes('%') || t.includes('$'))) return true;
    if (targets.includes(target)) return true;
  }
  return false;
}
