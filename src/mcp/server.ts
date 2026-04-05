import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { scanForContextFiles } from '../core/scanner.js';
import { parseContextFile } from '../core/parser.js';
import { checkPaths } from '../core/checks/paths.js';
import { checkCommands } from '../core/checks/commands.js';
import { checkStaleness } from '../core/checks/staleness.js';
import { checkTokens, checkAggregateTokens } from '../core/checks/tokens.js';
import { checkRedundancy, checkDuplicateContent } from '../core/checks/redundancy.js';
import { fileExists, isDirectory } from '../utils/fs.js';
import { findRenames } from '../utils/git.js';
import { freeEncoder } from '../utils/tokens.js';
import { resetGit } from '../utils/git.js';
import type { LintResult, FileResult, LintIssue, CheckName } from '../core/types.js';
import * as path from 'node:path';

const VERSION = '0.1.0';
const ALL_CHECKS: CheckName[] = ['paths', 'commands', 'staleness', 'tokens', 'redundancy'];

const server = new McpServer({
  name: 'ctxlint',
  version: VERSION,
});

server.tool(
  'ctxlint_audit',
  'Audit all AI agent context files (CLAUDE.md, AGENTS.md, etc.) in the project for stale references, invalid commands, redundant content, and token waste.',
  {
    projectPath: z
      .string()
      .optional()
      .describe('Path to the project root. Defaults to current working directory.'),
    checks: z
      .array(z.enum(['paths', 'commands', 'staleness', 'tokens', 'redundancy']))
      .optional()
      .describe('Which checks to run. Defaults to all.'),
  },
  async ({ projectPath, checks }) => {
    const root = path.resolve(projectPath || process.cwd());
    const activeChecks = checks || ALL_CHECKS;

    try {
      const result = await runAudit(root, activeChecks);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }],
        isError: true,
      };
    } finally {
      freeEncoder();
      resetGit();
    }
  },
);

server.tool(
  'ctxlint_validate_path',
  'Check if a file path referenced in a context file actually exists in the project. Returns the file status and suggests corrections if the path is invalid.',
  {
    path: z.string().describe('The file path to validate'),
    projectPath: z.string().optional().describe('Project root. Defaults to cwd.'),
  },
  async ({ path: filePath, projectPath }) => {
    try {
      const root = path.resolve(projectPath || process.cwd());
      const resolved = path.resolve(root, filePath);

      const result: Record<string, unknown> = {
        path: filePath,
        exists: fileExists(resolved) || isDirectory(resolved),
      };

      if (!result.exists) {
        const rename = await findRenames(root, filePath);
        if (rename) {
          result.renamed = true;
          result.newPath = rename.newPath;
          result.renameCommit = rename.commitHash;
          result.daysAgo = rename.daysAgo;
        }
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }],
        isError: true,
      };
    } finally {
      resetGit();
    }
  },
);

server.tool(
  'ctxlint_token_report',
  'Get a token count breakdown for all context files in the project. Shows per-file and aggregate token usage, plus estimated waste from redundant content.',
  {
    projectPath: z.string().optional().describe('Project root. Defaults to cwd.'),
  },
  async ({ projectPath }) => {
    const root = path.resolve(projectPath || process.cwd());

    try {
      const discovered = await scanForContextFiles(root);
      const parsed = discovered.map((f) => parseContextFile(f));

      const files = parsed.map((f) => ({
        path: f.relativePath,
        tokens: f.totalTokens,
        lines: f.totalLines,
        isSymlink: f.isSymlink,
      }));

      const totalTokens = files.reduce((sum, f) => sum + f.tokens, 0);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ files, totalTokens }, null, 2),
          },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }],
        isError: true,
      };
    } finally {
      freeEncoder();
    }
  },
);

async function runAudit(projectRoot: string, activeChecks: CheckName[]): Promise<LintResult> {
  const discovered = await scanForContextFiles(projectRoot);
  const parsed = discovered.map((f) => parseContextFile(f));
  const fileResults: FileResult[] = [];

  for (const file of parsed) {
    const issues: LintIssue[] = [];

    if (activeChecks.includes('paths')) issues.push(...(await checkPaths(file, projectRoot)));
    if (activeChecks.includes('commands')) issues.push(...(await checkCommands(file, projectRoot)));
    if (activeChecks.includes('staleness'))
      issues.push(...(await checkStaleness(file, projectRoot)));
    if (activeChecks.includes('tokens')) issues.push(...(await checkTokens(file, projectRoot)));
    if (activeChecks.includes('redundancy'))
      issues.push(...(await checkRedundancy(file, projectRoot)));

    fileResults.push({
      path: file.relativePath,
      isSymlink: file.isSymlink,
      symlinkTarget: file.symlinkTarget,
      tokens: file.totalTokens,
      lines: file.totalLines,
      issues,
    });
  }

  if (activeChecks.includes('tokens')) {
    const aggIssue = checkAggregateTokens(
      fileResults.map((f) => ({ path: f.path, tokens: f.tokens })),
    );
    if (aggIssue && fileResults.length > 0) fileResults[0].issues.push(aggIssue);
  }
  if (activeChecks.includes('redundancy')) {
    const dupIssues = checkDuplicateContent(parsed);
    if (dupIssues.length > 0 && fileResults.length > 0) fileResults[0].issues.push(...dupIssues);
  }

  let estimatedWaste = 0;
  for (const fr of fileResults) {
    for (const issue of fr.issues) {
      if (issue.check === 'redundancy' && issue.suggestion) {
        const tokenMatch = issue.suggestion.match(/~(\d+)\s+tokens/);
        if (tokenMatch) estimatedWaste += parseInt(tokenMatch[1], 10);
      }
    }
  }

  return {
    version: VERSION,
    scannedAt: new Date().toISOString(),
    projectRoot,
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
}

const transport = new StdioServerTransport();
await server.connect(transport);
