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
    .option('--ignore <checks>', 'Comma-separated list of checks to ignore', '')
    .option('--quiet', 'Suppress all output except errors (exit code only)', false)
    .option('--config <path>', 'Path to config file (default: .ctxlintrc in project root)')
    .option('--depth <n>', 'Max subdirectory depth to scan (default: 2)', '2')
    .option('--mcp', 'Enable MCP config linting alongside context file checks', false)
    .option('--mcp-only', 'Run only MCP config checks, skip context file checks', false)
    .option('--mcp-global', 'Also scan user/global MCP config files (implies --mcp)', false)
    .option('--mcp-server', 'Start the MCP server (for IDE/agent integration)')
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

        // Apply fixes if requested
        if (options.fix) {
          const fixSummary = applyFixes(result, { quiet: options.quiet });
          if (fixSummary.totalFixes > 0 && !options.quiet) {
            console.log(
              `\nFixed ${fixSummary.totalFixes} issue${fixSummary.totalFixes !== 1 ? 's' : ''} in ${fixSummary.filesModified.length} file${fixSummary.filesModified.length !== 1 ? 's' : ''}.\n`,
            );
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
            fs.watch(filePath, rerun);
          } catch {
            // File doesn't exist yet — skip
          }
        }

        // Watch directories (recursive)
        for (const dir of watchDirs) {
          try {
            fs.watch(dir, { recursive: true }, rerun);
          } catch {
            // Directory doesn't exist — skip
          }
        }

        // Keep process alive indefinitely (watch mode exits via Ctrl+C)
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
      const fullHookContent = `#!/bin/sh
# ctxlint pre-commit hook
npx @yawlabs/ctxlint --strict
`;
      const appendHookContent = `
# ctxlint pre-commit hook
npx @yawlabs/ctxlint --strict
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
