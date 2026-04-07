import { scanForContextFiles } from './scanner.js';
import { parseContextFile } from './parser.js';
import { checkPaths } from './checks/paths.js';
import { checkCommands } from './checks/commands.js';
import { checkStaleness } from './checks/staleness.js';
import { checkTokens, checkAggregateTokens } from './checks/tokens.js';
import { checkRedundancy, checkDuplicateContent } from './checks/redundancy.js';
import { checkContradictions } from './checks/contradictions.js';
import { checkFrontmatter } from './checks/frontmatter.js';
import type { LintResult, FileResult, LintIssue, CheckName } from './types.js';
import { VERSION } from '../version.js';

export const ALL_CHECKS: CheckName[] = [
  'paths',
  'commands',
  'staleness',
  'tokens',
  'redundancy',
  'contradictions',
  'frontmatter',
];

export interface AuditOptions {
  depth?: number;
  extraPatterns?: string[];
}

export async function runAudit(
  projectRoot: string,
  activeChecks: CheckName[],
  options: AuditOptions = {},
): Promise<LintResult> {
  const discovered = await scanForContextFiles(projectRoot, {
    depth: options.depth,
    extraPatterns: options.extraPatterns,
  });
  const parsed = discovered.map((f) => parseContextFile(f));
  const fileResults: FileResult[] = [];

  for (const file of parsed) {
    // Run independent per-file checks in parallel
    const checkPromises: Promise<LintIssue[]>[] = [];

    if (activeChecks.includes('paths')) checkPromises.push(checkPaths(file, projectRoot));
    if (activeChecks.includes('commands')) checkPromises.push(checkCommands(file, projectRoot));
    if (activeChecks.includes('staleness')) checkPromises.push(checkStaleness(file, projectRoot));
    if (activeChecks.includes('tokens')) checkPromises.push(checkTokens(file, projectRoot));
    if (activeChecks.includes('redundancy')) checkPromises.push(checkRedundancy(file, projectRoot));
    if (activeChecks.includes('frontmatter'))
      checkPromises.push(checkFrontmatter(file, projectRoot));

    const results = await Promise.all(checkPromises);
    const issues = results.flat();

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
    if (aggIssue && fileResults.length > 0) fileResults[0].issues.push(aggIssue);
  }
  if (activeChecks.includes('redundancy')) {
    const dupIssues = checkDuplicateContent(parsed);
    if (dupIssues.length > 0 && fileResults.length > 0) fileResults[0].issues.push(...dupIssues);
  }
  if (activeChecks.includes('contradictions')) {
    const contradictionIssues = checkContradictions(parsed);
    if (contradictionIssues.length > 0 && fileResults.length > 0)
      fileResults[0].issues.push(...contradictionIssues);
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
