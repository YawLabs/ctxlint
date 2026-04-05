export type Severity = 'error' | 'warning' | 'info';

export type CheckName = 'paths' | 'commands' | 'staleness' | 'tokens' | 'redundancy';

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
  format: 'text' | 'json';
  verbose: boolean;
  fix: boolean;
  ignore: CheckName[];
  tokensOnly: boolean;
}
