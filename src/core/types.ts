export type Severity = 'error' | 'warning' | 'info';

// Label audit.ts stamps onto the synthetic session-audit FileResult bucket.
// Exported so reporter.ts can route on the SAME literal it was authored
// against, rather than a substring grep that drifts silently when the label
// is reskinned.
export const SESSION_AUDIT_LABEL = '~/.claude/ (session audit)';

// Tighter substring the reporter uses for path-based classification. A
// reskinned label (different leading path, different trailing punctuation)
// keeps routing correctly as long as it contains this marker; that's the
// decoupling the const is here to provide.
export const SESSION_AUDIT_PATH_MARKER = '(session audit)';

// Label for the synthetic agent-skill audit bucket (fourth pillar). Same
// shape as SESSION_AUDIT_LABEL: findings live outside the project dir
// (~/.claude/skills, ~/.claude/agents).
export const SKILL_AUDIT_LABEL = '~/.claude/ (skill audit)';

// Tighter substring the reporter uses for path-based classification of the
// skill bucket (mirrors SESSION_AUDIT_PATH_MARKER). Lives next to
// SKILL_AUDIT_LABEL so a reskin of the label can't silently desync the
// reporter's routing.
export const SKILL_AUDIT_PATH_MARKER = '(skill audit)';

// --- Session check types ---

export type SessionCheckName =
  | 'session-missing-secret'
  | 'session-diverged-file'
  | 'session-missing-workflow'
  | 'session-stale-memory'
  | 'session-duplicate-memory'
  | 'session-loop-detection'
  | 'session-memory-index-overflow';

// --- Agent-skill check types (fourth pillar) ---

export type SkillCheckName =
  | 'skill-frontmatter'
  | 'skill-broken-ref'
  | 'skill-trigger-collision'
  | 'skill-orphaned'
  | 'skill-dead-tool-restriction';

/** A discovered skill (SKILL.md) or agent (.md) definition under ~/.claude. */
export interface SkillFile {
  /** Absolute path of the SKILL.md / agent .md file. */
  filePath: string;
  /** Display path, e.g. ~/.claude/skills/foo/SKILL.md. */
  displayPath: string;
  /** 'skill' (skills/<name>/SKILL.md) or 'agent' (agents/<name>.md). */
  kind: 'skill' | 'agent';
  /** Logical name derived from the directory (skill) or filename (agent). */
  name: string;
  content: string;
}

export interface SkillContext {
  /** Skill + agent definition files found. */
  files: SkillFile[];
  /** Skill directories that contain no SKILL.md (orphaned). */
  orphanedSkillDirs: { name: string; displayPath: string }[];
}

export type AgentProvider =
  | 'claude-code'
  | 'codex-cli'
  | 'aider'
  | 'vibe-cli'
  | 'amazon-q'
  | 'goose'
  | 'continue'
  | 'windsurf';

export interface HistoryEntry {
  display: string;
  timestamp: number;
  project: string;
  sessionId: string;
  provider: AgentProvider;
}

export interface MemoryEntry {
  filePath: string;
  projectDir: string;
  name?: string;
  description?: string;
  type?: string;
  content: string;
  referencedPaths: string[];
}

export interface SiblingRepo {
  path: string;
  name: string;
  gitOrg?: string;
  gitRemoteUrl?: string;
}

export interface SessionContext {
  history: HistoryEntry[];
  memories: MemoryEntry[];
  siblings: SiblingRepo[];
  currentProject: string;
  providers: AgentProvider[];
}

// --- MCP config types ---

export type McpCheckName =
  | 'mcp-schema'
  | 'mcp-security'
  | 'mcp-commands'
  | 'mcp-deprecated'
  | 'mcp-env'
  | 'mcp-urls'
  | 'mcp-consistency'
  | 'mcp-redundancy';

export type CheckName =
  | 'paths'
  | 'commands'
  | 'staleness'
  | 'tokens'
  | 'tier-tokens'
  | 'redundancy'
  | 'contradictions'
  | 'frontmatter'
  | 'ci-coverage'
  | 'ci-secrets'
  | 'content-secrets'
  | 'hook-coverage'
  | McpCheckName
  | SessionCheckName
  | SkillCheckName;

// Clients whose MCP config is a repo-discoverable file. Cline is intentionally
// absent: its MCP server list lives in VS Code globalStorage
// (cline_mcp_settings.json), not a file the scanner surfaces, so detectClient
// can never classify one. Cline's `.clinerules` context files are handled by
// the context pillar, not here.
export type McpClient =
  | 'claude-code'
  | 'claude-desktop'
  | 'vscode'
  | 'cursor'
  | 'windsurf'
  | 'amazonq'
  | 'continue';

export type McpTransport = 'stdio' | 'http' | 'sse' | 'unknown';

export type McpConfigScope = 'project' | 'user' | 'global';

export interface McpServerEntry {
  name: string;
  transport: McpTransport;
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // http/sse
  url?: string;
  headers?: Record<string, string>;
  // client-specific
  disabled?: boolean;
  autoApprove?: string[];
  timeout?: number;
  oauth?: Record<string, unknown>;
  headersHelper?: string;
  // line number in the JSON file where this server entry starts
  line: number;
  // raw parsed object for access to unknown fields
  raw: Record<string, unknown>;
}

export interface ParsedMcpConfig {
  filePath: string;
  relativePath: string;
  client: McpClient;
  scope: McpConfigScope;
  expectedRootKey: 'mcpServers' | 'servers';
  actualRootKey: string | null;
  servers: McpServerEntry[];
  parseErrors: string[];
  content: string;
  isGitTracked: boolean;
  /**
   * True when git-tracked status could not be determined (git unavailable or
   * failing -- NOT merely untracked). isGitTracked is false in that case, so
   * the git-gated secret rules skip; this flag lets mcp-security surface that
   * the gate was skipped blind. Optional so test fixtures stay unchanged.
   */
  gitTrackedUnknown?: boolean;
}

export interface Section {
  title: string;
  startLine: number;
  endLine: number;
  level: number;
}

export interface PathReference {
  value: string;
  line: number;
  column: number;
  section?: string;
}

export interface CommandReference {
  value: string;
  line: number;
  column: number;
  section?: string;
}

export interface ParsedContextFile {
  filePath: string;
  relativePath: string;
  isSymlink: boolean;
  symlinkTarget?: string;
  totalTokens: number;
  totalLines: number;
  content: string;
  sections: Section[];
  references: {
    paths: PathReference[];
    commands: CommandReference[];
  };
}

export interface FixAction {
  file: string;
  line: number;
  oldText: string;
  newText: string;
  /**
   * 1-indexed column where `oldText` starts on `line`. When set, the fixer
   * claims exactly that occurrence (after verifying the line still reads
   * `oldText` there) instead of replaceAll-matching every occurrence -- this
   * stops a stale value that is a substring of a KEPT value on the same line
   * (e.g. `src/old.ts` inside `src/old.ts.bak`) from being rewritten too.
   * Producers whose `oldText` is unambiguous on its line may omit it; the
   * fixer then falls back to whole-line replaceAll.
   */
  column?: number;
}

export interface LintIssue {
  severity: Severity;
  check: CheckName;
  ruleId?: string;
  line: number;
  message: string;
  suggestion?: string;
  detail?: string;
  fix?: FixAction;
  /**
   * Optional structured estimate of tokens this finding wastes. When set, the
   * audit summary sums these directly instead of scraping `~N tokens` out of
   * `suggestion`. Currently emitted by the redundancy check.
   */
  wastedTokens?: number;
  /**
   * Optional structured list of the paths this finding is about. When set,
   * ignore-rule path-pattern matching reads these directly instead of scraping
   * them back out of `message`. Currently emitted by the stale-memory check.
   */
  affectedPaths?: string[];
}

export interface FileResult {
  path: string;
  isSymlink: boolean;
  symlinkTarget?: string;
  tokens: number;
  lines: number;
  issues: LintIssue[];
}

export interface IgnoreRuleSummary {
  check: CheckName;
  match?: string;
  pathPattern?: string;
  reason?: string;
}

export interface IgnoreReport {
  dropped: number;
  unusedRules: IgnoreRuleSummary[];
  rulesMissingReason: IgnoreRuleSummary[];
}

export interface LintResult {
  version: string;
  scannedAt: string;
  projectRoot: string;
  files: FileResult[];
  summary: {
    errors: number;
    warnings: number;
    info: number;
    totalTokens: number;
    estimatedWaste: number;
  };
  _meta?: {
    ignoreReport?: IgnoreReport;
  };
}

export interface LintOptions {
  projectPath: string;
  checks: CheckName[];
  strict: boolean;
  format: 'text' | 'json' | 'sarif';
  verbose: boolean;
  fix: boolean;
  ignore: CheckName[];
  tokensOnly: boolean;
  quiet: boolean;
  configPath?: string;
  depth: number;
  mcp: boolean;
  mcpOnly: boolean;
  mcpGlobal: boolean;
  session: boolean;
  sessionOnly: boolean;
  skills: boolean;
  skillsOnly: boolean;
  hooksGlobal: boolean;
  /** When true, .ctxlintignore is not loaded. Use --no-ignore-file to see all findings. */
  noIgnoreFile?: boolean;
}
