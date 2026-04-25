import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { scanForContextFiles } from '../core/scanner.js';
import { parseContextFile } from '../core/parser.js';
import {
  runAudit,
  ALL_CHECKS,
  ALL_MCP_CHECKS,
  ALL_MCPH_CHECKS,
  ALL_SESSION_CHECKS,
} from '../core/audit.js';
import { applyFixes } from '../core/fixer.js';
import { fileExists, isDirectory, resetPackageJsonCache } from '../utils/fs.js';
import { findRenames } from '../utils/git.js';
import { freeEncoder, keepEncoderAlive } from '../utils/tokens.js';
import { resetGit } from '../utils/git.js';
import { resetPathsCache } from '../core/checks/paths.js';
import type { CheckName, McpCheckName, MchpCheckName, SessionCheckName } from '../core/types.js';
import * as path from 'node:path';
import { VERSION } from '../version.js';

// Per-tool enums, not a single union. Previously every tool accepted every
// check name — so calling `ctxlint_audit` with `checks: ['mcp-schema']`
// would validate but silently do nothing (the audit only scans context
// files, not MCP configs). Each tool now only accepts check names for the
// domain it actually runs.
const contextCheckEnum = z.enum(ALL_CHECKS as [CheckName, ...CheckName[]]);
const mcpCheckEnum = z.enum(ALL_MCP_CHECKS as [McpCheckName, ...McpCheckName[]]);
const mcphCheckEnum = z.enum(ALL_MCPH_CHECKS as [MchpCheckName, ...MchpCheckName[]]);
const sessionCheckEnum = z.enum(ALL_SESSION_CHECKS as [SessionCheckName, ...SessionCheckName[]]);

// Shell metacharacters + control chars that have no legitimate place in a
// filesystem path. Rejecting these at the tool boundary does two things:
// (1) defense-in-depth — ctxlint uses Node fs APIs (no shell), so there's
// no actual injection surface, but blocking obviously hostile input is
// cheap; (2) stops false-positive signals from scanners (mcp-compliance's
// injection tests look for reflected payloads in output) by erroring
// before the input gets resolved and echoed back.
const PATH_DISALLOWED = /[\n\r\t;`|]|\$\(|\$\{/;

function validateProjectPath(rawPath: string | undefined): string {
  if (!rawPath) return process.cwd();
  if (PATH_DISALLOWED.test(rawPath)) {
    throw new Error('projectPath contains disallowed characters');
  }
  const resolved = path.resolve(rawPath);
  if (!isDirectory(resolved)) {
    throw new Error('projectPath is not an existing directory');
  }
  return resolved;
}

function validateFilePathInput(rawPath: string): void {
  if (PATH_DISALLOWED.test(rawPath)) {
    throw new Error('path contains disallowed characters');
  }
}

const server = new McpServer({
  name: 'ctxlint',
  version: VERSION,
});

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
      resetPathsCache();
      resetPackageJsonCache();
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

      const totalTokens = files.reduce((sum, f) => sum + f.tokens, 0);

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
  'Run the linter with --fix mode to auto-correct broken file paths in context files using git history and fuzzy matching. Returns a summary of what was fixed.',
  {
    projectPath: z
      .string()
      .optional()
      .describe('Path to the project root. Defaults to current working directory.'),
    checks: z
      .array(contextCheckEnum)
      .optional()
      .describe('Which context-file checks to run before fixing. Defaults to all.'),
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
  async ({ projectPath, checks }) => {
    try {
      const root = validateProjectPath(projectPath);
      const activeChecks = checks?.length ? (checks as CheckName[]) : ALL_CHECKS;
      const result = await runAudit(root, activeChecks);
      const fixSummary = applyFixes(result, { quiet: true });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                totalFixes: fixSummary.totalFixes,
                filesModified: fixSummary.filesModified,
                remainingIssues: result.summary,
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
    openWorldHint: false,
  },
  async ({ projectPath, checks, includeGlobal }) => {
    try {
      const root = validateProjectPath(projectPath);
      const activeChecks = checks?.length ? (checks as CheckName[]) : ALL_MCP_CHECKS;
      const result = await runAudit(root, activeChecks, {
        mcp: true,
        mcpOnly: true,
        mcpGlobal: includeGlobal || false,
      });
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
      resetPathsCache();
      resetPackageJsonCache();
    }
  },
);

server.tool(
  'ctxlint_mcph_audit',
  'Lint .mcph.json (the @yawlabs/mcph CLI config) files. Checks for PAT (mcp_pat_*) leakage in git-tracked project-scope files, environment-variable posture, plaintext HTTP apiBase to public hosts, schema drift, allow/deny list conflicts and duplicates, and machine-local override files not covered by .gitignore. Distinct from ctxlint_mcp_audit, which lints client-side .mcp.json server lists.',
  {
    projectPath: z
      .string()
      .optional()
      .describe('Path to the project root. Defaults to current working directory.'),
    checks: z
      .array(mcphCheckEnum)
      .optional()
      .describe('Specific mcph checks to run (default: all mcph-* checks).'),
    includeGlobal: z.boolean().optional().describe('Also scan ~/.mcph.json (user-global config).'),
    strictEnvToken: z
      .boolean()
      .optional()
      .describe(
        'Upgrade mcph-config/prefer-env-token from warning to error (env-var-only posture).',
      ),
  },
  {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async ({ projectPath, checks, includeGlobal, strictEnvToken }) => {
    try {
      const root = validateProjectPath(projectPath);
      const activeChecks = checks?.length ? (checks as CheckName[]) : ALL_MCPH_CHECKS;
      const result = await runAudit(root, activeChecks, {
        mcph: true,
        mcphOnly: true,
        mcphGlobal: includeGlobal || false,
        mcphStrictEnvToken: strictEnvToken || false,
      });
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
      resetPathsCache();
      resetPackageJsonCache();
    }
  },
);

server.tool(
  'ctxlint_session_audit',
  'Audit AI agent session data for cross-project consistency. Checks for missing GitHub secrets, diverged config files, missing workflows, stale memory entries, and duplicate memories across sibling repositories.',
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
      const result = await runAudit(root, activeChecks, {
        session: true,
        sessionOnly: true,
      });
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
      resetPathsCache();
      resetPackageJsonCache();
    }
  },
);

// Keep the tiktoken encoder alive for the server's lifetime to avoid
// re-creating the ~4MB WASM instance on every request.
keepEncoderAlive(true);

const transport = new StdioServerTransport();
await server.connect(transport);
