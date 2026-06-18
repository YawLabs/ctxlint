import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { scanForContextFiles, scanForMcpConfigs, scanGlobalMcpConfigs } from './scanner.js';
import { parseContextFile } from './parser.js';
import { getCacheEntry, setCacheEntry } from './cache.js';
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
import { applyIgnoreRules, compileRules, type IgnoreRule } from './ignore-rules.js';
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

export async function runAudit(
  projectRoot: string,
  activeChecks: CheckName[],
  options: AuditOptions = {},
): Promise<LintResult> {
  const fileResults: FileResult[] = [];
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
    });

    // Incremental file cache: stat each discovered file and reuse cached
    // parse + single-file check results when mtime and size are unchanged.
    const parsed: ReturnType<typeof parseContextFile>[] = [];
    const anyChanged: string[] = [];

    for (const discoveredFile of discovered) {
      const absPath = discoveredFile.absolutePath;
      let stat: { mtimeMs: number; size: number } | null = null;
      try {
        const s = fs.statSync(absPath);
        stat = { mtimeMs: s.mtimeMs, size: s.size };
      } catch {
        // File disappeared between scan and stat -- treat as cache miss.
      }

      const cached = getCacheEntry(absPath);
      const hit =
        stat !== null &&
        cached !== undefined &&
        cached.mtime === stat.mtimeMs &&
        cached.size === stat.size;

      if (hit && cached) {
        parsed.push(cached.parseResult);
        // Cache-hit files contribute their cached issues directly to fileResults
        // below (after the cross-file checks decision).
      } else {
        anyChanged.push(absPath);
        const parseResult = parseContextFile(discoveredFile);
        parsed.push(parseResult);

        // Run single-file checks now and cache the results.
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
        const singleFileIssues = results.flat();

        if (stat !== null) {
          setCacheEntry(absPath, {
            mtime: stat.mtimeMs,
            size: stat.size,
            parseResult,
            issues: singleFileIssues,
          });
        }
      }
    }

    // Emit per-file results using cached issues for hits, freshly computed
    // issues for misses (retrieved from cache since we just set them).
    for (const file of parsed) {
      const entry = getCacheEntry(file.filePath);
      const issues = entry ? entry.issues : [];
      fileResults.push({
        path: file.relativePath,
        isSymlink: file.isSymlink,
        symlinkTarget: file.symlinkTarget,
        tokens: file.totalTokens,
        lines: file.totalLines,
        issues,
      });
    }

    // Cross-file context checks — only re-run when at least one file changed.
    // When nothing changed, all per-file results came from cache and the
    // cross-file results from the previous run are still valid.
    if (anyChanged.length > 0) {
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
    const sessionChecksToRun = deriveChecksToRun<SessionCheckName>(
      activeChecks,
      'session-',
      Boolean(options.session || options.sessionOnly),
      ALL_SESSION_CHECKS,
    );

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

  // Load .ctxlintignore from the project root (unless --no-ignore-file was passed).
  // Split into glob-scoped rules (_fileGlob set) and global rules (no glob).
  // Global file rules are merged with config-based ignoreRules for the shared
  // applyIgnoreRules() pass. Glob-scoped rules are pre-filtered per FileResult:
  // each rule is applied only to the file(s) whose path matches the glob,
  // suppressing matching issues before they reach the flat pass.
  const fileIgnoreRules: IgnoreFileRule[] = options.noIgnoreFile
    ? []
    : loadIgnoreFile(projectRoot);
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
      // Collect the glob rules that apply to this specific file path.
      const applicableRules: IgnoreRule[] = [];
      for (const rule of globScopedRules) {
        if (matchesGlob(fr.path, rule._fileGlob!)) {
          const { _fileGlob: _unused, ...plainRule } = rule;
          applicableRules.push(plainRule);
          firedGlobRules.add(rule);
        }
      }
      if (applicableRules.length === 0) continue;
      const applied = applyIgnoreRules(fr.issues, applicableRules);
      fr.issues = applied.kept;
      globDropped += applied.dropped;
    }
    // Unused glob rules: those that never matched any file path's glob AND
    // whose plain-rule also never fired. Since firedGlobRules tracks which
    // rules matched at least one file, unfired = not in the set.
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
  const allIgnoreRules: IgnoreRule[] = [
    ...(options.ignoreRules ?? []),
    ...globalFileRules,
  ];
  let ignoreReport: IgnoreReport | undefined;
  if (allIgnoreRules.length > 0 || globDropped > 0) {
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
      const applied = applyIgnoreRules(flat, allIgnoreRules);
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

/**
 * Run the audit pipeline against an in-memory buffer (unsaved editor content).
 *
 * Writes `content` to a temporary file, runs the standard single-file context
 * checks, then cleans up. The returned LintResult's fileResults use the
 * original `filePath` (not the temp path) so LSP diagnostics map to the
 * correct document URI.
 */
export async function runAuditOnContent(
  filePath: string,
  content: string,
  projectRoot: string,
  options: AuditOptions = {},
): Promise<LintResult> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-lsp-'));
  const ext = path.extname(filePath) || '.md';
  const tmpFile = path.join(tmpDir, 'content' + ext);

  try {
    fs.writeFileSync(tmpFile, content, 'utf-8');

    // Run audit with extraPatterns pointing at the single temp file.
    // scanForContextFiles will pick it up via its own glob resolution when the
    // temp file name matches a known context-file pattern, but that's not
    // reliable for arbitrary file names. Instead we drive via the scanner's
    // extraPatterns mechanism and point projectRoot at the temp dir so the
    // scanner's depth-1 walk resolves the file.
    const tmpRelative = path.relative(tmpDir, tmpFile);
    const rawResult = await runAudit(tmpDir, options.depth !== undefined
      ? (ALL_CHECKS as CheckName[])
      : (ALL_CHECKS as CheckName[]), {
      ...options,
      extraPatterns: [tmpRelative],
      // Disable cross-project checks that need the real project tree.
      session: false,
      sessionOnly: false,
      skills: false,
      skillsOnly: false,
    });

    // Remap the temp path back to the original filePath so the LSP client sees
    // diagnostics on the real document URI.
    const remapped: typeof rawResult.files = rawResult.files.map((fr) => {
      const isTmp =
        fr.path === tmpRelative ||
        fr.path === tmpFile ||
        path.resolve(tmpDir, fr.path) === tmpFile;
      return isTmp ? { ...fr, path: filePath } : fr;
    });

    return { ...rawResult, files: remapped, projectRoot };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; don't mask the real result.
    }
  }
}
