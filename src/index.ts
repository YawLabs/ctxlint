import { Command } from 'commander';
import ora from 'ora';
import { scanForContextFiles } from './core/scanner.js';
import { parseContextFile } from './core/parser.js';
import { checkPaths, resetPathsCache } from './core/checks/paths.js';
import { checkCommands } from './core/checks/commands.js';
import { checkStaleness } from './core/checks/staleness.js';
import { checkTokens, checkAggregateTokens } from './core/checks/tokens.js';
import { checkRedundancy, checkDuplicateContent } from './core/checks/redundancy.js';
import { formatText, formatJson, formatTokenReport } from './core/reporter.js';
import { freeEncoder } from './utils/tokens.js';
import { resetGit } from './utils/git.js';
import type { LintResult, LintOptions, FileResult, CheckName, LintIssue } from './core/types.js';
import * as path from 'node:path';

const VERSION = '0.1.0';

const ALL_CHECKS: CheckName[] = ['paths', 'commands', 'staleness', 'tokens', 'redundancy'];

const program = new Command();

program
  .name('ctxlint')
  .description(
    'Lint your AI agent context files (CLAUDE.md, AGENTS.md, etc.) against your actual codebase',
  )
  .version(VERSION)
  .argument('[path]', 'Project directory to scan', '.')
  .option('--strict', 'Exit code 1 on any warning or error (for CI)', false)
  .option('--checks <checks>', 'Comma-separated list of checks to run', '')
  .option('--format <format>', 'Output format: text or json', 'text')
  .option('--tokens', 'Show token breakdown per file', false)
  .option('--verbose', 'Show passing checks too', false)
  .option('--ignore <checks>', 'Comma-separated list of checks to ignore', '')
  .action(async (projectPath: string, opts: Record<string, unknown>) => {
    const resolvedPath = path.resolve(projectPath as string);

    const options: LintOptions = {
      projectPath: resolvedPath,
      checks: opts.checks
        ? (opts.checks as string).split(',').map((c: string) => c.trim() as CheckName)
        : ALL_CHECKS,
      strict: opts.strict as boolean,
      format: opts.format as 'text' | 'json',
      verbose: opts.verbose as boolean,
      fix: false,
      ignore: opts.ignore
        ? (opts.ignore as string).split(',').map((c: string) => c.trim() as CheckName)
        : [],
      tokensOnly: opts.tokens as boolean,
    };

    // Remove ignored checks
    const activeChecks = options.checks.filter((c) => !options.ignore.includes(c));

    const spinner =
      options.format === 'text' ? ora('Scanning for context files...').start() : undefined;

    try {
      // Discover context files
      const discovered = await scanForContextFiles(options.projectPath);

      if (discovered.length === 0) {
        spinner?.stop();
        if (options.format === 'json') {
          console.log(
            JSON.stringify({
              version: VERSION,
              scannedAt: new Date().toISOString(),
              projectRoot: options.projectPath,
              files: [],
              summary: { errors: 0, warnings: 0, info: 0, totalTokens: 0, estimatedWaste: 0 },
            }),
          );
        } else {
          console.log('\nNo context files found.\n');
        }
        process.exit(0);
      }

      if (spinner)
        spinner.text = `Parsing ${discovered.length} context file${discovered.length !== 1 ? 's' : ''}...`;

      // Parse all context files
      const parsed = discovered.map((f) => parseContextFile(f));

      if (spinner) spinner.text = 'Running checks...';

      // Run checks on each file
      const fileResults: FileResult[] = [];

      for (const file of parsed) {
        const issues: LintIssue[] = [];

        if (activeChecks.includes('paths')) {
          issues.push(...(await checkPaths(file, options.projectPath)));
        }
        if (activeChecks.includes('commands')) {
          issues.push(...(await checkCommands(file, options.projectPath)));
        }
        if (activeChecks.includes('staleness')) {
          issues.push(...(await checkStaleness(file, options.projectPath)));
        }
        if (activeChecks.includes('tokens')) {
          issues.push(...(await checkTokens(file, options.projectPath)));
        }
        if (activeChecks.includes('redundancy')) {
          issues.push(...(await checkRedundancy(file, options.projectPath)));
        }

        fileResults.push({
          path: file.relativePath,
          isSymlink: file.isSymlink,
          symlinkTarget: file.symlinkTarget,
          tokens: file.totalTokens,
          lines: file.totalLines,
          issues,
        });
      }

      // Cross-file checks
      if (activeChecks.includes('tokens')) {
        const aggIssue = checkAggregateTokens(
          fileResults.map((f) => ({ path: f.path, tokens: f.tokens })),
        );
        if (aggIssue && fileResults.length > 0) {
          fileResults[0].issues.push(aggIssue);
        }
      }
      if (activeChecks.includes('redundancy')) {
        const dupIssues = checkDuplicateContent(parsed);
        if (dupIssues.length > 0 && fileResults.length > 0) {
          fileResults[0].issues.push(...dupIssues);
        }
      }

      // Calculate estimated waste from redundancy issues
      let estimatedWaste = 0;
      for (const fr of fileResults) {
        for (const issue of fr.issues) {
          if (issue.check === 'redundancy' && issue.suggestion) {
            const tokenMatch = issue.suggestion.match(/~(\d+)\s+tokens/);
            if (tokenMatch) {
              estimatedWaste += parseInt(tokenMatch[1], 10);
            }
          }
        }
      }

      // Build result
      const result: LintResult = {
        version: VERSION,
        scannedAt: new Date().toISOString(),
        projectRoot: options.projectPath,
        files: fileResults,
        summary: {
          errors: fileResults.reduce(
            (sum, f) => sum + f.issues.filter((i) => i.severity === 'error').length,
            0,
          ),
          warnings: fileResults.reduce(
            (sum, f) => sum + f.issues.filter((i) => i.severity === 'warning').length,
            0,
          ),
          info: fileResults.reduce(
            (sum, f) => sum + f.issues.filter((i) => i.severity === 'info').length,
            0,
          ),
          totalTokens: fileResults.reduce((sum, f) => sum + f.tokens, 0),
          estimatedWaste,
        },
      };

      spinner?.stop();

      // Output
      if (options.tokensOnly) {
        console.log(formatTokenReport(result));
      } else if (options.format === 'json') {
        console.log(formatJson(result));
      } else {
        console.log(formatText(result, options.verbose));
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
    }
  });

program.parse();
