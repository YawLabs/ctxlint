import {
  scanForContextFiles,
  scanForMcpConfigs,
  scanForMcphConfigs,
  scanGlobalMcpConfigs,
  scanGlobalMcphConfigs,
} from './scanner.js';
import { parseContextFile } from './parser.js';
import { parseMcpConfig } from './mcp-parser.js';
import { parseMcphConfig } from './mcph-parser.js';
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
import { checkMcphTokenSecurity } from './checks/mcph/token-security.js';
import { checkMcphApibase } from './checks/mcph/apibase.js';
import { checkMcphSchemaConformance } from './checks/mcph/schema-conformance.js';
import { checkMcphLists } from './checks/mcph/lists.js';
import { checkMcphGitignore } from './checks/mcph/gitignore.js';
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
  type McphCheckName,
  type SessionCheckName,
  type SkillCheckName,
  type ParsedMcpConfig,
  type ParsedMcphConfig,
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

export const ALL_MCPH_CHECKS: McphCheckName[] = [
  'mcph-token-security',
  'mcph-apibase',
  'mcph-schema-conformance',
  'mcph-lists',
  'mcph-gitignore',
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
  mcph?: boolean;
  mcphGlobal?: boolean;
  mcphOnly?: boolean;
  mcphStrictEnvToken?: boolean;
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
   */
  ignoreRules?: IgnoreRule[];
}

function hasMcpChecks(checks: CheckName[]): boolean {
  return checks.some((c) => c.startsWith('mcp-'));
}

function hasMcphChecks(checks: CheckName[]): boolean {
  return checks.some((c) => c.startsWith('mcph-'));
}

function hasSessionChecks(checks: CheckName[]): boolean {
  return checks.some((c) => c.startsWith('session-'));
}

function hasSkillChecks(checks: CheckName[]): boolean {
  return checks.some((c) => c.startsWith('skill-'));
}

/**
 * Derive the list of checks to actually run for a given subsystem (mcp, mcph,
 * session, ...). Two paths share a single rule:
 *
 *  - If the user passed `--checks` and any of them target this subsystem
 *    (matched by prefix), run exactly those.
 *  - Otherwise, if the subsystem was enabled via one of its top-level flags
 *    (`--mcp`, `--mcph-only`, etc.), run all of its checks.
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

  const shouldRunContextChecks =
    !options.mcpOnly && !options.mcphOnly && !options.sessionOnly && !options.skillsOnly;
  const shouldRunMcpChecks =
    options.mcp || options.mcpGlobal || options.mcpOnly || hasMcpChecks(activeChecks);
  const shouldRunMcphChecks =
    options.mcph || options.mcphGlobal || options.mcphOnly || hasMcphChecks(activeChecks);
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
        checkPromises.push(checkTierTokens(file, projectRoot, thresholds));
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

  // --- mcph (mcp.hosting CLI) config checks ---
  if (shouldRunMcphChecks) {
    const projectMcphFiles = await scanForMcphConfigs(projectRoot);
    const mcphConfigs: ParsedMcphConfig[] = await Promise.all(
      projectMcphFiles.map((f) =>
        parseMcphConfig(
          f,
          projectRoot,
          f.relativePath.endsWith('.mcph.local.json') ? 'project-local' : 'project',
        ),
      ),
    );

    if (options.mcphGlobal) {
      const globalMcphFiles = await scanGlobalMcphConfigs();
      const globalMcphConfigs = await Promise.all(
        globalMcphFiles.map((f) => parseMcphConfig(f, projectRoot, 'global')),
      );
      mcphConfigs.push(...globalMcphConfigs);
    }

    const mcphChecksToRun = deriveChecksToRun<McphCheckName>(
      activeChecks,
      'mcph-',
      Boolean(options.mcph || options.mcphGlobal || options.mcphOnly),
      ALL_MCPH_CHECKS,
    );

    for (const config of mcphConfigs) {
      const checkPromises: Promise<LintIssue[]>[] = [];

      if (mcphChecksToRun.includes('mcph-token-security')) {
        checkPromises.push(
          checkMcphTokenSecurity(config, projectRoot, {
            strictEnvToken: options.mcphStrictEnvToken,
          }),
        );
      }
      if (mcphChecksToRun.includes('mcph-apibase')) {
        checkPromises.push(checkMcphApibase(config, projectRoot));
      }
      if (mcphChecksToRun.includes('mcph-schema-conformance')) {
        checkPromises.push(checkMcphSchemaConformance(config, projectRoot));
      }
      if (mcphChecksToRun.includes('mcph-lists')) {
        checkPromises.push(checkMcphLists(config, projectRoot));
      }
      if (mcphChecksToRun.includes('mcph-gitignore')) {
        checkPromises.push(checkMcphGitignore(config, projectRoot));
      }

      const results = await Promise.all(checkPromises);
      const issues = results.flat();

      // Surface parse errors as issues too (so users see them) — but only
      // when schema-conformance is in the active check set. Otherwise
      // `--checks mcph-token-security` would emit a `mcph-schema-conformance`
      // issue the user explicitly opted out of, breaking the rule that the
      // `check:` field on every emitted issue corresponds to a check the user
      // asked to run.
      if (mcphChecksToRun.includes('mcph-schema-conformance')) {
        for (const err of config.parseErrors) {
          issues.push({
            severity: 'error',
            check: 'mcph-schema-conformance',
            ruleId: 'mcph-schema-conformance/parse-error',
            line: 1,
            message: err,
          });
        }
      }

      const lines = config.content.split('\n').length;
      fileResults.push({
        path: config.relativePath,
        isSymlink: false,
        tokens: countTokens(config.content),
        lines,
        issues,
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
      // Mirrors how mcph configs are pushed even when their issue list is
      // empty (above).
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
    // order. We walk the flat list again, keeping items whose corresponding
    // entry survived: a Set of preserved indices is built from `kept`'s
    // reference identity.
    const keptSet = new Set(applied.kept);
    const rebuilt: LintIssue[][] = fileResults.map(() => []);
    flat.forEach((issue, i) => {
      if (keptSet.has(issue)) rebuilt[owners[i]].push(issue);
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
      if (issue.check === 'redundancy' && issue.suggestion) {
        const tokenMatch = issue.suggestion.match(/~(\d+)\s+tokens/);
        if (tokenMatch) estimatedWaste += parseInt(tokenMatch[1], 10);
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
