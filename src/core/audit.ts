import { scanForContextFiles, scanForMcpConfigs, scanGlobalMcpConfigs } from './scanner.js';
import { parseContextFile } from './parser.js';
import { parseMcpConfig } from './mcp-parser.js';
import { countTokens } from '../utils/tokens.js';
import { checkPaths } from './checks/paths.js';
import { checkCommands } from './checks/commands.js';
import { checkStaleness } from './checks/staleness.js';
import { checkTokens, checkAggregateTokens } from './checks/tokens.js';
import { checkTierTokens } from './checks/tier-tokens.js';
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
import { scanSessionData } from './session-scanner.js';
import { checkMissingSecret } from './checks/session/missing-secret.js';
import { checkDivergedFile } from './checks/session/diverged-file.js';
import { checkMissingWorkflow } from './checks/session/missing-workflow.js';
import { checkStaleMemory } from './checks/session/stale-memory.js';
import { checkDuplicateMemory } from './checks/session/duplicate-memory.js';
import { checkLoopDetection } from './checks/session/loop-detection.js';
import { checkCiCoverage } from './checks/ci-coverage.js';
import { checkCiSecrets } from './checks/ci-secrets.js';
import type {
  LintResult,
  FileResult,
  LintIssue,
  CheckName,
  McpCheckName,
  SessionCheckName,
  ParsedMcpConfig,
} from './types.js';
import { VERSION } from '../version.js';

export const ALL_CHECKS: CheckName[] = [
  'paths',
  'commands',
  'staleness',
  'tokens',
  'tier-tokens',
  'redundancy',
  'contradictions',
  'frontmatter',
  'ci-coverage',
  'ci-secrets',
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

export const ALL_SESSION_CHECKS: SessionCheckName[] = [
  'session-missing-secret',
  'session-diverged-file',
  'session-missing-workflow',
  'session-stale-memory',
  'session-duplicate-memory',
  'session-loop-detection',
];

export interface AuditOptions {
  depth?: number;
  extraPatterns?: string[];
  mcp?: boolean;
  mcpGlobal?: boolean;
  mcpOnly?: boolean;
  session?: boolean;
  sessionOnly?: boolean;
}

function hasMcpChecks(checks: CheckName[]): boolean {
  return checks.some((c) => c.startsWith('mcp-'));
}

function hasSessionChecks(checks: CheckName[]): boolean {
  return checks.some((c) => c.startsWith('session-'));
}

export async function runAudit(
  projectRoot: string,
  activeChecks: CheckName[],
  options: AuditOptions = {},
): Promise<LintResult> {
  const fileResults: FileResult[] = [];

  const shouldRunContextChecks = !options.mcpOnly && !options.sessionOnly;
  const shouldRunMcpChecks =
    options.mcp || options.mcpGlobal || options.mcpOnly || hasMcpChecks(activeChecks);
  const shouldRunSessionChecks =
    options.session || options.sessionOnly || hasSessionChecks(activeChecks);

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
      if (activeChecks.includes('tier-tokens')) checkPromises.push(checkTierTokens(file));
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

    // Cross-file context checks — collected into a synthetic project-level result
    const crossFileIssues: LintIssue[] = [];
    if (activeChecks.includes('tokens')) {
      const aggIssue = checkAggregateTokens(
        fileResults.map((f) => ({ path: f.path, tokens: f.tokens })),
      );
      if (aggIssue) crossFileIssues.push(aggIssue);
    }
    if (activeChecks.includes('redundancy')) {
      crossFileIssues.push(...checkDuplicateContent(parsed));
    }
    if (activeChecks.includes('contradictions')) {
      crossFileIssues.push(...checkContradictions(parsed));
    }
    if (activeChecks.includes('ci-coverage')) {
      crossFileIssues.push(...(await checkCiCoverage(parsed, projectRoot)));
    }
    if (activeChecks.includes('ci-secrets')) {
      crossFileIssues.push(...(await checkCiSecrets(parsed, projectRoot)));
    }
    if (crossFileIssues.length > 0) {
      fileResults.push({
        path: '(project)',
        isSymlink: false,
        tokens: 0,
        lines: 0,
        issues: crossFileIssues,
      });
    }
  }

  // --- MCP config checks ---
  if (shouldRunMcpChecks) {
    const mcpFiles = await scanForMcpConfigs(projectRoot);
    const mcpConfigs: ParsedMcpConfig[] = await Promise.all(
      mcpFiles.map((f) => parseMcpConfig(f, projectRoot, 'project')),
    );

    if (options.mcpGlobal) {
      const globalFiles = await scanGlobalMcpConfigs();
      const globalConfigs = await Promise.all(
        globalFiles.map((f) => parseMcpConfig(f, projectRoot, 'user')),
      );
      mcpConfigs.push(...globalConfigs);
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
        tokens: countTokens(config.content),
        lines,
        issues,
      });
    }

    // Cross-file MCP checks — collected into a synthetic result
    const crossMcpIssues: LintIssue[] = [];
    if (mcpChecksToRun.includes('mcp-consistency')) {
      crossMcpIssues.push(...(await checkMcpConsistency(mcpConfigs)));
    }
    if (mcpChecksToRun.includes('mcp-redundancy')) {
      crossMcpIssues.push(...(await checkMcpRedundancy(mcpConfigs)));
    }
    if (crossMcpIssues.length > 0) {
      fileResults.push({
        path: '(mcp)',
        isSymlink: false,
        tokens: 0,
        lines: 0,
        issues: crossMcpIssues,
      });
    }
  }

  // --- Session checks ---
  if (shouldRunSessionChecks) {
    const activeSessionChecks = activeChecks.filter((c) =>
      c.startsWith('session-'),
    ) as SessionCheckName[];
    const sessionChecksToRun =
      activeSessionChecks.length > 0
        ? activeSessionChecks
        : options.session || options.sessionOnly
          ? ALL_SESSION_CHECKS
          : [];

    if (sessionChecksToRun.length > 0) {
      const sessionCtx = await scanSessionData(projectRoot);

      const sessionPromises: Promise<LintIssue[]>[] = [];
      if (sessionChecksToRun.includes('session-missing-secret'))
        sessionPromises.push(checkMissingSecret(sessionCtx));
      if (sessionChecksToRun.includes('session-diverged-file'))
        sessionPromises.push(checkDivergedFile(sessionCtx));
      if (sessionChecksToRun.includes('session-missing-workflow'))
        sessionPromises.push(checkMissingWorkflow(sessionCtx));
      if (sessionChecksToRun.includes('session-stale-memory'))
        sessionPromises.push(checkStaleMemory(sessionCtx));
      if (sessionChecksToRun.includes('session-duplicate-memory'))
        sessionPromises.push(checkDuplicateMemory(sessionCtx));
      if (sessionChecksToRun.includes('session-loop-detection'))
        sessionPromises.push(checkLoopDetection(sessionCtx));

      const sessionResults = await Promise.all(sessionPromises);
      const sessionIssues = sessionResults.flat();

      if (sessionIssues.length > 0) {
        fileResults.push({
          path: '~/.claude/ (session audit)',
          isSymlink: false,
          tokens: 0,
          lines: 0,
          issues: sessionIssues,
        });
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
