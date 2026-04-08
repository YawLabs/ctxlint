import * as fs from 'node:fs';
import { Command } from 'commander';
import ora from 'ora';
import { resetPathsCache } from './core/checks/paths.js';
import { setTokenThresholds, resetTokenThresholds } from './core/checks/tokens.js';
import { formatText, formatJson, formatTokenReport, formatSarif } from './core/reporter.js';
import { applyFixes } from './core/fixer.js';
import { freeEncoder } from './utils/tokens.js';
import { resetGit } from './utils/git.js';
import { loadConfig } from './core/config.js';
import { runAudit, ALL_CHECKS, ALL_MCP_CHECKS } from './core/audit.js';
import type { LintOptions, CheckName } from './core/types.js';
import * as path from 'node:path';
import { VERSION } from './version.js';

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
    .option('--format <format>', 'Output format: text, json, or sarif', 'text')
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
    .action(async (projectPath: string, opts: Record<string, unknown>) => {
      const resolvedPath = path.resolve(projectPath as string);

      // Load project config (.ctxlintrc / .ctxlintrc.json)
      const configPath = opts.config ? path.resolve(opts.config as string) : undefined;
      const config = configPath ? loadConfigFromPath(configPath) : loadConfig(resolvedPath);

      const mcpGlobal = (opts.mcpGlobal as boolean) || false;
      const mcpOnly = (opts.mcpOnly as boolean) || false;
      const mcpFlag = (opts.mcp as boolean) || mcpGlobal || mcpOnly || config?.mcp || false;

      // Build checks list: if explicit --checks includes mcp-*, imply --mcp
      const explicitChecks = opts.checks
        ? (opts.checks as string).split(',').map((c: string) => c.trim() as CheckName)
        : null;

      const hasMcpInChecks = explicitChecks?.some((c) => c.startsWith('mcp-')) || false;
      const effectiveMcp = mcpFlag || hasMcpInChecks;

      let checks: CheckName[];
      if (explicitChecks) {
        checks = explicitChecks;
      } else if (mcpOnly) {
        checks = ALL_MCP_CHECKS;
      } else if (effectiveMcp) {
        checks = [...(config?.checks || ALL_CHECKS), ...ALL_MCP_CHECKS];
      } else {
        checks = config?.checks || ALL_CHECKS;
      }

      const options: LintOptions = {
        projectPath: resolvedPath,
        checks,
        strict: (opts.strict as boolean) || config?.strict || false,
        format: opts.format as 'text' | 'json' | 'sarif',
        verbose: opts.verbose as boolean,
        fix: opts.fix as boolean,
        ignore: opts.ignore
          ? (opts.ignore as string).split(',').map((c: string) => c.trim() as CheckName)
          : config?.ignore || [],
        tokensOnly: opts.tokens as boolean,
        quiet: opts.quiet as boolean,
        depth: parseInt(opts.depth as string, 10) || 2,
        mcp: effectiveMcp,
        mcpOnly,
        mcpGlobal: mcpGlobal || config?.mcpGlobal || false,
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
          process.exit(0);
        }

        // Apply fixes if requested
        if (options.fix) {
          const fixSummary = applyFixes(result);
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

        // Exit code
        if (options.strict && (result.summary.errors > 0 || result.summary.warnings > 0)) {
          process.exit(1);
        }
      } catch (err) {
        spinner?.stop();
        console.error('Error:', err instanceof Error ? err.message : err);
        process.exit(2);
      } finally {
        freeEncoder();
        resetGit();
        resetPathsCache();
        resetTokenThresholds();
      }
    });

  program
    .command('init')
    .description('Set up a git pre-commit hook that runs ctxlint --strict')
    .action(async () => {
      const hooksDir = path.resolve('.git', 'hooks');

      if (!fs.existsSync(path.resolve('.git'))) {
        console.error('Error: not a git repository. Run "git init" first.');
        process.exit(1);
      }

      if (!fs.existsSync(hooksDir)) {
        fs.mkdirSync(hooksDir, { recursive: true });
      }

      const hookPath = path.join(hooksDir, 'pre-commit');
      const hookContent = `#!/bin/sh
# ctxlint pre-commit hook
npx @yawlabs/ctxlint --strict
`;

      if (fs.existsSync(hookPath)) {
        const existing = fs.readFileSync(hookPath, 'utf-8');
        if (existing.includes('ctxlint')) {
          console.log('Pre-commit hook already includes ctxlint.');
          return;
        }
        // Append to existing hook
        fs.appendFileSync(hookPath, '\n' + hookContent);
        console.log('Added ctxlint to existing pre-commit hook.');
      } else {
        fs.writeFileSync(hookPath, hookContent, { mode: 0o755 });
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
  } catch {
    console.error(`Error: could not load config from ${configPath}`);
    process.exit(2);
  }
}
