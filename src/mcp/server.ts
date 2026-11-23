import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { scanForContextFiles } from '../core/scanner.js';
import { parseContextFile } from '../core/parser.js';
import {
  runAudit,
  contextTokenTotal,
  ALL_CHECKS,
  ALL_MCP_CHECKS,
  ALL_SESSION_CHECKS,
  ALL_SKILL_CHECKS,
} from '../core/audit.js';
import { applyFixes } from '../core/fixer.js';
import { redactResultForOutput } from '../core/reporter.js';
import { loadConfig } from '../core/config.js';
import { fileExists, isDirectory, isOutsideRelative, resetPackageJsonCache } from '../utils/fs.js';
import { findRenames } from '../utils/git.js';
import { freeEncoder, keepEncoderAlive } from '../utils/tokens.js';
import { resetGit } from '../utils/git.js';
import { resetPathsCache } from '../core/checks/paths.js';
import { clearTranscriptCache } from '../core/transcript.js';
import type {
  CheckName,
  LintResult,
  McpCheckName,
  SessionCheckName,
  SkillCheckName,
} from '../core/types.js';
import * as path from 'node:path';
import { VERSION } from '../version.js';
import { INSTRUCTIONS } from './instructions.js';

// Per-tool enums, not a single union. Previously every tool accepted every
// check name — so calling `ctxlint_audit` with `checks: ['mcp-schema']`
// would validate but silently do nothing (the audit only scans context
// files, not MCP configs). Each tool now only accepts check names for the
// domain it actually runs.
const contextCheckEnum = z.enum(ALL_CHECKS as [CheckName, ...CheckName[]]);
const mcpCheckEnum = z.enum(ALL_MCP_CHECKS as [McpCheckName, ...McpCheckName[]]);
const sessionCheckEnum = z.enum(ALL_SESSION_CHECKS as [SessionCheckName, ...SessionCheckName[]]);
const skillCheckEnum = z.enum(ALL_SKILL_CHECKS as [SkillCheckName, ...SkillCheckName[]]);

// Shell metacharacters + control chars that have no legitimate place in a
// filesystem path. Rejecting these at the tool boundary does two things:
// (1) defense-in-depth — ctxlint uses Node fs APIs (no shell), so there's
// no actual injection surface, but blocking obviously hostile input is
// cheap; (2) stops false-positive signals from scanners (mcp-compliance's
// injection tests look for reflected payloads in output) by erroring
// before the input gets resolved and echoed back.
const PATH_DISALLOWED = /[\n\r\t;`|]|\$\(|\$\{/;

function describeDisallowed(rawPath: string): string {
  const m = rawPath.match(PATH_DISALLOWED);
  if (!m) return 'unknown';
  // Print the offending sequence in a readable, single-line form. JSON.stringify
  // escapes control chars (`\n` -> `"\n"`) and quotes the value, which is exactly
  // what the caller wants in an error message that may itself end up logged or
  // copy-pasted.
  return JSON.stringify(m[0]);
}

/** A UNC (`\\host\share`) or device (`\\?\...`, `\\.\...`) path, in either slash style. */
function isUncOrDevicePath(p: string): boolean {
  return /^[\\/]{2}/.test(p);
}

function validateProjectPath(rawPath: string | undefined): string {
  if (!rawPath) return process.cwd();
  if (PATH_DISALLOWED.test(rawPath)) {
    throw new Error(
      `projectPath contains disallowed character ${describeDisallowed(rawPath)} (control chars and shell metacharacters are rejected)`,
    );
  }
  const resolved = path.resolve(rawPath);
  // A UNC path (\\host\share, //host/share) or a device path (\\?\, \\.\)
  // is rejected before anything touches it: stat-ing \\host\share makes
  // Windows open an SMB connection and send the user's NTLM credentials to
  // that host. Checked on the raw input too, in case resolution rewrote it.
  if (process.platform === 'win32' && (isUncOrDevicePath(rawPath) || isUncOrDevicePath(resolved))) {
    throw new Error('projectPath must be a local directory (UNC and device paths are rejected)');
  }
  if (!isDirectory(resolved)) {
    throw new Error('projectPath is not an existing directory');
  }
  return resolved;
}

/**
 * Load .ctxlintrc[.json] from the project root, swallowing errors. The MCP
 * tools should not fail the audit if the config file is malformed -- the
 * audit's value is the findings, not the config. CLI surfaces parse errors
 * to the user; MCP returns the un-ignored result instead.
 *
 * TRUST BOUNDARY: `projectRoot` derives from the caller's `projectPath`
 * argument (via validateProjectPath), so the .ctxlintrc.json loaded here is
 * attacker-influenceable if the caller points at a directory whose config it
 * does not control. We treat any projectPath-supplied .ctxlintrc.json as
 * TRUSTED input regardless: its `ignoreRules` regexes are compiled with
 * `new RegExp(...)` and run with NO step cap (see ignore-rules.ts trust
 * posture), so a hostile config is a latent ReDoS vector. This matches the
 * CLI posture (repo-author-trusted, same as .eslintrc.json) -- ctxlint
 * assumes the project root you audit is one you trust. Do not point an MCP
 * tool at an untrusted project root.
 */
function safeLoadConfig(projectRoot: string): ReturnType<typeof loadConfig> {
  try {
    return loadConfig(projectRoot);
  } catch {
    return null;
  }
}

function validateFilePathInput(rawPath: string): void {
  // Reject the empty string and bare-root references ('.', './'): these resolve
  // to the project root itself, so resolveWithinRoot returns root and the tool
  // would answer `{ path: '', exists: true }` -- a meaningless "the root exists"
  // for a tool whose job is to validate a *file* reference.
  if (rawPath.trim() === '' || rawPath === '.' || rawPath === './') {
    throw new Error('path must be a non-empty file path, not the project root');
  }
  if (PATH_DISALLOWED.test(rawPath)) {
    throw new Error(
      `path contains disallowed character ${describeDisallowed(rawPath)} (control chars and shell metacharacters are rejected)`,
    );
  }
}

// Resolve `filePath` against `root` and reject if the result escapes the
// project root. Handles `..`-traversal, absolute paths outside root, and
// (on Windows) drive-letter switches. Returns the resolved absolute path.
function resolveWithinRoot(filePath: string, root: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, filePath);
  const rel = path.relative(resolvedRoot, resolved);
  // Escapes if the relative path is a `..` segment or absolute (the latter on
  // Windows when drive letters differ). An in-root name such as `..foo.md`
  // starts with `..` but stays inside, so it is not a prefix test.
  if (isOutsideRelative(rel)) {
    throw new Error('path escapes the project root');
  }
  return resolved;
}

/**
 * The text block an audit tool returns: `summary` first, then the rest of the
 * result in its usual order, compact rather than indented.
 *
 * Yaw MCP caps a tool result (YAW_MCP_MAX_RESULT_BYTES, default 100000) by
 * cutting the last text block from the tail, so on a large project the part
 * that gets dropped is whatever comes last. LintResult puts `summary` after
 * the per-file issue list, which made the five counters the first casualty.
 * Indentation was a third or more of the bytes on a typical audit. There is
 * deliberately no structuredContent copy: that passes through the cap
 * uncapped, so duplicating the payload there would only double the bytes.
 *
 * Serialized from redactResultForOutput's copy: an mcp-security fix carries
 * the literal secret in `fix.oldText`, which must not reach the calling model.
 *
 * A tail cut still leaves invalid JSON, so the text is capped here, below the
 * host's limit: past `maxBytes`, issues are dropped from the end (file order,
 * then issue order) and files left with no issue are omitted, and a
 * `truncated` object right after `summary` says how many of each were left
 * out. `summary` still counts every finding. `versionSkew`, when present, sits
 * right after `summary` too: it says whether the rest can be trusted.
 */
export const MAX_AUDIT_TEXT_BYTES = 90_000;

export function auditText(result: LintResult, maxBytes: number = MAX_AUDIT_TEXT_BYTES): string {
  const { summary, versionSkew, ...rest } = redactResultForOutput(result);
  const head = versionSkew ? { summary, versionSkew } : { summary };
  const full = JSON.stringify({ ...head, ...rest });
  if (Buffer.byteLength(full, 'utf8') <= maxBytes) return full;

  const totalIssues = rest.files.reduce((n, f) => n + f.issues.length, 0);
  const build = (keep: number): string => {
    let left = keep;
    const files: typeof rest.files = [];
    for (const f of rest.files) {
      if (left <= 0) break;
      const issues = f.issues.slice(0, left);
      left -= issues.length;
      if (issues.length > 0) files.push({ ...f, issues });
    }
    const truncated = {
      droppedIssues: totalIssues - keep,
      droppedFiles: rest.files.length - files.length,
      reason: `result exceeded ${maxBytes} bytes; rerun with fewer checks or a narrower projectPath for the rest`,
    };
    return JSON.stringify({ ...head, truncated, ...rest, files });
  };
  // Largest issue count whose serialization fits (monotone in `keep`).
  let lo = 0;
  let hi = totalIssues;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(build(mid), 'utf8') <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return build(lo);
}

const server = new McpServer(
  {
    name: 'ctxlint',
    version: VERSION,
  },
  { instructions: INSTRUCTIONS },
);

server.tool(
  'ctxlint_audit',
  'Audit AI agent context files (CLAUDE.md, AGENTS.md, etc.) in the project. Checks for stale references, invalid commands, redundant content, contradictions, frontmatter issues, and token waste. Scoped to context-file checks only; MCP-config and session-level checks are exposed as separate tools.',
  {
    projectPath: z
      .string()
      .optional()
      .describe('Path to the project root. Defaults to current working directory.'),
    checks: z
      .array(contextCheckEnum)
      .optional()
      .describe('Which context-file checks to run. Defaults to all.'),
  },
  {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async ({ projectPath, checks }) => {
    try {
      const root = validateProjectPath(projectPath);
      const activeChecks = checks?.length ? (checks as CheckName[]) : ALL_CHECKS;
      const config = safeLoadConfig(root);
      const result = await runAudit(root, activeChecks, {
        exclude: config?.exclude,
        ignoreRules: config?.ignoreRules,
      });
      return { content: [{ type: 'text' as const, text: auditText(result) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }],
        isError: true,
      };
    } finally {
      freeEncoder();
      resetGit();
      resetPathsCache();
      resetPackageJsonCache();
    }
  },
);

server.tool(
  'ctxlint_validate_path',
  'Check if a file path referenced in a context file actually exists in the project. Returns the file status and suggests corrections if the path is invalid.',
  {
    path: z.string().min(1, 'path must not be empty').describe('The file path to validate'),
    projectPath: z.string().optional().describe('Project root. Defaults to cwd.'),
  },
  {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async ({ path: filePath, projectPath }) => {
    try {
      validateFilePathInput(filePath);
      const root = validateProjectPath(projectPath);
      const resolved = resolveWithinRoot(filePath, root);

      const result: Record<string, unknown> = {
        path: filePath,
        exists: fileExists(resolved) || isDirectory(resolved),
      };

      if (!result.exists) {
        // The raw input may be absolute (resolveWithinRoot permits that),
        // which could never exact-match, so pass the root-relative resolved
        // form. relativeTo 'project': the default result is git repo-root-
        // relative, which carries a subdirectory root's prefix
        // (`pkg/src/new.ts`) and does not resolve against `root`.
        const rename = await findRenames(root, path.relative(root, resolved), {
          relativeTo: 'project',
        });
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
      resetPathsCache();
      resetPackageJsonCache();
    }
  },
);

server.tool(
  'ctxlint_token_report',
  'Get a token count breakdown for all context files in the project. Shows per-file and aggregate token usage, plus estimated waste from redundant content.',
  {
    projectPath: z.string().optional().describe('Project root. Defaults to cwd.'),
  },
  {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async ({ projectPath }) => {
    try {
      const root = validateProjectPath(projectPath);
      const discovered = await scanForContextFiles(root);
      const parsed = discovered.map((f) => parseContextFile(f));

      const files = parsed.map((f) => ({
        path: f.relativePath,
        tokens: f.totalTokens,
        lines: f.totalLines,
        isSymlink: f.isSymlink,
      }));

      // Same definition as an audit's summary.totalTokens: a symlinked alias
      // of another counted file (AGENTS.md -> CLAUDE.md) is counted once.
      const totalTokens = contextTokenTotal(
        parsed.map((f) => ({
          path: f.relativePath,
          tokens: f.totalTokens,
          isSymlink: f.isSymlink,
          symlinkTarget: f.symlinkTarget,
        })),
      );

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              { files, totalTokens, note: 'Token counts use GPT-4 cl100k_base tokenizer' },
              null,
              2,
            ),
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

server.tool(
  'ctxlint_fix',
  'Run the selected context-file checks and apply every auto-fix they emit, writing the context files in place. Today only the paths check emits fixes: a broken file path is rewritten to its git-rename target or a close fuzzy match. Returns a summary of what was fixed. Pass dryRun: true to preview what would be fixed without writing any files.',
  {
    projectPath: z
      .string()
      .optional()
      .describe('Path to the project root. Defaults to current working directory.'),
    checks: z
      .array(contextCheckEnum)
      .optional()
      .describe('Which context-file checks to run before fixing. Defaults to all.'),
    dryRun: z
      .boolean()
      .optional()
      .describe(
        'If true, simulate fixes and report what would change without writing any files. Returns accurate counts.',
      ),
  },
  {
    // ctxlint_fix writes to disk via applyFixes() → fs.writeFileSync, so it
    // must advertise destructiveHint: true. Hosts (Claude Code, Cursor, etc.)
    // use this to decide whether to require user confirmation before the call.
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  async ({ projectPath, checks, dryRun }) => {
    try {
      const root = validateProjectPath(projectPath);
      const activeChecks = checks?.length ? (checks as CheckName[]) : ALL_CHECKS;
      const config = safeLoadConfig(root);
      const result = await runAudit(root, activeChecks, {
        exclude: config?.exclude,
        ignoreRules: config?.ignoreRules,
      });
      const fixSummary = applyFixes(result, { quiet: true, dryRun: dryRun ?? false });

      // applyFixes wrote to disk, so the pre-fix summary no longer describes
      // the project. Re-audit before reporting `remainingIssues` -- returning
      // the pre-fix counts (which include every issue just fixed) tells the
      // host agent the fixes did nothing. Skip the second audit when nothing
      // was written: the pre-fix summary is still accurate then.
      // Also skip the re-audit in dry-run mode: no files were written, so
      // remainingIssues reflects the pre-fix (unfixed) state intentionally.
      let remaining = result.summary;
      if (!dryRun && fixSummary.totalFixes > 0) {
        resetGit();
        resetPathsCache();
        resetPackageJsonCache();
        const postFix = await runAudit(root, activeChecks, {
          exclude: config?.exclude,
          ignoreRules: config?.ignoreRules,
        });
        remaining = postFix.summary;
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                totalFixes: fixSummary.totalFixes,
                filesModified: fixSummary.filesModified,
                remainingIssues: remaining,
                ...(dryRun ? { dryRun: true } : {}),
              },
              null,
              2,
            ),
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
      resetGit();
      resetPathsCache();
      resetPackageJsonCache();
    }
  },
);

server.tool(
  'ctxlint_mcp_audit',
  'Lint MCP server configuration files in a project. Checks for schema errors, hardcoded secrets, deprecated transports, wrong env var syntax, URL issues, and cross-client inconsistencies.',
  {
    projectPath: z
      .string()
      .optional()
      .describe('Path to the project root. Defaults to current working directory.'),
    checks: z
      .array(mcpCheckEnum)
      .optional()
      .describe('Specific MCP checks to run (default: all mcp-* checks).'),
    includeGlobal: z.boolean().optional().describe('Also scan global/user-level MCP configs.'),
  },
  {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    // includeGlobal reads the user's home-directory MCP configs, outside the
    // project root -- the same reason the session and skill audits are open-world.
    openWorldHint: true,
  },
  async ({ projectPath, checks, includeGlobal }) => {
    try {
      const root = validateProjectPath(projectPath);
      const activeChecks = checks?.length ? (checks as CheckName[]) : ALL_MCP_CHECKS;
      const config = safeLoadConfig(root);
      const result = await runAudit(root, activeChecks, {
        mcp: true,
        mcpOnly: true,
        mcpGlobal: includeGlobal || false,
        // Config `exclude` drops project MCP configs too.
        exclude: config?.exclude,
        ignoreRules: config?.ignoreRules,
      });
      return { content: [{ type: 'text' as const, text: auditText(result) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }],
        isError: true,
      };
    } finally {
      freeEncoder();
      resetGit();
      resetPathsCache();
      resetPackageJsonCache();
    }
  },
);

server.tool(
  'ctxlint_session_audit',
  'Audit AI agent session data for cross-project consistency and session hazards. Checks for missing GitHub secrets, diverged config files and missing workflows across sibling repositories; stale, duplicate or overflowing memory entries; command loops; and, from Claude Code transcripts, shared temp paths, gates claimed clean after failing, edits piling up on the default branch, unresolvable commit SHAs in memory, and large whole-file Reads re-sent as context on later turns.',
  {
    projectPath: z
      .string()
      .optional()
      .describe('Path to the project root. Defaults to current working directory.'),
    checks: z
      .array(sessionCheckEnum)
      .optional()
      .describe('Specific session checks to run (default: all session-* checks).'),
  },
  {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  async ({ projectPath, checks }) => {
    try {
      const root = validateProjectPath(projectPath);
      const activeChecks = checks?.length ? (checks as CheckName[]) : ALL_SESSION_CHECKS;
      const config = safeLoadConfig(root);
      const result = await runAudit(root, activeChecks, {
        session: true,
        sessionOnly: true,
        ignoreRules: config?.ignoreRules,
      });
      return { content: [{ type: 'text' as const, text: auditText(result) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }],
        isError: true,
      };
    } finally {
      freeEncoder();
      resetGit();
      resetPathsCache();
      resetPackageJsonCache();
      // The transcript read is memoized; without this, every later session
      // audit in this long-lived process would see the transcripts as they
      // stood at the first call.
      clearTranscriptCache();
    }
  },
);

server.tool(
  'ctxlint_skill_audit',
  'Audit agent skill and subagent definitions (~/.claude/skills/*/SKILL.md, ~/.claude/agents/*.md). Checks for frontmatter problems, broken file references, trigger collisions, orphaned skill directories, and dead tool restrictions.',
  {
    projectPath: z
      .string()
      .optional()
      .describe('Path to the project root. Defaults to current working directory.'),
    checks: z
      .array(skillCheckEnum)
      .optional()
      .describe('Specific skill checks to run (default: all skill-* checks).'),
  },
  {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    // Like ctxlint_session_audit, this reads outside the project root
    // (the user-global ~/.claude tree), hence open-world.
    openWorldHint: true,
  },
  async ({ projectPath, checks }) => {
    try {
      const root = validateProjectPath(projectPath);
      const activeChecks = checks?.length ? (checks as CheckName[]) : ALL_SKILL_CHECKS;
      const config = safeLoadConfig(root);
      const result = await runAudit(root, activeChecks, {
        skills: true,
        skillsOnly: true,
        ignoreRules: config?.ignoreRules,
      });
      return { content: [{ type: 'text' as const, text: auditText(result) }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }],
        isError: true,
      };
    } finally {
      freeEncoder();
      resetGit();
      resetPathsCache();
      resetPackageJsonCache();
    }
  },
);

export { server };

/**
 * Connect the server to a stdio transport. Pulled out of module top-level
 * so importing this file (e.g. for tools/list inspection in tests) does
 * NOT unconditionally hijack stdio.
 */
export async function startServer(): Promise<void> {
  // Keep the tiktoken encoder alive for the server's lifetime to avoid
  // re-creating the ~4MB WASM instance on every request.
  keepEncoderAlive(true);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
