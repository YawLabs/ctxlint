import { scanForContextFiles, scanForMcpConfigs, scanGlobalMcpConfigs } from './scanner.js';
import { parseContextFile } from './parser.js';
import { parseMcpConfig } from './mcp-parser.js';
import { countTokens } from '../utils/tokens.js';
import { checkPaths } from './checks/paths.js';
import { checkCommands } from './checks/commands.js';
import { checkStaleness } from './checks/staleness.js';
import {
  checkTokens,
  checkAggregateTokens,
  resolveTokenThresholds,
  type TokenThresholds,
} from './checks/tokens.js';
import { checkTierTokens, checkAggregateTierTokens } from './checks/tier-tokens.js';
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
import { checkMemoryIndexOverflow } from './checks/session/memory-index-overflow.js';
import { checkCiCoverage } from './checks/ci-coverage.js';
import { checkCiSecrets } from './checks/ci-secrets.js';
import { checkContentSecrets } from './checks/content-secrets.js';
import { checkHookCoverage } from './checks/hook-coverage.js';
import { scanSkillFiles } from './skill-scanner.js';
import { checkSkills } from './checks/skills.js';
import { applyIgnoreRules, type IgnoreRule } from './ignore-rules.js';
import {
  SESSION_AUDIT_LABEL,
  SKILL_AUDIT_LABEL,
  type LintResult,
  type FileResult,
  type LintIssue,
  type CheckName,
  type McpCheckName,
  type SessionCheckName,
  type SkillCheckName,
  type ParsedMcpConfig,
  type IgnoreReport,
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
  'content-secrets',
  'hook-coverage',
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
  'session-memory-index-overflow',
];

export const ALL_SKILL_CHECKS: SkillCheckName[] = [
  'skill-frontmatter',
  'skill-broken-ref',
  'skill-trigger-collision',
  'skill-orphaned',
  'skill-dead-tool-restriction',
];

export interface AuditOptions {
  depth?: number;
  extraPatterns?: string[];
  mcp?: boolean;
  mcpGlobal?: boolean;
  mcpOnly?: boolean;
  session?: boolean;
  sessionOnly?: boolean;
  skills?: boolean;
  skillsOnly?: boolean;
  /**
   * Opt-in: also scan the user-global `~/.claude/settings.json` in the
   * hook-coverage (dead-hook) check. Off by default so the standard run stays
   * inside the project directory, matching the session/skills opt-in posture.
   */
  hooksGlobal?: boolean;
  // Per-call token thresholds. When omitted, defaults from
  // DEFAULT_TOKEN_THRESHOLDS apply. Replaces the previous module-level
  // setTokenThresholds() so concurrent audits (e.g. from the MCP server)
  // don't share mutable state.
  tokenThresholds?: Partial<TokenThresholds>;
  /**
   * Granular per-finding suppression rules. Applied after all checks run --
   * a finding suppressed by an ignoreRule never appears in `LintResult.files`
   * but is reflected in `_meta.ignoreReport.dropped`.
   *
   * TRUST BOUNDARY: the `match` / `pathPattern` strings on each rule are
   * compiled via `new RegExp(...)` and executed against finding messages with
   * NO step cap (see ignore-rules.ts:compileRules). That is fine for the
   * current callers -- repo-author-trusted CLI input (`.ctxlintrc.json`),
   * same posture as an `.eslintrc.json` regex. If `ignoreRules` ever becomes
   * reachable from a less-trusted source (e.g. an MCP tool argument supplied
   * by a remote caller), these patterns become a ReDoS vector and MUST be run
   * through a safe-regex / step-bounded matcher before compilation.
   */
  ignoreRules?: IgnoreRule[];
}

function hasMcpChecks(checks: CheckName[]): boolean {
  return checks.some((c) => c.startsWith('mcp-'));
}

function hasSessionChecks(checks: CheckName[]): boolean {
  return checks.some((c) => c.startsWith('session-'));
}

function hasSkillChecks(checks: CheckName[]): boolean {
  return checks.some((c) => c.startsWith('skill-'));
}

/**
 * Derive the list of checks to actually run for a given subsystem (mcp,
 * session, ...). Two paths share a single rule:
 *
 *  - If the user passed `--checks` and any of them target this subsystem
 *    (matched by prefix), run exactly those.
 *  - Otherwise, if the subsystem was enabled via one of its top-level flags
 *    (`--mcp`, `--session-only`, etc.), run all of its checks.
 *  - Otherwise run none.
 *
 * The first branch fires even when the subsystem flag wasn't passed, which
 * preserves the long-standing tolerance for `--checks mcp-schema` without
 * also requiring `--mcp`.
 */
function deriveChecksToRun<T extends CheckName>(
  activeChecks: CheckName[],
  prefix: string,
  enabled: boolean,
  allChecks: readonly T[],
): T[] {
  const filtered = activeChecks.filter((c) => c.startsWith(prefix)) as T[];
  if (filtered.length > 0) return filtered;
  return enabled ? [...allChecks] : [];
}

export async function runAudit(
  projectRoot: string,
  activeChecks: CheckName[],
  options: AuditOptions = {},
): Promise<LintResult> {
  const fileResults: FileResult[] = [];
  const thresholds = resolveTokenThresholds(options.tokenThresholds);

  const shouldRunContextChecks = !options.mcpOnly && !options.sessionOnly && !options.skillsOnly;
  const shouldRunMcpChecks =
    options.mcp || options.mcpGlobal || options.mcpOnly || hasMcpChecks(activeChecks);
  const shouldRunSessionChecks =
    options.session || options.sessionOnly || hasSessionChecks(activeChecks);
  const shouldRunSkillChecks = options.skills || options.skillsOnly || hasSkillChecks(activeChecks);

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
      if (activeChecks.includes('tokens'))
        checkPromises.push(checkTokens(file, projectRoot, thresholds));
      if (activeChecks.includes('tier-tokens'))
        checkPromises.push(
          checkTierTokens(file, projectRoot, thresholds, Boolean(options.hooksGlobal)),
        );
      if (activeChecks.includes('redundancy'))
        checkPromises.push(checkRedundancy(file, projectRoot));
      if (activeChecks.includes('frontmatter'))
        checkPromises.push(checkFrontmatter(file, projectRoot));
      if (activeChecks.includes('content-secrets'))
        checkPromises.push(checkContentSecrets(file, projectRoot));

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
        thresholds,
      );
      if (aggIssue) crossFileIssues.push(aggIssue);
    }
    if (activeChecks.includes('tier-tokens')) {
      const tierAgg = checkAggregateTierTokens(parsed, thresholds);
      if (tierAgg) crossFileIssues.push(tierAgg);
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
    if (activeChecks.includes('hook-coverage')) {
      crossFileIssues.push(
        ...(await checkHookCoverage(projectRoot, undefined, {
          userGlobal: options.hooksGlobal,
        })),
      );
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
    const mcpChecksToRun = deriveChecksToRun<McpCheckName>(
      activeChecks,
      'mcp-',
      Boolean(options.mcp || options.mcpGlobal || options.mcpOnly),
      ALL_MCP_CHECKS,
    );

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
      // Also carries the per-server disabled-server rule, so it runs even for a single config.
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
      if (sessionChecksToRun.includes('session-memory-index-overflow'))
        sessionPromises.push(checkMemoryIndexOverflow(sessionCtx));

      const sessionResults = await Promise.all(sessionPromises);
      const sessionIssues = sessionResults.flat();

      // Always emit the session bucket when session checks ran, even with
      // zero issues. Otherwise a clean `--session-only` run produces "Found
      // 0 files" and the user can't tell whether the scan actually executed.
      fileResults.push({
        path: SESSION_AUDIT_LABEL,
        isSymlink: false,
        tokens: 0,
        lines: 0,
        issues: sessionIssues,
      });
    }
  }

  // --- Agent-skill checks (fourth pillar) ---
  if (shouldRunSkillChecks) {
    const skillChecksToRun = deriveChecksToRun<SkillCheckName>(
      activeChecks,
      'skill-',
      Boolean(options.skills || options.skillsOnly),
      ALL_SKILL_CHECKS,
    );

    if (skillChecksToRun.length > 0) {
      const skillCtx = scanSkillFiles();
      const skillIssues = checkSkills(skillCtx, {
        frontmatter: skillChecksToRun.includes('skill-frontmatter'),
        brokenRef: skillChecksToRun.includes('skill-broken-ref'),
        triggerCollision: skillChecksToRun.includes('skill-trigger-collision'),
        orphaned: skillChecksToRun.includes('skill-orphaned'),
        deadToolRestriction: skillChecksToRun.includes('skill-dead-tool-restriction'),
      });

      // Always emit the skill bucket when skill checks ran (even with zero
      // issues), mirroring the session bucket -- so a clean `--skills-only`
      // run shows the scan executed rather than "0 files found".
      fileResults.push({
        path: SKILL_AUDIT_LABEL,
        isSymlink: false,
        tokens: 0,
        lines: 0,
        issues: skillIssues,
      });
    }
  }

  // Apply ignoreRules (granular per-finding suppression) before computing
  // summary / estimatedWaste so dropped findings aren't counted in either.
  // The rule engine is per-issue-list, but we want a single fired-tracking
  // pass across the whole audit -- so apply rules to the flattened issue
  // stream once, then partition kept issues back per FileResult by position.
  let ignoreReport: IgnoreReport | undefined;
  if (options.ignoreRules && options.ignoreRules.length > 0) {
    const flat: LintIssue[] = [];
    const owners: number[] = [];
    fileResults.forEach((fr, idx) => {
      for (const issue of fr.issues) {
        flat.push(issue);
        owners.push(idx);
      }
    });
    const applied = applyIgnoreRules(flat, options.ignoreRules);
    // Rebuild per-FileResult issue lists from the kept subset, preserving
    // order. `applied.keepMask` is aligned 1:1 with `flat`, so we partition by
    // index + the parallel `owners` array -- no reliance on LintIssue object
    // reference identity between `flat` and `applied.kept` (two structurally
    // identical findings in different files would collide in a Set).
    const rebuilt: LintIssue[][] = fileResults.map(() => []);
    flat.forEach((issue, i) => {
      if (applied.keepMask[i]) rebuilt[owners[i]].push(issue);
    });
    fileResults.forEach((fr, idx) => {
      fr.issues = rebuilt[idx];
    });
    ignoreReport = {
      dropped: applied.dropped,
      unusedRules: applied.unusedRules,
      rulesMissingReason: applied.rulesMissingReason,
    };
  }

  let estimatedWaste = 0;
  for (const fr of fileResults) {
    for (const issue of fr.issues) {
      if (issue.check !== 'redundancy') continue;
      if (typeof issue.wastedTokens === 'number') {
        // Structured field set by the check -- preferred over scraping.
        estimatedWaste += issue.wastedTokens;
      } else if (issue.suggestion) {
        // Fallback: scrape `~N tokens` out of the suggestion for findings
        // that don't set the structured field (no regression). Sum ALL
        // matches -- a suggestion mentioning tokens twice would otherwise
        // be under-counted by taking only the first.
        for (const m of issue.suggestion.matchAll(/~(\d+)\s+tokens/g)) {
          estimatedWaste += parseInt(m[1], 10);
        }
      }
    }
  }

  const result: LintResult = {
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

  if (ignoreReport) {
    result._meta = { ignoreReport };
  }

  return result;
}
