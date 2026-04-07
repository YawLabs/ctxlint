export type Severity = 'error' | 'warning' | 'info';

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
  | 'redundancy'
  | 'contradictions'
  | 'frontmatter'
  | McpCheckName;

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
}
