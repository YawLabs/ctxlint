import { scanForContextFiles, scanForMcpConfigs, scanGlobalMcpConfigs } from './scanner.js';
import { parseContextFile } from './parser.js';
import { parseMcpConfig } from './mcp-parser.js';
import { checkPaths } from './checks/paths.js';
import { checkCommands } from './checks/commands.js';
import { checkStaleness } from './checks/staleness.js';
import { checkTokens, checkAggregateTokens } from './checks/tokens.js';
import { checkRedundancy, checkDuplicateContent } from './checks/redundancy.js';
import { checkContradictions } from './checks/contradictions.js';
import { checkFrontmatter } from './checks/frontmatter.js';
import { checkMcpSchema } from './checks/mcp/schema.js';
import { checkMcpSecurity } from './checks/mcp/security.js';
import { checkMcpCommands } from './checks/mcp/commands.js';
import { checkMcpDeprecated } from './checks/mcp/deprecated.js';
import { checkMcpEnv } from './checks/mcp/env.js';
import { checkMcpUrls } from './checks/mcp/urls.js';
import { checkMcpConsistency } from './checks/mcp/consistency.js';
import { checkMcpRedundancy } from './checks/mcp/redundancy.js';
import type {
  LintResult,
  FileResult,
  LintIssue,
  CheckName,
  McpCheckName,
  ParsedMcpConfig,
} from './types.js';
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

export const ALL_MCP_CHECKS: McpCheckName[] = [
  'mcp-schema',
  'mcp-security',
  'mcp-commands',
  'mcp-deprecated',
  'mcp-env',
  'mcp-urls',
  'mcp-consistency',
  'mcp-redundancy',
];

export interface AuditOptions {
  depth?: number;
  extraPatterns?: string[];
  mcp?: boolean;
  mcpGlobal?: boolean;
  mcpOnly?: boolean;
}

function hasMcpChecks(checks: CheckName[]): boolean {
  return checks.some((c) => c.startsWith('mcp-'));
}

export async function runAudit(
  projectRoot: string,
  activeChecks: CheckName[],
  options: AuditOptions = {},
): Promise<LintResult> {
  const fileResults: FileResult[] = [];

  const shouldRunContextChecks = !options.mcpOnly;
  const shouldRunMcpChecks =
    options.mcp || options.mcpGlobal || options.mcpOnly || hasMcpChecks(activeChecks);

  // --- Context file checks ---
  if (shouldRunContextChecks) {
    const discovered = await scanForContextFiles(projectRoot, {
      depth: options.depth,
      extraPatterns: options.extraPatterns,
    });
    const parsed = discovered.map((f) => parseContextFile(f));

    for (const file of parsed) {
      const checkPromises: Promise<LintIssue[]>[] = [];

      if (activeChecks.includes('paths')) checkPromises.push(checkPaths(file, projectRoot));
      if (activeChecks.includes('commands')) checkPromises.push(checkCommands(file, projectRoot));
      if (activeChecks.includes('staleness')) checkPromises.push(checkStaleness(file, projectRoot));
      if (activeChecks.includes('tokens')) checkPromises.push(checkTokens(file, projectRoot));
      if (activeChecks.includes('redundancy'))
        checkPromises.push(checkRedundancy(file, projectRoot));
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

    // Cross-file context checks
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
  }

  // --- MCP config checks ---
  if (shouldRunMcpChecks) {
    const mcpFiles = await scanForMcpConfigs(projectRoot);
    const mcpConfigs: ParsedMcpConfig[] = mcpFiles.map((f) =>
      parseMcpConfig(f, projectRoot, 'project'),
    );

    if (options.mcpGlobal) {
      const globalFiles = await scanGlobalMcpConfigs();
      mcpConfigs.push(...globalFiles.map((f) => parseMcpConfig(f, projectRoot, 'user')));
    }

    // Determine active MCP checks
    const activeMcpChecks = activeChecks.filter((c) => c.startsWith('mcp-')) as McpCheckName[];
    const mcpChecksToRun =
      activeMcpChecks.length > 0
        ? activeMcpChecks
        : options.mcp || options.mcpGlobal || options.mcpOnly
          ? ALL_MCP_CHECKS
          : [];

    for (const config of mcpConfigs) {
      const checkPromises: Promise<LintIssue[]>[] = [];

      if (mcpChecksToRun.includes('mcp-schema'))
        checkPromises.push(checkMcpSchema(config, projectRoot));
      if (mcpChecksToRun.includes('mcp-security'))
        checkPromises.push(checkMcpSecurity(config, projectRoot));
      if (mcpChecksToRun.includes('mcp-commands'))
        checkPromises.push(checkMcpCommands(config, projectRoot));
      if (mcpChecksToRun.includes('mcp-deprecated'))
        checkPromises.push(checkMcpDeprecated(config, projectRoot));
      if (mcpChecksToRun.includes('mcp-env')) checkPromises.push(checkMcpEnv(config, projectRoot));
      if (mcpChecksToRun.includes('mcp-urls'))
        checkPromises.push(checkMcpUrls(config, projectRoot));

      const results = await Promise.all(checkPromises);
      const issues = results.flat();

      const lines = config.content.split('\n').length;
      fileResults.push({
        path: config.relativePath,
        isSymlink: false,
        tokens: 0,
        lines,
        issues,
      });
    }

    // Cross-file MCP checks
    if (mcpChecksToRun.includes('mcp-consistency')) {
      const consistencyIssues = await checkMcpConsistency(mcpConfigs);
      if (consistencyIssues.length > 0) {
        // Attach to the first MCP config file result, or create one
        const firstMcpResult = fileResults.find((f) =>
          mcpConfigs.some((c) => c.relativePath === f.path),
        );
        if (firstMcpResult) {
          firstMcpResult.issues.push(...consistencyIssues);
        }
      }
    }
    if (mcpChecksToRun.includes('mcp-redundancy')) {
      const redundancyIssues = await checkMcpRedundancy(mcpConfigs);
      if (redundancyIssues.length > 0) {
        const firstMcpResult = fileResults.find((f) =>
          mcpConfigs.some((c) => c.relativePath === f.path),
        );
        if (firstMcpResult) {
          firstMcpResult.issues.push(...redundancyIssues);
        }
      }
    }
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
