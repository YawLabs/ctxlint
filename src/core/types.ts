export type Severity = 'error' | 'warning' | 'info';

// --- Session check types ---

export type SessionCheckName =
  | 'session-missing-secret'
  | 'session-diverged-file'
  | 'session-missing-workflow'
  | 'session-stale-memory'
  | 'session-duplicate-memory'
  | 'session-loop-detection';

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
  | McpCheckName
  | SessionCheckName;

export type McpClient =
  | 'claude-code'
  | 'claude-desktop'
  | 'vscode'
  | 'cursor'
  | 'windsurf'
  | 'cline'
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
}

export interface FileResult {
  path: string;
  isSymlink: boolean;
  symlinkTarget?: string;
  tokens: number;
  lines: number;
  issues: LintIssue[];
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
}
