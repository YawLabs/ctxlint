import * as fs from 'node:fs';
import { Command, Option } from 'commander';
import ora from 'ora';
import { resetPathsCache } from './core/checks/paths.js';
import { setTokenThresholds, resetTokenThresholds } from './core/checks/tokens.js';
import { formatText, formatJson, formatTokenReport, formatSarif } from './core/reporter.js';
import { applyFixes } from './core/fixer.js';
import { freeEncoder } from './utils/tokens.js';
import { resetGit } from './utils/git.js';
import { resetPackageJsonCache } from './utils/fs.js';
import { loadConfig } from './core/config.js';
import { runAudit, ALL_CHECKS, ALL_MCP_CHECKS, ALL_SESSION_CHECKS } from './core/audit.js';
import type { LintOptions, CheckName } from './core/types.js';
import * as path from 'node:path';
import { VERSION } from './version.js';

const VALID_CHECKS = new Set<string>([...ALL_CHECKS, ...ALL_MCP_CHECKS, ...ALL_SESSION_CHECKS]);

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
    .option('--depth <n>', 'Max subdirectory depth to scan (default: 2)', '2')
    .option('--mcp', 'Enable MCP config linting alongside context file checks', false)
    .option('--mcp-only', 'Run only MCP config checks, skip context file checks', false)
    .option('--mcp-global', 'Also scan user/global MCP config files (implies --mcp)', false)
    .option('--mcp-server', 'Start the MCP server (alias: `ctxlint serve`)')
    .option('--session', 'Run session audit checks (cross-project consistency)', false)
    .option('--session-only', 'Run only session checks, skip context and MCP checks', false)
    .option('--watch', 'Re-lint on context file changes', false)
    .action(async (projectPath: string, opts: Record<string, unknown>) => {
      const resolvedPath = path.resolve(projectPath as string);

      // Load project config (.ctxlintrc / .ctxlintrc.json)
      const configPath = opts.config ? path.resolve(opts.config as string) : undefined;
      const config = configPath ? loadConfigFromPath(configPath) : loadConfig(resolvedPath);

      const mcpGlobal = (opts.mcpGlobal as boolean) || false;
      const mcpOnly = (opts.mcpOnly as boolean) || false;
      const mcpFlag = (opts.mcp as boolean) || mcpGlobal || mcpOnly || config?.mcp || false;
      const sessionFlag = (opts.session as boolean) || false;
      const sessionOnly = (opts.sessionOnly as boolean) || false;

      // Build checks list: if explicit --checks includes mcp-* or session-*, imply the flag
      let explicitChecks = opts.checks
        ? validateCheckNames(
            (opts.checks as string).split(',').map((c: string) => c.trim()),
            '--checks',
          )
        : null;
      // Treat empty list the same as "not specified" — use defaults
      if (explicitChecks?.length === 0) explicitChecks = null;

      const hasMcpInChecks = explicitChecks?.some((c) => c.startsWith('mcp-')) || false;
      const hasSessionInChecks = explicitChecks?.some((c) => c.startsWith('session-')) || false;
      const effectiveMcp = mcpFlag || hasMcpInChecks;
      const effectiveSession = sessionFlag || sessionOnly || hasSessionInChecks;

      let checks: CheckName[];
      if (explicitChecks) {
        checks = explicitChecks;
      } else if (sessionOnly) {
        checks = ALL_SESSION_CHECKS;
      } else if (mcpOnly) {
        checks = ALL_MCP_CHECKS;
      } else {
        const base = config?.checks || ALL_CHECKS;
        checks = [
          ...base,
          ...(effectiveMcp ? ALL_MCP_CHECKS : []),
          ...(effectiveSession ? ALL_SESSION_CHECKS : []),
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
        depth: Math.max(0, Math.min(parseInt(opts.depth as string, 10) || 2, 10)),
        mcp: effectiveMcp,
        mcpOnly,
        mcpGlobal: mcpGlobal || config?.mcpGlobal || false,
        session: effectiveSession,
        sessionOnly,
      };

      // Apply token thresholds from config
      if (config?.tokenThresholds) {
        setTokenThresholds(config.tokenThresholds);
      }

      // Remove ignored checks
      const activeChecks = options.checks.filter((c) => !options.ignore.includes(c));

      const spinner =
        options.format === 'text' && !options.quiet
          ? ora('Scanning for context files...').start()
          : undefined;

      try {
        if (spinner) spinner.text = 'Running checks...';

        const result = await runAudit(resolvedPath, activeChecks, {
          depth: options.depth,
          extraPatterns: config?.contextFiles,
          mcp: options.mcp,
          mcpGlobal: options.mcpGlobal,
          mcpOnly: options.mcpOnly,
          session: options.session,
          sessionOnly: options.sessionOnly,
        });

        spinner?.stop();

        if (result.files.length === 0) {
          if (!options.quiet) {
            if (options.format === 'json') {
              console.log(JSON.stringify(result));
            } else if (options.format === 'sarif') {
              console.log(formatSarif(result));
            } else {
              console.log('\nNo context files found.\n');
            }
          }
          if (!opts.watch) return;
        }

        // Apply fixes if requested. --fix-dry-run previews only. --fix writes,
        // but in an interactive TTY we first preview, then prompt unless --yes
        // is passed. CI (non-TTY) behavior is unchanged: --fix writes directly.
        const dryRunFlag = (opts.fixDryRun as boolean) || false;
        const yes = (opts.yes as boolean) || false;
        const followSymlinks = (opts.followSymlinks as boolean) || false;
        const isInteractive = !!process.stdout.isTTY && !options.quiet;

        if (dryRunFlag || options.fix) {
          const commonOpts = { quiet: options.quiet, skipSymlinks: !followSymlinks };

          if (dryRunFlag) {
            const preview = applyFixes(result, { ...commonOpts, dryRun: true });
            if (!options.quiet) {
              if (preview.totalFixes === 0) {
                console.log('\nNo auto-fixable issues.\n');
              } else {
                console.log(
                  `\nWould fix ${preview.totalFixes} issue${preview.totalFixes !== 1 ? 's' : ''} in ${preview.filesModified.length} file${preview.filesModified.length !== 1 ? 's' : ''}. (dry-run — no files modified)\n`,
                );
              }
            }
          } else if (options.fix) {
            if (isInteractive && !yes) {
              // Show a preview, then ask for confirmation before writing.
              const preview = applyFixes(result, { ...commonOpts, dryRun: true });
              if (preview.totalFixes === 0) {
                console.log('\nNo auto-fixable issues.\n');
              } else {
                console.log(
                  `\n${preview.totalFixes} fix${preview.totalFixes !== 1 ? 'es' : ''} proposed across ${preview.filesModified.length} file${preview.filesModified.length !== 1 ? 's' : ''}.`,
                );
                const confirmed = await promptYesNo(
                  'Apply these fixes? Re-run with --yes to skip this prompt. [y/N] ',
                );
                if (!confirmed) {
                  console.log('Aborted. No files modified.\n');
                } else {
                  const applied = applyFixes(result, commonOpts);
                  console.log(
                    `\nFixed ${applied.totalFixes} issue${applied.totalFixes !== 1 ? 's' : ''} in ${applied.filesModified.length} file${applied.filesModified.length !== 1 ? 's' : ''}.\n`,
                  );
                }
              }
            } else {
              // Non-interactive (CI) or --yes: apply directly.
              const applied = applyFixes(result, commonOpts);
              if (applied.totalFixes > 0 && !options.quiet) {
                console.log(
                  `\nFixed ${applied.totalFixes} issue${applied.totalFixes !== 1 ? 's' : ''} in ${applied.filesModified.length} file${applied.filesModified.length !== 1 ? 's' : ''}.\n`,
                );
              }
            }
          }
        }

        // Output
        if (!options.quiet) {
          if (options.tokensOnly) {
            console.log(formatTokenReport(result));
          } else if (options.format === 'json') {
            console.log(formatJson(result));
          } else if (options.format === 'sarif') {
            console.log(formatSarif(result));
          } else {
            console.log(formatText(result, options.verbose));
          }
        }

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
        resetTokenThresholds();
      }

      // Watch mode: re-lint when context files, MCP configs, or package.json change
      if (opts.watch) {
        const chalk = (await import('chalk')).default;
        console.log(chalk.dim('\nWatching for changes... (Ctrl+C to stop)\n'));

        const watchPaths = [
          path.join(resolvedPath, 'CLAUDE.md'),
          path.join(resolvedPath, 'CLAUDE.local.md'),
          path.join(resolvedPath, 'AGENTS.md'),
          path.join(resolvedPath, 'AGENT.md'),
          path.join(resolvedPath, '.cursorrules'),
          path.join(resolvedPath, '.windsurfrules'),
          path.join(resolvedPath, '.clinerules'),
          path.join(resolvedPath, '.aiderules'),
          path.join(resolvedPath, '.continuerules'),
          path.join(resolvedPath, '.rules'),
          path.join(resolvedPath, '.goosehints'),
          path.join(resolvedPath, 'GEMINI.md'),
          path.join(resolvedPath, 'replit.md'),
          path.join(resolvedPath, 'package.json'),
          path.join(resolvedPath, '.mcp.json'),
        ];

        const watchDirs = [
          path.join(resolvedPath, '.claude'),
          path.join(resolvedPath, '.cursor'),
          path.join(resolvedPath, '.github'),
          path.join(resolvedPath, '.windsurf'),
          path.join(resolvedPath, '.aide'),
          path.join(resolvedPath, '.amazonq'),
          path.join(resolvedPath, '.goose'),
          path.join(resolvedPath, '.junie'),
          path.join(resolvedPath, '.aiassistant'),
          path.join(resolvedPath, '.continue'),
          path.join(resolvedPath, '.vscode'),
        ];

        const watchers: fs.FSWatcher[] = [];
        let debounceTimer: ReturnType<typeof setTimeout> | null = null;

        const rerun = () => {
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(async () => {
            if (process.stdout.isTTY) console.clear();
            try {
              const result = await runAudit(resolvedPath, activeChecks, {
                depth: options.depth,
                extraPatterns: config?.contextFiles,
                mcp: options.mcp,
                mcpGlobal: options.mcpGlobal,
                mcpOnly: options.mcpOnly,
                session: options.session,
                sessionOnly: options.sessionOnly,
              });

              if (result.files.length === 0) {
                console.log('\nNo context files found.\n');
              } else if (options.tokensOnly) {
                console.log(formatTokenReport(result));
              } else if (options.format === 'json') {
                console.log(formatJson(result));
              } else if (options.format === 'sarif') {
                console.log(formatSarif(result));
              } else {
                console.log(formatText(result, options.verbose));
              }
            } catch (err) {
              console.error('Error:', err instanceof Error ? err.message : err);
            } finally {
              freeEncoder();
              resetGit();
              resetPathsCache();
              resetPackageJsonCache();
              resetTokenThresholds();
              if (config?.tokenThresholds) setTokenThresholds(config.tokenThresholds);
            }
            console.log(chalk.dim('\nWatching for changes... (Ctrl+C to stop)\n'));
          }, 300);
        };

        // Watch individual files
        for (const filePath of watchPaths) {
          try {
            watchers.push(fs.watch(filePath, rerun));
          } catch {
            // File doesn't exist yet — skip
          }
        }

        // Watch directories (recursive)
        for (const dir of watchDirs) {
          try {
            watchers.push(fs.watch(dir, { recursive: true }, rerun));
          } catch {
            // Directory doesn't exist — skip
          }
        }

        // Close watchers on SIGINT / SIGTERM so the process exits cleanly
        // without leaking file-watch handles. `once` avoids double-close if
        // the user hammers Ctrl+C; the handlers remove themselves afterward.
        const shutdown = () => {
          if (debounceTimer) clearTimeout(debounceTimer);
          for (const w of watchers) {
            try {
              w.close();
            } catch {
              // Already closed or never opened — ignore.
            }
          }
          process.exit(0);
        };
        process.once('SIGINT', shutdown);
        process.once('SIGTERM', shutdown);

        // Keep process alive indefinitely (watch mode exits via the
        // SIGINT/SIGTERM handlers above).
        await new Promise(() => {});
      }
    });

  program
    .command('init')
    .description('Set up a git pre-commit hook that runs ctxlint --strict')
    .argument('[path]', 'Project directory', '.')
    .action(async (projectPath: string) => {
      const resolvedRoot = path.resolve(projectPath);
      const gitDir = path.join(resolvedRoot, '.git');
      const hooksDir = path.join(gitDir, 'hooks');

      if (!fs.existsSync(gitDir)) {
        console.error('Error: not a git repository. Run "git init" first.');
        process.exit(1);
      }

      if (!fs.existsSync(hooksDir)) {
        fs.mkdirSync(hooksDir, { recursive: true });
      }

      const hookPath = path.join(hooksDir, 'pre-commit');
      // Pin the hook to the version of ctxlint that wrote it, so a repo
      // checked out months later doesn't silently pull a newer ctxlint whose
      // rule set drifted. Users can re-run `ctxlint init` to bump the pin.
      const fullHookContent = `#!/bin/sh
# ctxlint pre-commit hook
npx @yawlabs/ctxlint@${VERSION} --strict
`;
      const appendHookContent = `
# ctxlint pre-commit hook
npx @yawlabs/ctxlint@${VERSION} --strict
`;

      if (fs.existsSync(hookPath)) {
        const existing = fs.readFileSync(hookPath, 'utf-8');
        if (existing.includes('ctxlint')) {
          console.log('Pre-commit hook already includes ctxlint.');
          return;
        }
        // Append to existing hook (without shebang — the existing hook already has one)
        fs.appendFileSync(hookPath, appendHookContent);
        console.log('Added ctxlint to existing pre-commit hook.');
      } else {
        fs.writeFileSync(hookPath, fullHookContent, { mode: 0o755 });
        console.log('Created pre-commit hook at .git/hooks/pre-commit');
      }

      console.log('ctxlint will now run automatically before each commit.');
    });

  program.parse();
}

/**
 * Prompt the user for a yes/no answer on a TTY. Defaults to no if the response
 * is anything other than an affirmative ('y' / 'yes', case-insensitive). Only
 * called when process.stdout.isTTY is true.
 */
async function promptYesNo(question: string): Promise<boolean> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return /^\s*y(es)?\s*$/i.test(answer);
  } finally {
    rl.close();
  }
}

function loadConfigFromPath(configPath: string) {
  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`Error: could not load config from ${configPath}: ${detail}`);
    process.exit(2);
  }
}
