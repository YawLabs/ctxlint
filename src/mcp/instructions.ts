/**
 * The MCP `instructions` string sent in the initialize result.
 *
 * Routing guidance only: which tool covers which file class, which one
 * writes, and which one is the cheap probe. Per-tool detail stays in each
 * tool's description. Yaw MCP renders a server's instructions once per
 * namespace per session and cuts them at 2000 bytes after sanitizing, so this
 * is plain ASCII and well under that; src/mcp/__tests__/instructions.test.ts
 * pins both.
 */
export const INSTRUCTIONS = [
  'ctxlint lints the files that steer AI coding agents. Pick the tool by file class:',
  '- ctxlint_audit: context files (CLAUDE.md, AGENTS.md, .cursorrules, copilot-instructions and similar): broken paths, wrong commands, contradictions, token waste.',
  "- ctxlint_mcp_audit: MCP server configs (.mcp.json and other clients' configs); includeGlobal adds user-level ones.",
  '- ctxlint_session_audit: agent session data: memory entries, Claude Code transcripts, consistency across sibling repos.',
  '- ctxlint_skill_audit: skill and subagent definitions (~/.claude/skills/*/SKILL.md, ~/.claude/agents/*.md).',
  '- ctxlint_validate_path: check one referenced path, with a git-rename suggestion when it moved.',
  '- ctxlint_token_report: the cheap probe. Token counts per context file, no checks run; use it to size a project before a full audit.',
  '- ctxlint_fix: WRITES context files to repair broken paths unless dryRun is true. Preview with dryRun first.',
  'Audit results are JSON with summary first, then per-file issues. Every tool takes projectPath (default: the server cwd).',
].join('\n');
