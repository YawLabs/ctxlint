import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { loadPackageJson, stripBom } from '../../utils/fs.js';
import { analyzeMaskedExitStatus, pipefailInScope } from './exit-status.js';
import { findBinInvocations, knownSubcommands, ownedBins } from './cli-subcommands.js';
import type { BinInvocation } from './cli-subcommands.js';
import {
  htmlCommentLineMask,
  htmlCommentSpans,
  inlineCodeSpans,
  maskCodeSpans,
  stripInlineHtmlComments,
} from '../../utils/markdown.js';
import type { ParsedContextFile, LintIssue, CommandReference } from '../types.js';

// Match npm/pnpm/yarn/bun script invocations. `run` is required for npm
// (bare `npm install` is never a script reference), optional for
// pnpm/yarn/bun. Groups: [1] the non-npm manager, [2] an explicit `run`,
// [3] the candidate script name — [1] and [2] let scriptNameFromMatch
// exempt builtin subcommands (`pnpm install`, `yarn add`, ...) from
// script-name validation.
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
 * Resolve the script name from an NPM_SCRIPT_PATTERN match, or null when the
 * captured token is not actually a script name: a flag (`pnpm -r build` —
 * the real script is unknowable without parsing pnpm's flag table), a shared
 * package-manager builtin invoked without an explicit `run`, or a
 * manager-specific builtin (`bun test`).
 */
function scriptNameFromMatch(match: RegExpMatchArray): string | null {
  const [, manager, explicitRun, name] = match;
  if (name.startsWith('-')) return null;
  if (manager && !explicitRun && PM_BUILTIN_SUBCOMMANDS.has(name)) return null;
  if (manager && !explicitRun && isManagerBuiltin(manager, name)) return null;
  return name;
}

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

// Patterns whose validation branch is gated on a parsed package.json. When
// package.json is missing/unparseable every one of these branches silently
// no-ops, so we track whether any reference WOULD have been checked and emit a
// single info diagnostic (asymmetric otherwise with the make-target branch,
// which has its own no-makefile error).
const PKG_DEPENDENT_TOOL_PATTERN = /^(vitest|jest|pytest|mocha|eslint|prettier|tsc)\b/;

// Bin names whose npm package is named differently, consulted before the
// dependency lookup in the tool-availability branch. Without it `tsc` is
// looked up verbatim in deps and any project linted without node_modules
// (fresh checkout, CI) gets a false tool-not-found despite typescript being
// in devDependencies. `tsc` -> `typescript` is the only mapping among
// PKG_DEPENDENT_TOOL_PATTERN's tools (and the npx-branch comment's named
// mappings) where bin and package diverge — vitest/jest/mocha/eslint/prettier
// are identity. The node_modules/.bin fallback keeps using the BIN name.
const BIN_TO_PACKAGE: Record<string, string> = {
  tsc: 'typescript',
};
const PKG_SHORTHAND_PATTERN =
  /^(npm|pnpm|yarn|bun)\s+(test|start|build|dev|lint|format|check|typecheck|clean|serve|preview|e2e)\b/;

function wouldNeedPackageJson(cmd: string): boolean {
  // Builtin subcommands / flag-first invocations are never validated, so
  // they must not trigger the package-json-missing info either.
  const scriptMatch = cmd.match(NPM_SCRIPT_PATTERN);
  if (scriptMatch && scriptNameFromMatch(scriptMatch) !== null) return true;
  const shorthandMatch = cmd.match(PKG_SHORTHAND_PATTERN);
  // A manager-builtin shorthand (`bun test`) is never script-validated, so it
  // would not have been checked even with a package.json — don't surface the
  // skip.
  if (shorthandMatch && !isManagerBuiltin(shorthandMatch[1], shorthandMatch[2])) return true;
  return /^npx\b/.test(cmd) || PKG_DEPENDENT_TOOL_PATTERN.test(cmd);
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
 * false-negative-over-false-positive posture. Known accepted false negative
 * under that posture: "Don't forget to run `npx x`" suppresses even though
 * the command is recommended -- the negation binds to "forget", not the
 * command, and telling those apart needs verb analysis this check
 * deliberately avoids. Complements isDeniedCommand above: that credits an
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
  return PROHIBITION_TOKEN.test(clause);
}

/** `ref.column` is 1-based and points at the first char of the command. */
function isProhibitedRef(lines: string[], ref: CommandReference): boolean {
  return isProhibitedAt(lines[ref.line - 1] ?? '', ref.column - 1);
}

/**
 * BinInvocation carries no column (its candidates are reconstructed from
 * fenced lines and code spans), so locate the command text on its line. A
 * miss yields `false` -- never suppress on a guess.
 */
function isProhibitedInvocation(lines: string[], inv: BinInvocation): boolean {
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
  // Fenced candidates have no prose prefix, and the `$`/`>` prompt form is a
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
  const pkgJson = loadPackageJson(projectRoot);
  const makefile = loadMakefile(projectRoot);
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

  issues.push(
    ...checkUnknownSubcommand(file, projectRoot, pkgJson, deniedPrefixes, contentLines),
  );

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
    const masked = analyzeMaskedExitStatus(cmd, pkgJson?.scripts);
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

    // Check npm/pnpm/yarn script references
    const scriptMatch = cmd.match(NPM_SCRIPT_PATTERN);
    if (scriptMatch && pkgJson) {
      const scriptName = scriptNameFromMatch(scriptMatch);
      if (scriptName && pkgJson.scripts && !(scriptName in pkgJson.scripts)) {
        const available = Object.keys(pkgJson.scripts).join(', ');
        issues.push({
          severity: 'error',
          check: 'commands',
          ruleId: 'commands/script-not-found',
          line: ref.line,
          message: `"${cmd}" — script "${scriptName}" not found in package.json`,
          suggestion: available ? `Available scripts: ${available}` : undefined,
        });
      }
      continue;
    }

    // Check shorthand npm/pnpm/yarn/bun commands that map to scripts
    const shorthandMatch = cmd.match(PKG_SHORTHAND_PATTERN);
    if (shorthandMatch && pkgJson) {
      const manager = shorthandMatch[1];
      const scriptName = shorthandMatch[2];
      if (isManagerBuiltin(manager, scriptName)) continue; // e.g. `bun test`
      if (pkgJson.scripts && !(scriptName in pkgJson.scripts)) {
        issues.push({
          severity: 'error',
          check: 'commands',
          ruleId: 'commands/script-not-found',
          line: ref.line,
          message: `"${cmd}" — script "${scriptName}" not found in package.json`,
        });
      }
      continue;
    }

    // Check npx package references
    if (/^npx\b/.test(cmd) && pkgJson) {
      const pkgName = extractNpxPackage(cmd);
      if (!pkgName) continue;

      const allDeps = {
        ...pkgJson.dependencies,
        ...pkgJson.devDependencies,
        ...pkgJson.peerDependencies,
        ...pkgJson.optionalDependencies,
      };

      // Normalize: npx packages may be invoked by bin name which differs from package name
      // Common mappings: tsc -> typescript, prettier -> prettier, etc.
      // Only warn if the package isn't in deps AND isn't in node_modules/.bin
      if (!(pkgName in allDeps)) {
        // Denied/prohibited commands were already skipped by the shared gate
        // above the dispatch.
        const binPath = path.join(projectRoot, 'node_modules', '.bin', pkgName);
        try {
          fs.accessSync(binPath);
        } catch {
          issues.push({
            severity: 'warning',
            check: 'commands',
            ruleId: 'commands/npx-not-in-deps',
            line: ref.line,
            message: `"${cmd}" — "${pkgName}" not found in dependencies`,
            suggestion:
              'If this is a global tool, consider adding it to devDependencies for reproducibility',
          });
        }
      }
      continue;
    }

    // Check Makefile targets
    if (MAKE_PATTERN.test(cmd)) {
      if (!makefile) {
        issues.push({
          severity: 'error',
          check: 'commands',
          ruleId: 'commands/no-makefile',
          line: ref.line,
          message: `"${cmd}" — no Makefile found in project`,
        });
      } else {
        const target = extractMakeTarget(cmd);
        if (target && !hasMakeTarget(makefile, target)) {
          issues.push({
            severity: 'error',
            check: 'commands',
            ruleId: 'commands/make-target-not-found',
            line: ref.line,
            message: `"${cmd}" — target "${target}" not found in Makefile`,
          });
        }
      }
      continue;
    }

    // Check common tool availability
    const toolMatch = cmd.match(PKG_DEPENDENT_TOOL_PATTERN);
    if (toolMatch && pkgJson) {
      const tool = toolMatch[1];
      const pkgName = BIN_TO_PACKAGE[tool] ?? tool;
      const allDeps = {
        ...pkgJson.dependencies,
        ...pkgJson.devDependencies,
        ...pkgJson.peerDependencies,
        ...pkgJson.optionalDependencies,
      };
      if (!(pkgName in allDeps)) {
        // Check node_modules/.bin
        const binPath = path.join(projectRoot, 'node_modules', '.bin', tool);
        try {
          fs.accessSync(binPath);
        } catch {
          issues.push({
            severity: 'warning',
            check: 'commands',
            ruleId: 'commands/tool-not-found',
            line: ref.line,
            message: `"${cmd}" — "${tool}" not found in dependencies or node_modules/.bin`,
          });
        }
      }
    }
  }

  return issues;
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

  const invocations = findBinInvocations(file.content, new Set(bins.map((b) => b.name)));
  if (invocations.length === 0) return [];

  // Resolve each bin's dispatch table at most once per file.
  const resolved = new Map<string, Set<string> | null>();
  const issues: LintIssue[] = [];

  for (const inv of invocations) {
    // Same resolvability gate as the main dispatch loop: an invocation the doc
    // cites only to forbid ("NEVER run `ctxlint doctor`") is not a broken doc.
    if (isDeniedCommand(inv.cmd, deniedPrefixes)) continue;
    if (isProhibitedInvocation(contentLines, inv)) continue;
    if (!resolved.has(inv.bin)) {
      const bin = bins.find((b) => b.name === inv.bin);
      resolved.set(inv.bin, bin ? knownSubcommands(projectRoot, bin.entry) : null);
    }
    const known = resolved.get(inv.bin);
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

function loadMakefile(projectRoot: string): string | null {
  try {
    return stripBom(fs.readFileSync(path.join(projectRoot, 'Makefile'), 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Extract the target of a `make` invocation. `NAME=value` overrides are
 * skipped (they don't consume the next token). Any flag token bails out
 * entirely: flags like `-C dir` / `-f file` take a value, so the first
 * non-flag token may be a flag's argument rather than a target — a skipped
 * validation is safer than reporting a flag (or its value) as missing.
 */
function extractMakeTarget(cmd: string): string | null {
  for (const token of cmd.split(/\s+/).slice(1)) {
    if (token.startsWith('-')) return null;
    if (token.includes('=')) continue;
    return token;
  }
  return null;
}

function hasMakeTarget(makefile: string, target: string): boolean {
  // Match "target:" at the start of a line (standard rule syntax, including
  // double-colon rules). The (?!:?=) lookahead keeps `target := value` /
  // `target ::= value` variable assignments from counting as rules. `.PHONY:
  // target` lines deliberately do NOT count — .PHONY only marks phony-ness;
  // without its own rule line the target is still unrunnable.
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escaped}\\s*:(?!:?=)`, 'm');
  return pattern.test(makefile);
}
