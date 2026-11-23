import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  scanForContextFiles,
  scanForMcpConfigs,
  scanGlobalMcpConfigs,
  type DiscoveredFile,
} from './scanner.js';
import { parseContextFile } from './parser.js';
import { parseMcpConfig } from './mcp-parser.js';
import { countTokens } from '../utils/tokens.js';
import { isSymlink, readSymlinkTarget } from '../utils/fs.js';
import { checkPaths } from './checks/paths.js';
import { checkCommands } from './checks/commands.js';
import { checkStaleness } from './checks/staleness.js';
import { collectSuppressions, isSuppressed } from './suppressions.js';
import {
  checkTokens,
  checkAggregateTokens,
  resolveTokenThresholds,
  withoutSymlinkAliases,
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
import { checkSharedTempPath } from './checks/session/shared-temp-path.js';
import { checkUnverifiedGateClaimedClean } from './checks/session/unverified-gate-claimed-clean.js';
import { checkDefaultBranchAccumulation } from './checks/session/default-branch-accumulation.js';
import { checkUnresolvableSha } from './checks/session/unresolvable-sha.js';
import { checkLargeRead } from './checks/session/large-read.js';
import { checkCiCoverage } from './checks/ci-coverage.js';
import { checkCiSecrets } from './checks/ci-secrets.js';
import { checkContentSecrets, redactSecrets } from './checks/content-secrets.js';
import { checkHookCoverage } from './checks/hook-coverage.js';
import { scanSkillFiles } from './skill-scanner.js';
import { checkSkills } from './checks/skills.js';
import {
  applyIgnoreRules,
  compileRules,
  type IgnoreApplyResult,
  type IgnoreRule,
} from './ignore-rules.js';
import { loadIgnoreFile, matchesGlob, type IgnoreFileRule } from './ignore-file.js';
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
  type ParsedContextFile,
  type ParsedMcpConfig,
  type IgnoreReport,
  type VersionSkew,
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
  'session-shared-temp-path',
  'session-unverified-gate-claimed-clean',
  'session-default-branch-accumulation',
  'session-unresolvable-sha',
  'session-large-read',
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
  /**
   * Globs of context files and project MCP configs to drop before any check
   * runs (config key `exclude`). Removes files from the corpus rather than
   * suppressing their findings, so excluded files are also invisible to the
   * cross-file checks. See ScanOptions.exclude for why this is not
   * expressible as an ignore rule.
   *
   * Consulted by context discovery and project MCP-config discovery (not the
   * user-global MCP configs, the session data or the skill tree, which live
   * outside the project), so an `mcpOnly` caller should forward it too.
   */
  exclude?: string[];
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
  /**
   * When true, .ctxlintignore is not loaded. Config-based ignoreRules still
   * apply. Corresponds to --no-ignore-file on the CLI.
   */
  noIgnoreFile?: boolean;
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
 * Derive the list of checks to actually run for a given subsystem. All
 * subsystem arms (mcp, session, skill) share this single rule:
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

/**
 * Run the active single-file context checks against one parsed file and apply
 * its inline `<!-- ctxlint-ignore-... -->` directives. Shared by runAudit (one
 * call per discovered file) and runAuditOnContent (the editor buffer), so both
 * dispatch checks identically.
 */
async function runSingleFileChecks(
  parseResult: ParsedContextFile,
  projectRoot: string,
  activeChecks: CheckName[],
  thresholds: TokenThresholds,
  options: AuditOptions,
): Promise<LintIssue[]> {
  const checkPromises: Promise<LintIssue[]>[] = [];
  if (activeChecks.includes('paths')) checkPromises.push(checkPaths(parseResult, projectRoot));
  if (activeChecks.includes('commands'))
    checkPromises.push(checkCommands(parseResult, projectRoot));
  if (activeChecks.includes('staleness'))
    checkPromises.push(checkStaleness(parseResult, projectRoot));
  if (activeChecks.includes('tokens'))
    checkPromises.push(checkTokens(parseResult, projectRoot, thresholds));
  if (activeChecks.includes('tier-tokens'))
    checkPromises.push(
      checkTierTokens(parseResult, projectRoot, thresholds, Boolean(options.hooksGlobal)),
    );
  if (activeChecks.includes('redundancy'))
    checkPromises.push(checkRedundancy(parseResult, projectRoot));
  if (activeChecks.includes('frontmatter'))
    checkPromises.push(checkFrontmatter(parseResult, projectRoot));
  if (activeChecks.includes('content-secrets'))
    checkPromises.push(checkContentSecrets(parseResult, projectRoot));

  const results = await Promise.all(checkPromises);
  // Apply inline `<!-- ctxlint-ignore-... -->` directives here rather than
  // inside each check: this is the single point every single-file check's
  // output passes through, so a newly added check inherits suppression
  // support instead of having to remember to honour it.
  // The relative path names the file in a malformed-directive warning.
  const suppressions = collectSuppressions(parseResult.content, parseResult.relativePath);
  return results.flat().filter((issue) => !isSuppressed(suppressions, issue));
}

/**
 * Tokens loaded every session: the sum over context files, with a symlink
 * whose target is another counted file (AGENTS.md -> CLAUDE.md) counted once,
 * the same rule tokens/aggregate applies. MCP configs and the synthetic
 * buckets are not context, so callers pass context files only. This is
 * `summary.totalTokens`, the number every output format prints. Pass
 * `projectRoot` so an alias with an ABSOLUTE in-root target is deduped too;
 * without it only relative targets can be resolved.
 */
export function contextTokenTotal(
  files: ReadonlyArray<Pick<FileResult, 'path' | 'tokens' | 'isSymlink' | 'symlinkTarget'>>,
  projectRoot?: string,
): number {
  return withoutSymlinkAliases(files, projectRoot).reduce((sum, f) => sum + f.tokens, 0);
}

/**
 * The settings file a hook-coverage finding came from, as a project-relative
 * path, or null for the user-global file. Read from the structured
 * `issue.file` the check sets for project sources -- never parsed back out of
 * the message, so rewording the message cannot misroute a finding.
 */
function hookCoverageFile(issue: LintIssue, projectRoot: string): string | null {
  const rel = issue.file;
  if (!rel || rel.startsWith('~') || path.isAbsolute(rel)) return null;
  return fs.existsSync(path.join(projectRoot, rel)) ? rel : null;
}

/**
 * Which parts of the session context the selected checks read. Verified
 * against each check's use of `ctx.history` / `ctx.memories` /
 * `ctx.siblings`; the remaining session checks read transcripts or the
 * memory index directly and need none of the three.
 */
const SESSION_NEEDS: Record<'history' | 'memories' | 'siblings', SessionCheckName[]> = {
  history: ['session-loop-detection', 'session-missing-secret', 'session-shared-temp-path'],
  memories: ['session-stale-memory', 'session-duplicate-memory', 'session-unresolvable-sha'],
  siblings: [
    'session-missing-secret',
    'session-diverged-file',
    'session-missing-workflow',
    // Attributes a SHA to another repo by matching sibling names.
    'session-unresolvable-sha',
  ],
};

/**
 * When the project being scanned IS a ctxlint checkout, report its declared
 * version if it differs from the binary doing the scanning.
 *
 * The failure this prevents: a globally-installed CLI several patches behind
 * the working tree silently reports findings that the checkout has already
 * fixed. Because the output is what an agent acts on at session start, the
 * stale result gets treated as current and someone re-investigates a closed
 * bug. Returns undefined when they agree or the project is not ctxlint.
 *
 * Deliberately no network call and no registry lookup -- this only fires on a
 * self-scan, where the comparison is free and unambiguous.
 */
export function detectVersionSkew(
  projectRoot: string,
  runningVersion: string = VERSION,
): VersionSkew | undefined {
  try {
    const pkgPath = path.join(projectRoot, 'package.json');
    if (!fs.existsSync(pkgPath)) return undefined;
    // Strip a UTF-8 BOM before parsing. `JSON.parse` throws on a leading BOM,
    // and BOM-prefixed JSON is routine on Windows (PowerShell's `Out-File
    // -Encoding utf8` emits one), so without this the check silently
    // self-disables on the platform where it is most likely to be needed.
    const raw = fs.readFileSync(pkgPath, 'utf8').replace(/^\uFEFF/, '');
    const pkg = JSON.parse(raw) as { name?: unknown; version?: unknown };
    if (pkg.name !== 'ctxlint' && pkg.name !== '@yawlabs/ctxlint') return undefined;
    if (typeof pkg.version !== 'string' || !pkg.version || pkg.version === runningVersion) {
      return undefined;
    }
    return { checkoutVersion: pkg.version, runningVersion };
  } catch {
    // A malformed or unreadable package.json is not worth failing a lint over.
    return undefined;
  }
}

function toFileResult(file: ParsedContextFile, issues: LintIssue[]): FileResult {
  return {
    path: file.relativePath,
    isSymlink: file.isSymlink,
    symlinkTarget: file.symlinkTarget,
    tokens: file.totalTokens,
    lines: file.totalLines,
    issues,
  };
}

export async function runAudit(
  projectRoot: string,
  activeChecks: CheckName[],
  options: AuditOptions = {},
): Promise<LintResult> {
  const fileResults: FileResult[] = [];
  // Context files only (not MCP configs, not buckets): summary.totalTokens.
  const contextResults: FileResult[] = [];
  const thresholds = resolveTokenThresholds(options.tokenThresholds);

  // Fail fast on a malformed ignoreRules regex BEFORE any checks run.
  // compileRules throws with the rule index + field + pattern; deferring to
  // the applyIgnoreRules call at the end would surface the same error only
  // after the entire audit had completed.
  if (options.ignoreRules && options.ignoreRules.length > 0) {
    compileRules(options.ignoreRules);
  }

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
      exclude: options.exclude,
    });

    // Parse and check every discovered file on every call. Results are never
    // carried across calls: they depend on the active checks, thresholds,
    // projectRoot, package.json, the rest of the file tree and git state, not
    // just the file's own bytes, so a long-lived caller (the MCP server, the
    // LSP) must get exactly what a fresh process would.
    const parsed: ParsedContextFile[] = [];
    for (const discoveredFile of discovered) {
      const parseResult = parseContextFile(discoveredFile);
      parsed.push(parseResult);
      const fr = toFileResult(
        parseResult,
        await runSingleFileChecks(parseResult, projectRoot, activeChecks, thresholds, options),
      );
      fileResults.push(fr);
      contextResults.push(fr);
    }

    // Cross-file context checks: each reads the whole parsed set.
    const crossFileIssues: LintIssue[] = [];
    if (activeChecks.includes('tokens')) {
      // An alias (AGENTS.md -> CLAUDE.md) counts once; passing the root lets
      // an ABSOLUTE in-root link target be caught too -- the same set
      // summary.totalTokens sums (contextTokenTotal).
      const aggIssue = checkAggregateTokens(contextResults, thresholds, projectRoot);
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
      // Filed under the settings file each finding is in, so editors and
      // SARIF can open it at the line. The user-global file is outside the
      // project and stays in the "(project)" bucket.
      const byFile = new Map<string, LintIssue[]>();
      for (const issue of await checkHookCoverage(projectRoot, undefined, {
        userGlobal: options.hooksGlobal,
      })) {
        const file = hookCoverageFile(issue, projectRoot);
        if (file === null) {
          crossFileIssues.push(issue);
          continue;
        }
        const list = byFile.get(file) ?? [];
        list.push(issue);
        byFile.set(file, list);
      }
      for (const [file, issues] of byFile) {
        let lines = 0;
        try {
          lines = fs.readFileSync(path.join(projectRoot, file), 'utf-8').split('\n').length;
        } catch {
          // Read moments ago by the check; a vanished file just reports 0 lines.
        }
        // tokens: 0 -- a settings file is not context loaded into the prompt.
        fileResults.push({ path: file, isSymlink: false, tokens: 0, lines, issues });
      }
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
    const mcpFiles = await scanForMcpConfigs(projectRoot, { exclude: options.exclude });
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
    const sessionChecksToRun = deriveChecksToRun<SessionCheckName>(
      activeChecks,
      'session-',
      Boolean(options.session || options.sessionOnly),
      ALL_SESSION_CHECKS,
    );

    if (sessionChecksToRun.length > 0) {
      const needs = (part: keyof typeof SESSION_NEEDS) =>
        SESSION_NEEDS[part].some((c) => sessionChecksToRun.includes(c));
      const sessionCtx = await scanSessionData(projectRoot, {
        history: needs('history'),
        memories: needs('memories'),
        siblings: needs('siblings'),
      });

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
      if (sessionChecksToRun.includes('session-shared-temp-path'))
        sessionPromises.push(checkSharedTempPath(sessionCtx));
      if (sessionChecksToRun.includes('session-unverified-gate-claimed-clean'))
        sessionPromises.push(checkUnverifiedGateClaimedClean(sessionCtx));
      if (sessionChecksToRun.includes('session-default-branch-accumulation'))
        sessionPromises.push(checkDefaultBranchAccumulation(sessionCtx));
      if (sessionChecksToRun.includes('session-unresolvable-sha'))
        sessionPromises.push(checkUnresolvableSha(sessionCtx));
      if (sessionChecksToRun.includes('session-large-read'))
        sessionPromises.push(checkLargeRead(sessionCtx));

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

  const result = finalizeResult(
    projectRoot,
    fileResults,
    contextTokenTotal(contextResults, projectRoot),
    options,
  );
  const skew = detectVersionSkew(projectRoot);
  if (skew) result.versionSkew = skew;
  return result;
}

/**
 * Strip known-format secrets out of an issue's human-readable text. Checks
 * quote source text verbatim (a directive line, a command, a URL), and that
 * text is printed, serialized to JSON/SARIF and returned to MCP callers.
 * `fix` is deliberately left alone: the fixer needs the real oldText, so the
 * serializers in reporter.ts / mcp/server.ts redact it at output time.
 */
function redactIssueText(issue: LintIssue): void {
  issue.message = redactSecrets(issue.message);
  if (issue.suggestion !== undefined) issue.suggestion = redactSecrets(issue.suggestion);
  if (issue.detail !== undefined) issue.detail = redactSecrets(issue.detail);
}

/**
 * applyIgnoreRules over the UNREDACTED issues, then again over the redacted
 * text of what survived. The first pass lets a rule name a real token as the
 * user wrote it in their source (redaction masked it, so such a rule never
 * fired); the second keeps a rule copied from redacted output working. A rule
 * is unused only when it fired in neither pass. Issues are not modified.
 */
function applyRules(issues: LintIssue[], rules: IgnoreRule[]): IgnoreApplyResult {
  const raw = applyIgnoreRules(issues, rules);
  const redacted = applyIgnoreRules(
    raw.kept.map((i) => ({ ...i, message: redactSecrets(i.message) })),
    rules,
  );
  const keepMask: boolean[] = [];
  const kept: LintIssue[] = [];
  let j = 0;
  issues.forEach((issue, i) => {
    const keep = raw.keepMask[i] && redacted.keepMask[j++];
    keepMask.push(keep);
    if (keep) kept.push(issue);
  });
  // Unused in both passes. unusedRules are fresh objects in rule order, so
  // intersect by content (identical rules are interchangeable).
  const rawUnused = new Map<string, number>();
  for (const r of raw.unusedRules) {
    const k = JSON.stringify(r);
    rawUnused.set(k, (rawUnused.get(k) ?? 0) + 1);
  }
  const unusedRules = redacted.unusedRules.filter((r) => {
    const k = JSON.stringify(r);
    const n = rawUnused.get(k) ?? 0;
    if (n === 0) return false;
    rawUnused.set(k, n - 1);
    return true;
  });
  return {
    kept,
    keepMask,
    dropped: raw.dropped + redacted.dropped,
    unusedRules,
    rulesMissingReason: raw.rulesMissingReason,
  };
}

/**
 * Redact issue text, apply `.ctxlintignore` and config `ignoreRules` to the
 * collected file results, then build the LintResult (summary, estimatedWaste,
 * ignore report). Mutates the issues of `fileResults` in place.
 *
 * Every issue reaches a LintResult through here (runAudit for context, cross-
 * file, MCP, session and skill issues; runAuditOnContent for the LSP buffer),
 * so a newly added check inherits the redaction.
 */
function finalizeResult(
  projectRoot: string,
  fileResults: FileResult[],
  totalTokens: number,
  options: AuditOptions,
): LintResult {
  // Redaction runs AFTER the ignore rules (bottom of this block): a rule's
  // `match` is tested against the unredacted message (what the user sees in
  // their own source), and also against the redacted one (what they see in
  // the output they may have copied the rule from) -- see applyRules.

  // Load .ctxlintignore from the project root (unless --no-ignore-file was passed).
  // Split into glob-scoped rules (_fileGlob set) and global rules (no glob).
  // Global file rules are merged with config-based ignoreRules for the shared
  // applyIgnoreRules() pass. Glob-scoped rules are pre-filtered per FileResult:
  // each rule is applied only to the file(s) whose path matches the glob,
  // suppressing matching issues before they reach the flat pass.
  const fileIgnoreRules: IgnoreFileRule[] = options.noIgnoreFile ? [] : loadIgnoreFile(projectRoot);
  const globScopedRules = fileIgnoreRules.filter((r) => r._fileGlob !== undefined);
  const globalFileRules: IgnoreRule[] = fileIgnoreRules
    .filter((r) => r._fileGlob === undefined)
    .map(({ _fileGlob: _unused, ...rest }) => rest);

  // Pre-filter pass: apply glob-scoped rules to each FileResult individually.
  // This runs before the flat applyIgnoreRules() pass so glob-filtered drops
  // are counted in the same ignoreReport.
  let globDropped = 0;
  let globUnusedRules: IgnoreRule[] = [];
  let globRulesMissingReason: IgnoreRule[] = [];
  if (globScopedRules.length > 0) {
    const firedGlobRules = new Set<IgnoreFileRule>();
    for (const fr of fileResults) {
      // Apply the glob rules matching this file one at a time, in file order.
      // Each rule sees only what earlier rules kept, which is the same
      // first-matching-rule-wins outcome as one combined pass -- and it tells
      // us which rule dropped what.
      for (const rule of globScopedRules) {
        if (!matchesGlob(fr.path, rule._fileGlob!)) continue;
        const { _fileGlob: _, ...plainRule } = rule;
        const applied = applyRules(fr.issues, [plainRule]);
        fr.issues = applied.kept;
        globDropped += applied.dropped;
        if (applied.dropped > 0) firedGlobRules.add(rule);
      }
    }
    // Unused glob rules: those that dropped no finding in any file -- whether
    // their glob matched nothing or matched files with nothing to drop. Same
    // meaning as an unused rule in the flat pass below. Counting a glob match
    // as firing hid a rule that suppresses nothing from the drift report.
    globUnusedRules = globScopedRules
      .filter((r) => !firedGlobRules.has(r))
      .map(({ _fileGlob: _unused, ...rest }) => rest);
    globRulesMissingReason = globScopedRules
      .filter((r) => !r.reason)
      .map(({ _fileGlob: _unused, ...rest }) => rest);
  }

  // Apply ignoreRules (granular per-finding suppression) before computing
  // summary / estimatedWaste so dropped findings aren't counted in either.
  // The rule engine is per-issue-list, but we want a single fired-tracking
  // pass across the whole audit -- so apply rules to the flattened issue
  // stream once, then partition kept issues back per FileResult by position.
  // Merge config-based rules with global (non-glob) file rules from .ctxlintignore.
  const allIgnoreRules: IgnoreRule[] = [...(options.ignoreRules ?? []), ...globalFileRules];
  let ignoreReport: IgnoreReport | undefined;
  // Built whenever any rule was loaded, not only when one dropped something:
  // with only glob-scoped rules and nothing dropped, the report used to be
  // skipped, hiding exactly the never-fired and missing-reason rules it lists.
  if (allIgnoreRules.length > 0 || globScopedRules.length > 0) {
    let flatDropped = 0;
    let flatUnusedRules: IgnoreRule[] = [];
    let flatRulesMissingReason: IgnoreRule[] = [];
    if (allIgnoreRules.length > 0) {
      const flat: LintIssue[] = [];
      const owners: number[] = [];
      fileResults.forEach((fr, idx) => {
        for (const issue of fr.issues) {
          flat.push(issue);
          owners.push(idx);
        }
      });
      const applied = applyRules(flat, allIgnoreRules);
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
      flatDropped = applied.dropped;
      flatUnusedRules = applied.unusedRules;
      flatRulesMissingReason = applied.rulesMissingReason;
    }
    ignoreReport = {
      dropped: flatDropped + globDropped,
      unusedRules: [...flatUnusedRules, ...globUnusedRules],
      rulesMissingReason: [...flatRulesMissingReason, ...globRulesMissingReason],
    };
  }

  // Redact only the surviving findings, after every ignore pass.
  for (const fr of fileResults) {
    for (const issue of fr.issues) redactIssueText(issue);
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
      // Context files only (see contextTokenTotal): MCP configs carry a
      // per-file token count but are not loaded into the prompt.
      totalTokens,
      estimatedWaste,
    },
  };

  if (ignoreReport) {
    result._meta = { ignoreReport };
  }

  return result;
}

/**
 * Run the single-file context checks against an in-memory buffer (unsaved
 * editor content) for the file at `filePath`.
 *
 * Everything except the file's own bytes comes from the real project: checks
 * resolve against the real `projectRoot` (its tree, package.json, git state),
 * the file keeps its real path and name (so `fix.file` and relative-path
 * resolution point at the document, and extension-less names such as
 * `.cursorrules` survive), and `.ctxlintignore` / `options.ignoreRules` apply
 * exactly as in runAudit. Only `content` replaces what is on disk.
 *
 * Cross-file checks (contradictions, duplicate content, aggregate tokens, CI
 * and hook coverage) are not run: they report against the synthetic
 * `(project)` path, which has no place in a single document's diagnostics.
 */
export async function runAuditOnContent(
  filePath: string,
  content: string,
  projectRoot: string,
  activeChecks: CheckName[] = ALL_CHECKS,
  options: AuditOptions = {},
): Promise<LintResult> {
  if (options.ignoreRules && options.ignoreRules.length > 0) {
    compileRules(options.ignoreRules);
  }
  const root = path.resolve(projectRoot);
  const absolutePath = path.resolve(filePath);
  const symlink = isSymlink(absolutePath);
  const parsed = parseBuffer(
    {
      absolutePath,
      relativePath: path.relative(root, absolutePath).replace(/\\/g, '/'),
      isSymlink: symlink,
      symlinkTarget: symlink ? readSymlinkTarget(absolutePath) : undefined,
      type: 'context',
    },
    content,
  );
  const thresholds = resolveTokenThresholds(options.tokenThresholds);
  const issues = await runSingleFileChecks(parsed, root, activeChecks, thresholds, options);
  const fr = toFileResult(parsed, issues);
  return finalizeResult(root, [fr], contextTokenTotal([fr], root), options);
}

/**
 * Parse `content` as if it were the on-disk bytes of `file`. parseContextFile
 * only reads from disk, so the buffer is parsed from a throwaway temp copy and
 * the result is re-pointed at the real path; nothing downstream ever sees the
 * temp path.
 */
function parseBuffer(file: DiscoveredFile, content: string): ParsedContextFile {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-lsp-'));
  try {
    const tmpFile = path.join(tmpDir, 'buffer');
    fs.writeFileSync(tmpFile, content, 'utf-8');
    return { ...parseContextFile({ ...file, absolutePath: tmpFile }), filePath: file.absolutePath };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; don't mask the real result.
    }
  }
}
