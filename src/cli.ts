import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { Command, Option } from 'commander';
import ora from 'ora';
import { resetPathsCache } from './core/checks/paths.js';
import { clearTranscriptCache } from './core/transcript.js';
import { formatText, formatJson, formatTokenReport, formatSarif } from './core/reporter.js';
import { applyFixes } from './core/fixer.js';
import { freeEncoder } from './utils/tokens.js';
import { resetGit } from './utils/git.js';
import { IGNORED_DIRS, resetPackageJsonCache } from './utils/fs.js';
import { loadConfig, loadConfigFromExplicitPath } from './core/config.js';
import { scanForContextFiles, scanForMcpConfigs } from './core/scanner.js';
import {
  runAudit,
  type AuditOptions,
  ALL_CHECKS,
  ALL_MCP_CHECKS,
  ALL_SESSION_CHECKS,
  ALL_SKILL_CHECKS,
} from './core/audit.js';
import type { LintOptions, CheckName } from './core/types.js';
import * as path from 'node:path';
import { VERSION } from './version.js';

const VALID_CHECKS = new Set<string>([
  ...ALL_CHECKS,
  ...ALL_MCP_CHECKS,
  ...ALL_SESSION_CHECKS,
  ...ALL_SKILL_CHECKS,
]);

/** True when `p` exists and is a directory (not a file, not a dangling link). */
function existsAsDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function validateCheckNames(names: string[], source: string): CheckName[] {
  const invalid = names.filter((n) => n && !VALID_CHECKS.has(n));
  if (invalid.length > 0) {
    console.error(
      `Error: unknown check name${invalid.length > 1 ? 's' : ''} in ${source}: ${invalid.join(', ')}`,
    );
    console.error(`Valid checks: ${[...VALID_CHECKS].join(', ')}`);
    process.exit(2);
  }
  return names.filter((n) => n) as CheckName[];
}

export async function runCli() {
  const program = new Command();

  program
    .name('ctxlint')
    .description(
      'Lint your AI agent context files and MCP server configs against your actual codebase',
    )
    .version(VERSION)
    .argument('[path]', 'Project directory to scan', '.')
    .option('--strict', 'Exit code 1 on any warning or error (for CI)', false)
    .option('--checks <checks>', 'Comma-separated list of checks to run', '')
    .addOption(
      new Option('--format <format>', 'Output format: text, json, or sarif')
        .choices(['text', 'json', 'sarif'])
        .default('text'),
    )
    .option('--tokens', 'Show token breakdown per file', false)
    .option('--verbose', 'Show passing checks too', false)
    .option('--fix', 'Auto-fix broken paths using git history and fuzzy matching', false)
    .option('--fix-dry-run', 'Preview --fix changes without writing', false)
    .option('--yes', 'Skip interactive confirmation prompts (required for --fix in TTY)', false)
    .option('--follow-symlinks', 'Allow --fix to write through symlinks (default: skip)', false)
    .option('--ignore <checks>', 'Comma-separated list of checks to ignore', '')
    .option('--quiet', 'Suppress all output except errors (exit code only)', false)
    .option('--config <path>', 'Path to config file (default: .ctxlintrc in project root)')
    // The default's own description, not the raw '2': commander renders a
    // string default as `(default: "2")`, and the old description carried a
    // second hand-written "(default: 2)" on top of it.
    .addOption(new Option('--depth <n>', 'Max subdirectory depth to scan').default('2', '2'))
    .option('--mcp', 'Enable MCP config linting alongside context file checks', false)
    .option('--mcp-only', 'Run only MCP config checks, skip context file checks', false)
    .option('--mcp-global', 'Also scan user/global MCP config files (implies --mcp)', false)
    // --mcp-server is intercepted in src/index.ts BEFORE commander runs (it's
    // a sibling of the `serve` subcommand). Declared here only so --help lists
    // it and unknown-flag handling doesn't reject it. The action handler below
    // never sees this flag; if you refactor index.ts to always route through
    // commander, also wire startServer() into the action handler.
    .option('--mcp-server', 'Start the MCP server (alias: `ctxlint serve`)')
    // --lsp is intercepted in src/index.ts BEFORE commander runs (same pattern
    // as --mcp-server). Declared here only so --help lists it.
    .option('--lsp', 'Start in LSP server mode (JSON-RPC over stdio for editor integration)')
    .option('--session', 'Run session audit checks (cross-project consistency)', false)
    .option('--session-only', 'Run only session checks, skip context and MCP checks', false)
    .option('--skills', 'Run agent-skill checks (~/.claude/skills + ~/.claude/agents)', false)
    .option('--skills-only', 'Run only agent-skill checks, skip everything else', false)
    .option(
      '--hooks-global',
      'Also scan the user-global ~/.claude/settings.json in the dead-hook check (off by default; the standard run only reads project .claude/settings.json[.local])',
      false,
    )
    .option('--no-ignore-file', 'Disable .ctxlintignore suppression (see all findings)')
    .option('--watch', 'Re-lint on context file changes', false)
    .action(async (projectPath: string, opts: Record<string, unknown>) => {
      const resolvedPath = path.resolve(projectPath as string);

      // A path that does not exist must not read as a clean run. Without this
      // the scan simply finds nothing and prints "No context files found." with
      // exit 0 -- byte-identical to a genuinely empty project, so a typo'd path
      // in a CI step or a pre-commit hook reports success forever. Exit 2 is
      // the documented "invalid CLI option" code, matching validateCheckNames
      // and the bad-`--config` path. The MCP server already rejects this at its
      // own boundary (validateProjectPath); this closes the CLI side of the
      // same gap.
      if (!existsAsDirectory(resolvedPath)) {
        console.error(
          `Error: ${resolvedPath} is not an existing directory. Check the path argument.`,
        );
        process.exit(2);
      }

      // Resolve the config + folded options + active-check list. Extracted so
      // watch mode can re-resolve on every rerun and pick up live edits to
      // .ctxlintrc / .ctxlintrc.json without restarting the process.
      const { config, options, activeChecks } = resolveSession(resolvedPath, opts);

      const spinner =
        options.format === 'text' && !options.quiet
          ? ora('Scanning for context files...').start()
          : undefined;

      try {
        if (spinner) spinner.text = 'Running checks...';

        // Shared by the initial audit, the post-`--fix` re-audit below and
        // every watch rerun, so all of them see identical scope/threshold/
        // ignore settings.
        const auditOptions = buildAuditOptions(config, options);
        let result = await runAudit(resolvedPath, activeChecks, auditOptions);

        spinner?.stop();

        // Nothing to fix and nothing to report: the payload printed here is
        // the whole output. The fix and Output blocks below are skipped, so a
        // --watch run (which carries on past this point) does not print the
        // same JSON / SARIF document a second time.
        const empty = result.files.length === 0;
        if (empty) {
          if (!options.quiet) printReport(result, options);
          if (!opts.watch) return;
        }

        // Apply fixes if requested. --fix-dry-run previews only. --fix writes,
        // but in an interactive terminal we first preview, then prompt unless
        // --yes is passed. CI (no TTY) behavior is unchanged: --fix writes
        // directly.
        const dryRunFlag = (opts.fixDryRun as boolean) || false;
        const followSymlinks = (opts.followSymlinks as boolean) || false;
        const confirmFirst = needsFixConfirmation(opts);
        // In json/sarif mode stdout must carry ONLY the payload: fix-progress
        // text goes to stderr, and applyFixes' own per-fix stdout lines are
        // silenced via quiet. Otherwise `--fix --format json | jq` breaks on
        // "Fixed N issues..." interleaved before the JSON document.
        const machineFormat = options.format !== 'text';
        const progress = machineFormat ? console.error : console.log;

        let fixesApplied = false;
        if (!empty && (dryRunFlag || options.fix)) {
          const commonOpts = {
            quiet: options.quiet || machineFormat,
            skipSymlinks: !followSymlinks,
          };

          if (dryRunFlag) {
            const preview = applyFixes(result, { ...commonOpts, dryRun: true });
            if (!options.quiet) {
              if (preview.totalFixes === 0) {
                progress('\nNo auto-fixable issues.\n');
              } else {
                progress(
                  `\nWould fix ${preview.totalFixes} issue${preview.totalFixes !== 1 ? 's' : ''} in ${preview.filesModified.length} file${preview.filesModified.length !== 1 ? 's' : ''}. (dry-run — no files modified)\n`,
                );
              }
            }
          } else if (options.fix) {
            if (confirmFirst) {
              // Show a preview, then ask for confirmation before writing.
              // --quiet silences the surrounding progress text but not the
              // question itself: quiet is not consent (only --yes is).
              const say = options.quiet ? () => {} : progress;
              const preview = applyFixes(result, { ...commonOpts, dryRun: true });
              if (preview.totalFixes === 0) {
                say('\nNo auto-fixable issues.\n');
              } else {
                say(
                  `\n${preview.totalFixes} fix${preview.totalFixes !== 1 ? 'es' : ''} proposed across ${preview.filesModified.length} file${preview.filesModified.length !== 1 ? 's' : ''}.`,
                );
                const confirmed = await promptYesNo(
                  'Apply these fixes? Re-run with --yes to skip this prompt. [y/N] ',
                );
                if (!confirmed) {
                  say('Aborted. No files modified.\n');
                } else {
                  const applied = applyFixes(result, commonOpts);
                  say(
                    `\nFixed ${applied.totalFixes} issue${applied.totalFixes !== 1 ? 's' : ''} in ${applied.filesModified.length} file${applied.filesModified.length !== 1 ? 's' : ''}.\n`,
                  );
                  fixesApplied = applied.totalFixes > 0;
                }
              }
            } else {
              // Non-interactive (CI) or --yes: apply directly.
              const applied = applyFixes(result, commonOpts);
              if (applied.totalFixes > 0 && !options.quiet) {
                progress(
                  `\nFixed ${applied.totalFixes} issue${applied.totalFixes !== 1 ? 's' : ''} in ${applied.filesModified.length} file${applied.filesModified.length !== 1 ? 's' : ''}.\n`,
                );
              }
              fixesApplied = applied.totalFixes > 0;
            }
          }
        }

        // --fix rewrote files on disk, so the pre-fix audit no longer
        // describes the project. Re-run it so the printed report and the
        // --strict exit code reflect post-fix state -- otherwise issues that
        // were just repaired are still reported as present and still fail
        // --strict.
        if (fixesApplied) {
          resetGit();
          resetPathsCache();
          resetPackageJsonCache();
          result = await runAudit(resolvedPath, activeChecks, auditOptions);
        }

        // Output
        if (!options.quiet && !empty) printReport(result, options);

        // Exit code (skip in watch mode — don't exit on errors)
        if (
          !opts.watch &&
          options.strict &&
          (result.summary.errors > 0 || result.summary.warnings > 0)
        ) {
          process.exitCode = 1;
        }
      } catch (err) {
        spinner?.stop();
        console.error('Error:', err instanceof Error ? err.message : err);
        if (!opts.watch) process.exitCode = 2;
      } finally {
        freeEncoder();
        resetGit();
        resetPathsCache();
        resetPackageJsonCache();
        // Memoized transcript read: a watch rerun must see transcripts that
        // grew since this run, not this run's snapshot.
        clearTranscriptCache();
      }

      if (opts.watch) {
        await watchProject(resolvedPath, opts, { config, options, activeChecks });
      }
    });

  program
    .command('init')
    .description('Set up a git pre-commit hook that runs ctxlint --strict')
    .argument('[path]', 'Project directory', '.')
    .action(async (projectPath: string) => {
      const resolvedRoot = path.resolve(projectPath);
      if (!existsAsDirectory(resolvedRoot)) {
        console.error(
          `Error: ${resolvedRoot} is not an existing directory. Check the path argument.`,
        );
        process.exit(2);
      }

      // Ask git where it runs hooks from rather than assuming <path>/.git/hooks:
      // that assumption crashed with ENOTDIR in a linked worktree or submodule
      // (.git is a file there), reported success while git ran a different
      // directory under core.hooksPath, and failed outright from a
      // subdirectory of the repo. `--git-path hooks` covers all three; its
      // output is relative to the directory git ran in.
      const hooksDir = resolveHooksDir(resolvedRoot);
      if (hooksDir === null) {
        console.error('Error: not a git repository. Run "git init" first.');
        process.exit(1);
      }

      fs.mkdirSync(hooksDir, { recursive: true });

      const hookPath = path.join(fs.realpathSync(hooksDir), 'pre-commit');
      // Pin the hook to the version of ctxlint that wrote it, so a repo
      // checked out months later doesn't silently pull a newer ctxlint whose
      // rule set drifted. Users can re-run `ctxlint init` to bump the pin.
      // --yes: a hook has no terminal to answer npx's install prompt, so on a
      // machine without the pinned version cached the commit would stall.
      const fullHookContent = `#!/bin/sh
# ctxlint pre-commit hook
npx --yes @yawlabs/ctxlint@${VERSION} --strict
`;
      const appendHookContent = `
# ctxlint pre-commit hook
npx --yes @yawlabs/ctxlint@${VERSION} --strict
`;

      if (fs.existsSync(hookPath)) {
        const existing = fs.readFileSync(hookPath, 'utf-8');
        // Detect the actual hook command (a non-comment `npx @yawlabs/ctxlint`
        // invocation), not any 'ctxlint' substring -- a hook that merely
        // mentions ctxlint in a comment or an unrelated tool name still needs
        // the real command appended.
        const installed = existing.match(
          /^[^#\r\n]*\bnpx\s+(?:-y\s+|--yes\s+)?@yawlabs\/ctxlint(?:@(\d+\.\d+\.\d+))?/m,
        );
        if (installed) {
          const pinned = installed[1];
          if (pinned && pinned !== VERSION) {
            // Re-running init is the documented way to bump the pin.
            fs.writeFileSync(
              hookPath,
              existing.replace(/(@yawlabs\/ctxlint@)\d+\.\d+\.\d+/g, `$1${VERSION}`),
            );
            console.log(`Updated ctxlint pre-commit hook pin from ${pinned} to ${VERSION}.`);
          } else {
            console.log('Pre-commit hook already includes ctxlint.');
          }
          console.log(`Hook: ${hookPath}`);
          return;
        }
        // Append to existing hook (without shebang — the existing hook already has one)
        fs.appendFileSync(hookPath, appendHookContent);
        console.log('Added ctxlint to existing pre-commit hook.');
        console.log(`Hook: ${hookPath}`);
      } else {
        fs.writeFileSync(hookPath, fullHookContent, { mode: 0o755 });
        console.log(`Created pre-commit hook at ${hookPath}`);
      }

      console.log('ctxlint will now run automatically before each commit.');
    });

  // parseAsync, not parse: every action is async, and parse() returns before
  // they settle, so a throw inside one became an unhandled rejection (a raw
  // stack trace and exit 1). Report it the way every other failure is
  // reported: one line on stderr, exit 2.
  try {
    await program.parseAsync();
  } catch (err) {
    console.error('Error:', err instanceof Error ? err.message : err);
    process.exitCode = 2;
  }
}

/**
 * The directory git runs hooks from for the repo containing `cwd`, honouring
 * linked worktrees, submodules and core.hooksPath; null outside a repo. Any
 * other git failure (a corrupt config, safe.directory "dubious ownership")
 * throws with git's own message: "run git init" would be wrong advice there.
 */
function resolveHooksDir(cwd: string): string | null {
  let out: string;
  try {
    out = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('git was not found on PATH; it is required to install a pre-commit hook.', {
        cause: err,
      });
    }
    const stderr = String((err as { stderr?: unknown }).stderr ?? '').trim();
    if (/not a git repository/i.test(stderr)) return null;
    throw new Error(`git rev-parse --git-path hooks failed: ${stderr || String(err)}`, {
      cause: err,
    });
  }
  const rel = out.trim();
  return rel ? path.resolve(cwd, rel) : null;
}

/**
 * Whether `--fix` must preview and ask before writing. Only when someone can
 * answer: the prompt READS stdin, so both ends must be terminals. `--quiet`
 * does not waive it -- quiet silences output, it is not consent; only `--yes`
 * is. Takes the action's raw commander flags and is called verbatim at the
 * call site, so the tests pin the real gate. Exported for the tests: spawned
 * runs cannot fake a TTY.
 */
export function needsFixConfirmation(
  opts: Record<string, unknown>,
  io: { stdin: { isTTY?: boolean }; stdout: { isTTY?: boolean } } = process,
): boolean {
  return !!io.stdin.isTTY && !!io.stdout.isTTY && !opts.yes;
}

/**
 * Prompt the user for a yes/no answer on a TTY. Defaults to no if the response
 * is anything other than an affirmative ('y' / 'yes', case-insensitive), and
 * when input ends before any answer (Ctrl+D, a closed stdin): an unanswered
 * question otherwise never settles, and the CLI exited 0 with no report. Only
 * called when needsFixConfirmation() is true.
 *
 * The prompt is written to stderr: in json/sarif mode stdout must carry ONLY
 * the payload (the invariant the `machineFormat` routing above enforces), and
 * a TTY renders stderr inline so text mode loses nothing. Exported because
 * the prompt path needs a TTY stdout that spawned e2e tests can't fake.
 */
export async function promptYesNo(question: string): Promise<boolean> {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise<boolean>((resolve) => {
    // First settle wins: an answer closes the interface below, and that
    // close must not turn a "yes" into a "no".
    rl.once('close', () => resolve(false));
    rl.question(question, (answer) => {
      resolve(/^\s*y(es)?\s*$/i.test(answer));
      rl.close();
    });
  });
}

/**
 * Print one run's report in the session's format. Shared by the initial run
 * and every watch rerun. An empty result prints the empty JSON / SARIF
 * document in machine formats (a rerun used to print the text notice there).
 */
function printReport(result: Awaited<ReturnType<typeof runAudit>>, options: LintOptions): void {
  if (result.files.length === 0) {
    if (options.format === 'json') console.log(formatJson(result));
    else if (options.format === 'sarif') console.log(formatSarif(result));
    else console.log('\nNo context files found.\n');
  } else if (options.tokensOnly) {
    console.log(formatTokenReport(result));
  } else if (options.format === 'json') {
    console.log(formatJson(result));
  } else if (options.format === 'sarif') {
    console.log(formatSarif(result));
  } else {
    console.log(formatText(result, options.verbose));
  }
}

/**
 * The runAudit options for one resolved session. The single builder for the
 * initial run, the post-`--fix` re-audit and every watch rerun, so their
 * scope / threshold / ignore settings cannot drift apart.
 */
function buildAuditOptions(config: ResolvedSession['config'], options: LintOptions): AuditOptions {
  return {
    depth: options.depth,
    extraPatterns: config?.contextFiles,
    exclude: config?.exclude,
    mcp: options.mcp,
    mcpGlobal: options.mcpGlobal,
    mcpOnly: options.mcpOnly,
    session: options.session,
    sessionOnly: options.sessionOnly,
    skills: options.skills,
    skillsOnly: options.skillsOnly,
    hooksGlobal: options.hooksGlobal,
    tokenThresholds: config?.tokenThresholds,
    ignoreRules: config?.ignoreRules,
    noIgnoreFile: options.noIgnoreFile,
  };
}

// Project files whose edits always re-lint although the scanner never returns
// them: the config, the suppression file, the package.json the commands check
// reads, and the Claude settings hook-coverage / commands / tier-tokens read.
const WATCH_ALWAYS = new Set([
  'package.json',
  '.ctxlintrc',
  '.ctxlintrc.json',
  '.ctxlintignore',
  '.claude/settings.json',
  '.claude/settings.local.json',
]);
// Directories whose contents are check inputs: the workflows ci-coverage /
// ci-secrets read, and the hook scripts hook-coverage resolves (a dead-hook
// finding clears when the script appears).
const WATCH_ALWAYS_DIRS = ['.github/workflows', '.claude/hooks'];

/** True when `rel` is (or is inside, or is a parent of) an always-relevant input. */
function alwaysRelevant(rel: string): boolean {
  if (WATCH_ALWAYS.has(rel)) return true;
  return WATCH_ALWAYS_DIRS.some(
    (d) => rel === d || rel.startsWith(`${d}/`) || d.startsWith(`${rel}/`),
  );
}

/** Forward-slash project-relative form of `abs`, or null when it lies outside. */
function projectRelative(root: string, abs: string): string | null {
  const rel = path.relative(root, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.replace(/\\/g, '/');
}

/**
 * The project files this session lints, as the scanner itself finds them
 * (built-in patterns, `contextFiles`, `exclude`, `--depth`), plus the MCP
 * configs when MCP checks run. The watcher filters events through this rather
 * than a hand-kept copy of the scanner's file list.
 */
async function discoverLintedFiles(root: string, session: ResolvedSession): Promise<Set<string>> {
  const { config, options } = session;
  const files = await scanForContextFiles(root, {
    depth: options.depth,
    extraPatterns: config?.contextFiles,
    exclude: config?.exclude,
  });
  if (options.mcp) files.push(...(await scanForMcpConfigs(root, { exclude: config?.exclude })));
  return new Set(files.map((f) => f.relativePath));
}

/** True when `rel` is in `set`, or is a directory holding an entry of it (a renamed / deleted dir). */
function touches(set: Set<string>, rel: string): boolean {
  if (set.has(rel)) return true;
  const prefix = `${rel}/`;
  for (const entry of set) if (entry.startsWith(prefix)) return true;
  return false;
}

/**
 * Watch every directory of the project tree except IGNORED_DIRS, reporting
 * changes as forward-slash project-relative paths (null: an event with no
 * filename). `onError` gets a failure that leaves the tree unwatched.
 *
 * win32 / darwin: one native recursive fs.watch on the root (kernel-backed,
 * one handle; ignored dirs are filtered after the event). Elsewhere (Linux),
 * Node emulates `recursive` by watching every subdirectory with no ignore
 * option -- node_modules included -- which is slow on a big repo and can
 * exhaust the inotify watch limit (ENOSPC). There this watches each
 * non-ignored directory itself and adds watchers for directories created
 * later. Exported for the tests, which force either mode.
 */
export function watchTree(
  root: string,
  onChange: (rel: string | null) => void,
  onError: (err: Error) => void,
  recursive: boolean = process.platform === 'win32' || process.platform === 'darwin',
): { close(): void; dirs(): string[] } {
  if (recursive) {
    const w = fs.watch(root, { recursive: true }, (_event, filename) => {
      onChange(filename ? filename.toString().replace(/\\/g, '/') : null);
    });
    w.on('error', onError);
    return { close: () => w.close(), dirs: () => [root] };
  }

  const watched = new Map<string, fs.FSWatcher>();
  let closed = false;
  const drop = (dir: string) => {
    const w = watched.get(dir);
    if (!w) return;
    watched.delete(dir);
    try {
      w.close();
    } catch {
      // Already closed.
    }
  };
  const add = (dir: string) => {
    if (closed || watched.has(dir)) return;
    let w: fs.FSWatcher;
    try {
      w = fs.watch(dir, (_event, filename) => {
        if (!filename) {
          onChange(null);
          return;
        }
        const abs = path.join(dir, filename.toString());
        const rel = projectRelative(root, abs);
        if (rel === null) return;
        onChange(rel);
        // A directory created (or moved in) since start: watch it and the
        // tree under it. One that disappeared: drop its watchers.
        if (existsAsDirectory(abs)) {
          if (!rel.split('/').some((seg) => IGNORED_DIRS.has(seg))) addTreeSafe(abs);
        } else
          for (const d of [...watched.keys()])
            if (d === abs || d.startsWith(abs + path.sep)) drop(d);
      });
    } catch (err) {
      // A subdirectory that vanished between listing and watching: nothing
      // to watch. Any other failure (ENOSPC, a missing root) is the caller's.
      if (dir !== root && (err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    w.on('error', (err) => {
      // A subdirectory removed under its watcher is not a failure.
      if (dir !== root && !existsAsDirectory(dir)) drop(dir);
      else onError(err);
    });
    watched.set(dir, w);
  };
  const addTree = (dir: string) => {
    add(dir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // Dirent.isDirectory() is false for a symlink, so links are not followed.
      if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name)) addTree(path.join(dir, entry.name));
    }
  };
  const addTreeSafe = (dir: string) => {
    try {
      addTree(dir);
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  };
  // The initial walk throws to the caller (e.g. ENOSPC); later additions,
  // from inside an event, report through onError.
  addTree(root);
  return {
    close: () => {
      closed = true;
      for (const d of [...watched.keys()]) drop(d);
    },
    dirs: () => [...watched.keys()],
  };
}

/**
 * --watch: re-lint whenever a file this session lints changes, appears or
 * disappears, or another check input (config, ignore file, package.json,
 * Claude settings, workflows, hook scripts) changes. The whole project tree
 * is watched (see watchTree), so nested context files, `contextFiles`
 * patterns and files created after start are all seen, and a rename-on-save
 * editor does not leave a per-file watcher deaf. Events are debounced and
 * filtered through discoverLintedFiles; reruns are serialized. A watcher
 * failure exits 2. Never returns otherwise: exits via SIGINT / SIGTERM.
 */
async function watchProject(
  resolvedPath: string,
  opts: Record<string, unknown>,
  initial: ResolvedSession,
): Promise<void> {
  const chalk = (await import('chalk')).default;
  let session = initial;
  // json / sarif: stdout carries only the report documents.
  const status = initial.options.format === 'text' ? console.log : console.error;
  const banner = () => {
    if (!session.options.quiet) status(chalk.dim('\nWatching for changes... (Ctrl+C to stop)\n'));
  };

  // An explicit --config is re-read on every rerun, so its edits must trigger
  // one, wherever it lives.
  const configPath = opts.config ? path.resolve(opts.config as string) : undefined;
  const configRel = configPath ? projectRelative(resolvedPath, configPath) : null;

  let known = new Set<string>();
  try {
    known = await discoverLintedFiles(resolvedPath, session);
  } catch {
    // The first relevant-looking event rescans.
  }

  const isIgnored = (rel: string) => rel.split('/').some((seg) => IGNORED_DIRS.has(seg));

  // `null`: an event that carried no filename (allowed by fs.watch) -- re-lint.
  const isRelevant = async (changed: Array<string | null>): Promise<boolean> => {
    if (changed.includes(null)) return true;
    const rels = (changed as string[]).filter((r) => !isIgnored(r));
    if (rels.length === 0) return false;
    if (rels.some((r) => alwaysRelevant(r) || r === configRel || touches(known, r))) return true;
    // Not linked to anything linted so far: relevant only if the scanner
    // picks it up now (a context file created since the last run).
    try {
      const now = await discoverLintedFiles(resolvedPath, session);
      return rels.some((r) => touches(now, r));
    } catch {
      return true;
    }
  };

  const relint = async () => {
    if (process.stdout.isTTY) console.clear();
    // Re-resolve on every rerun so live edits to .ctxlintrc / .ctxlintrc.json
    // (thresholds, ignore list, check overrides) take effect without
    // restarting the watcher. The CLI flags (`opts`) are fixed for the
    // session, so the config file and the project tree are the moving parts.
    try {
      session = resolveSession(resolvedPath, opts, true);
    } catch (err) {
      // A bad .ctxlintrc edit (invalid JSON, unknown check name) shouldn't
      // kill the watcher. Surface the error and keep the previous
      // resolution active until the user fixes the config.
      console.error('Error reloading config:', err instanceof Error ? err.message : err);
    }
    try {
      const result = await runAudit(
        resolvedPath,
        session.activeChecks,
        buildAuditOptions(session.config, session.options),
      );
      // Honor --quiet on every rerun, matching the initial run.
      if (!session.options.quiet) printReport(result, session.options);
    } catch (err) {
      console.error('Error:', err instanceof Error ? err.message : err);
    } finally {
      freeEncoder();
      resetGit();
      resetPathsCache();
      resetPackageJsonCache();
      clearTranscriptCache();
    }
    try {
      known = await discoverLintedFiles(resolvedPath, session);
    } catch {
      // Keep the previous set.
    }
    banner();
  };

  const pending = new Set<string | null>();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let queue: Promise<void> = Promise.resolve();
  const onEvent = (rel: string | null) => {
    pending.add(rel);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      const changed = [...pending];
      pending.clear();
      queue = queue.then(async () => {
        if (await isRelevant(changed)) await relint();
      });
    }, 300);
  };

  const watchers: Array<{ close(): void }> = [];
  const onWatchError = (err: Error) => console.error('Watch error:', err.message);
  // A failed project watcher is deaf from then on: stop with an error rather
  // than keep printing a banner that promises reruns that never come.
  const fatal = (err: unknown) => {
    console.error(
      `Error: cannot watch ${resolvedPath}: ${err instanceof Error ? err.message : err}`,
    );
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        // Already closed.
      }
    }
    process.exit(2);
  };
  try {
    watchers.push(watchTree(resolvedPath, onEvent, fatal));
  } catch (err) {
    fatal(err);
  }
  if (configPath && configRel === null) {
    try {
      const base = path.basename(configPath);
      const w = fs.watch(path.dirname(configPath), (_event, filename) => {
        if (!filename || filename.toString() === base) onEvent(null);
      });
      w.on('error', onWatchError);
      watchers.push(w);
    } catch (err) {
      console.error(
        `Warning: cannot watch ${configPath}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  banner();

  // Close watchers on SIGINT / SIGTERM so the process exits cleanly
  // without leaking file-watch handles. `once` avoids double-close if
  // the user hammers Ctrl+C; the handlers remove themselves afterward.
  const shutdown = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        // Already closed — ignore.
      }
    }
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  // The watchers keep the event loop alive; this keeps the action pending so
  // nothing after it runs.
  await new Promise(() => {});
}

/**
 * Parse `--depth`. 0 is a valid value (root-only scan), so the fallback test
 * is NaN, not falsiness -- `parseInt('0') || 2` used to silently coerce a
 * requested 0 back to the default. Clamped to [0, 10].
 */
function resolveDepth(raw: string): number {
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? 2 : Math.max(0, Math.min(parsed, 10));
}

interface ResolvedSession {
  config: ReturnType<typeof loadConfig>;
  options: LintOptions;
  activeChecks: CheckName[];
}

/**
 * Fold CLI flags + config-file booleans + explicit --checks list into the
 * single source of truth used by the audit pipeline. Pure: doesn't apply
 * token thresholds (the caller does, after deciding whether it's the
 * initial run or a watch-mode rerun).
 *
 * Invalid check names always `process.exit(2)` via validateCheckNames (they
 * never throw), so they don't need a watch-mode rethrow path — `--checks` is
 * fixed across a watch session, so a name that validated on the initial run
 * stays valid for every rerun. The rethrow-on-watch path is for a bad explicit
 * `--config`: when `throwOnConfigError` is set (watch reruns), loadConfigFromPath
 * rethrows instead of process.exit(2) so the rerun try/catch can survive it and
 * keep the previous resolution active; the initial run leaves it false for the
 * clean console.error + exit(2) path.
 */
function resolveSession(
  resolvedPath: string,
  opts: Record<string, unknown>,
  throwOnConfigError = false,
): ResolvedSession {
  const configPath = opts.config ? path.resolve(opts.config as string) : undefined;
  const config = configPath
    ? loadConfigFromPath(configPath, throwOnConfigError)
    : loadDiscoveredConfig(resolvedPath, throwOnConfigError);

  // Fold config-sourced booleans into the local vars so everything
  // downstream (effectiveMcp/effectiveSession and the final `checks` array)
  // sees them consistently. Without this, a config-only `mcpGlobal: true`
  // would run MCP checks via runAudit's fallback while bypassing the
  // cli-side `ignore` filter.
  const mcpGlobal = (opts.mcpGlobal as boolean) || config?.mcpGlobal || false;
  const mcpOnly = (opts.mcpOnly as boolean) || config?.mcpOnly || false;
  const mcpFlag = (opts.mcp as boolean) || mcpGlobal || mcpOnly || config?.mcp || false;
  const sessionOnly = (opts.sessionOnly as boolean) || config?.sessionOnly || false;
  const sessionFlag = (opts.session as boolean) || sessionOnly || config?.session || false;
  const skillsOnly = (opts.skillsOnly as boolean) || config?.skillsOnly || false;
  const skillsFlag = (opts.skills as boolean) || skillsOnly || config?.skills || false;
  const hooksGlobal = (opts.hooksGlobal as boolean) || config?.hooksGlobal || false;

  // Build checks list: if explicit --checks includes mcp-* / session-*,
  // imply the corresponding --<flag>.
  let explicitChecks = opts.checks
    ? validateCheckNames(
        (opts.checks as string).split(',').map((c: string) => c.trim()),
        '--checks',
      )
    : null;
  if (explicitChecks?.length === 0) explicitChecks = null;

  const hasMcpInChecks = explicitChecks?.some((c) => c.startsWith('mcp-')) || false;
  const hasSessionInChecks = explicitChecks?.some((c) => c.startsWith('session-')) || false;
  const hasSkillInChecks = explicitChecks?.some((c) => c.startsWith('skill-')) || false;
  const effectiveMcp = mcpFlag || hasMcpInChecks;
  const effectiveSession = sessionFlag || hasSessionInChecks;
  const effectiveSkills = skillsFlag || hasSkillInChecks;

  let checks: CheckName[];
  if (explicitChecks) {
    checks = explicitChecks;
  } else if (sessionOnly) {
    checks = ALL_SESSION_CHECKS;
  } else if (skillsOnly) {
    checks = ALL_SKILL_CHECKS;
  } else if (mcpOnly) {
    checks = ALL_MCP_CHECKS;
  } else {
    const base = config?.checks || ALL_CHECKS;
    checks = [
      ...base,
      ...(effectiveMcp ? ALL_MCP_CHECKS : []),
      ...(effectiveSession ? ALL_SESSION_CHECKS : []),
      ...(effectiveSkills ? ALL_SKILL_CHECKS : []),
    ];
  }

  const options: LintOptions = {
    projectPath: resolvedPath,
    checks,
    strict: (opts.strict as boolean) || config?.strict || false,
    format: opts.format as 'text' | 'json' | 'sarif',
    verbose: opts.verbose as boolean,
    fix: opts.fix as boolean,
    ignore: opts.ignore
      ? validateCheckNames(
          (opts.ignore as string).split(',').map((c: string) => c.trim()),
          '--ignore',
        )
      : config?.ignore || [],
    tokensOnly: opts.tokens as boolean,
    quiet: opts.quiet as boolean,
    depth: resolveDepth(opts.depth as string),
    mcp: effectiveMcp,
    mcpOnly,
    mcpGlobal,
    session: effectiveSession,
    sessionOnly,
    skills: effectiveSkills,
    skillsOnly,
    hooksGlobal,
    // Commander's --no-X pattern: --no-ignore-file sets opts.ignoreFile = false.
    // When the flag is not passed, opts.ignoreFile is true (default). So
    // noIgnoreFile is true only when the user explicitly passed --no-ignore-file.
    noIgnoreFile: opts.ignoreFile === false,
  };

  // Token thresholds from config flow through runAudit's tokenThresholds
  // option (passed by both initial and watch-mode call sites). There is no
  // module-level state to apply here.

  const activeChecks = options.checks.filter((c) => !options.ignore.includes(c));

  return { config, options, activeChecks };
}

/**
 * Auto-discovered `.ctxlintrc[.json]` loader. Mirrors loadConfigFromPath's
 * error handling, which the explicit `--config` path has always had and this
 * one never did: a malformed discovered config threw past the action handler
 * and printed a raw Node stack trace with internal dist frames, even though
 * the underlying message ("Invalid JSON in <path>: ... line 1 column 3") was
 * already good. Same exit 2, same rethrow-on-watch contract, so the two config
 * sources now fail identically.
 */
function loadDiscoveredConfig(resolvedPath: string, throwOnError = false) {
  try {
    return loadConfig(resolvedPath);
  } catch (err) {
    if (throwOnError) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${detail}`);
    process.exit(2);
  }
}

function loadConfigFromPath(configPath: string, throwOnError = false) {
  try {
    return loadConfigFromExplicitPath(configPath);
  } catch (err) {
    // Watch reruns pass throwOnError so a bad mid-watch --config edit
    // propagates to the rerun try/catch (which keeps the previous
    // resolution) instead of calling the uncatchable process.exit(2).
    if (throwOnError) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${detail}`);
    process.exit(2);
  }
}
