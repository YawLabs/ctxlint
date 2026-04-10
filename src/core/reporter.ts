import chalk from 'chalk';
import type { LintResult, LintIssue } from './types.js';

export function formatText(result: LintResult, verbose: boolean = false): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(chalk.bold(`ctxlint v${result.version}`));
  lines.push('');
  lines.push(`Scanning ${result.projectRoot}...`);
  lines.push('');

  // Split files into context files vs MCP configs
  const isMcpFile = (f: { issues: LintIssue[] }) =>
    f.issues.some((i) => i.check.startsWith('mcp-'));
  const contextFiles = result.files.filter((f) => !isMcpFile(f));
  const mcpFiles = result.files.filter((f) => isMcpFile(f));

  // Summary of found files
  const totalTokens = result.summary.totalTokens;
  if (contextFiles.length > 0) {
    lines.push(
      `Found ${contextFiles.length} context file${contextFiles.length !== 1 ? 's' : ''} (${totalTokens.toLocaleString()} tokens total)`,
    );
    for (const file of contextFiles) {
      let desc = `  ${file.path} (${file.tokens.toLocaleString()} tokens, ${file.lines} lines)`;
      if (file.isSymlink && file.symlinkTarget) {
        desc = `  ${file.path} ${chalk.dim(`\u2192 ${file.symlinkTarget} (symlink)`)}`;
      }
      lines.push(desc);
    }
  }
  if (mcpFiles.length > 0) {
    if (contextFiles.length > 0) lines.push('');
    lines.push(`Found ${mcpFiles.length} MCP config${mcpFiles.length !== 1 ? 's' : ''}`);
    for (const file of mcpFiles) {
      lines.push(`  ${file.path}`);
    }
  }
  if (contextFiles.length === 0 && mcpFiles.length === 0) {
    lines.push(`Found ${result.files.length} file${result.files.length !== 1 ? 's' : ''}`);
  }

  lines.push('');

  // Per-file issues — grouped by type
  const renderFileGroup = (files: typeof result.files) => {
    for (const file of files) {
      const fileIssues = file.issues;
      if (fileIssues.length === 0 && !verbose) continue;

      lines.push(chalk.underline(file.path));

      if (fileIssues.length === 0) {
        lines.push(chalk.green('  \u2713 All checks passed'));
      } else {
        for (const issue of fileIssues) {
          lines.push(formatIssue(issue));
        }
      }

      lines.push('');
    }
  };

  if (contextFiles.length > 0 && mcpFiles.length > 0) {
    // Show grouped headers when both types present
    const contextWithIssues = contextFiles.filter((f) => f.issues.length > 0 || verbose);
    const mcpWithIssues = mcpFiles.filter((f) => f.issues.length > 0 || verbose);

    if (contextWithIssues.length > 0) {
      lines.push(chalk.bold('Context Files'));
      renderFileGroup(contextFiles);
    }
    if (mcpWithIssues.length > 0) {
      lines.push(chalk.bold('MCP Configs'));
      renderFileGroup(mcpFiles);
    }
  } else {
    renderFileGroup(result.files);
  }

  // Summary
  const { errors, warnings, info } = result.summary;
  const parts: string[] = [];
  if (errors > 0) parts.push(chalk.red(`${errors} error${errors !== 1 ? 's' : ''}`));
  if (warnings > 0) parts.push(chalk.yellow(`${warnings} warning${warnings !== 1 ? 's' : ''}`));
  if (info > 0) parts.push(chalk.blue(`${info} info`));

  if (parts.length > 0) {
    lines.push(`Summary: ${parts.join(', ')}`);
  } else {
    lines.push(chalk.green('No issues found!'));
  }

  lines.push(`  Token usage: ${totalTokens.toLocaleString()} tokens per agent session`);

  if (result.summary.estimatedWaste > 0) {
    lines.push(`  Estimated waste: ~${result.summary.estimatedWaste} tokens (redundant content)`);
  }

  lines.push('');

  return lines.join('\n');
}

export function formatJson(result: LintResult): string {
  return JSON.stringify(result, null, 2);
}

export function formatTokenReport(result: LintResult): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(chalk.bold('Token Usage Report'));
  lines.push(
    chalk.dim('  (counts use GPT-4 cl100k_base tokenizer — Claude counts may vary slightly)'),
  );
  lines.push('');

  const maxPathLen = Math.max(...result.files.map((f) => f.path.length), 4);

  lines.push(
    `  ${chalk.dim('File'.padEnd(maxPathLen))}  ${chalk.dim('Tokens'.padStart(8))}  ${chalk.dim('Lines'.padStart(6))}`,
  );
  lines.push(`  ${'─'.repeat(maxPathLen)}  ${'─'.repeat(8)}  ${'─'.repeat(6)}`);

  for (const file of result.files) {
    const tokenStr = file.tokens.toLocaleString().padStart(8);
    const lineStr = file.lines.toString().padStart(6);
    lines.push(`  ${file.path.padEnd(maxPathLen)}  ${tokenStr}  ${lineStr}`);
  }

  lines.push(`  ${'─'.repeat(maxPathLen)}  ${'─'.repeat(8)}  ${'─'.repeat(6)}`);
  lines.push(
    `  ${'Total'.padEnd(maxPathLen)}  ${result.summary.totalTokens.toLocaleString().padStart(8)}`,
  );

  if (result.summary.estimatedWaste > 0) {
    lines.push('');
    lines.push(
      chalk.yellow(
        `  ~${result.summary.estimatedWaste} tokens estimated waste from redundant content`,
      ),
    );
  }

  lines.push('');

  return lines.join('\n');
}

/**
 * Formats results as SARIF v2.1.0 for GitHub Code Scanning and other SARIF consumers.
 * https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html
 */
export function formatSarif(result: LintResult): string {
  const severityToLevel: Record<string, string> = {
    error: 'error',
    warning: 'warning',
    info: 'note',
  };

  const results: SarifResult[] = [];

  for (const file of result.files) {
    for (const issue of file.issues) {
      const sarifResult: SarifResult = {
        ruleId: `ctxlint/${issue.check}`,
        level: severityToLevel[issue.severity] || 'note',
        message: {
          text: issue.message + (issue.suggestion ? ` (${issue.suggestion})` : ''),
        },
        locations: [
          {
            physicalLocation: {
              artifactLocation: {
                uri: file.path,
                uriBaseId: '%SRCROOT%',
              },
              region: {
                startLine: Math.max(issue.line, 1),
              },
            },
          },
        ],
      };

      if (issue.detail) {
        sarifResult.message.text += `\n${issue.detail}`;
      }

      results.push(sarifResult);
    }
  }

  const sarif: SarifLog = {
    version: '2.1.0',
    $schema:
      'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json',
    runs: [
      {
        tool: {
          driver: {
            name: 'ctxlint',
            version: result.version,
            informationUri: 'https://github.com/yawlabs/ctxlint',
            rules: buildRuleDescriptors(),
          },
        },
        results,
      },
    ],
  };

  return JSON.stringify(sarif, null, 2);
}

function buildRuleDescriptors(): SarifRule[] {
  return [
    {
      id: 'ctxlint/paths',
      shortDescription: { text: 'File path does not exist in project' },
      helpUri: 'https://github.com/yawlabs/ctxlint#what-it-checks',
    },
    {
      id: 'ctxlint/commands',
      shortDescription: { text: 'Command does not match project scripts' },
      helpUri: 'https://github.com/yawlabs/ctxlint#what-it-checks',
    },
    {
      id: 'ctxlint/staleness',
      shortDescription: { text: 'Context file is stale relative to referenced code' },
      helpUri: 'https://github.com/yawlabs/ctxlint#what-it-checks',
    },
    {
      id: 'ctxlint/tokens',
      shortDescription: { text: 'Context file token usage' },
      helpUri: 'https://github.com/yawlabs/ctxlint#what-it-checks',
    },
    {
      id: 'ctxlint/redundancy',
      shortDescription: { text: 'Content is redundant or inferable' },
      helpUri: 'https://github.com/yawlabs/ctxlint#what-it-checks',
    },
    {
      id: 'ctxlint/contradictions',
      shortDescription: { text: 'Conflicting directives across context files' },
      helpUri: 'https://github.com/yawlabs/ctxlint#what-it-checks',
    },
    {
      id: 'ctxlint/frontmatter',
      shortDescription: { text: 'Invalid or missing frontmatter' },
      helpUri: 'https://github.com/yawlabs/ctxlint#what-it-checks',
    },
    {
      id: 'ctxlint/ci-coverage',
      shortDescription: { text: 'CI release workflow not documented in context files' },
      helpUri: 'https://github.com/yawlabs/ctxlint#what-it-checks',
    },
    {
      id: 'ctxlint/ci-secrets',
      shortDescription: { text: 'CI secret not documented in context files' },
      helpUri: 'https://github.com/yawlabs/ctxlint#what-it-checks',
    },
    {
      id: 'ctxlint/mcp-schema',
      shortDescription: { text: 'MCP config structural validation error' },
      helpUri: 'https://github.com/yawlabs/ctxlint#mcp-config-linting',
    },
    {
      id: 'ctxlint/mcp-security',
      shortDescription: { text: 'Hardcoded secret in MCP config' },
      helpUri: 'https://github.com/yawlabs/ctxlint#mcp-config-linting',
    },
    {
      id: 'ctxlint/mcp-commands',
      shortDescription: { text: 'MCP stdio command validation issue' },
      helpUri: 'https://github.com/yawlabs/ctxlint#mcp-config-linting',
    },
    {
      id: 'ctxlint/mcp-deprecated',
      shortDescription: { text: 'Deprecated MCP transport or pattern' },
      helpUri: 'https://github.com/yawlabs/ctxlint#mcp-config-linting',
    },
    {
      id: 'ctxlint/mcp-env',
      shortDescription: { text: 'MCP environment variable syntax issue' },
      helpUri: 'https://github.com/yawlabs/ctxlint#mcp-config-linting',
    },
    {
      id: 'ctxlint/mcp-urls',
      shortDescription: { text: 'MCP URL validation issue' },
      helpUri: 'https://github.com/yawlabs/ctxlint#mcp-config-linting',
    },
    {
      id: 'ctxlint/mcp-consistency',
      shortDescription: { text: 'MCP config inconsistency across clients' },
      helpUri: 'https://github.com/yawlabs/ctxlint#mcp-config-linting',
    },
    {
      id: 'ctxlint/mcp-redundancy',
      shortDescription: { text: 'Redundant MCP config entry' },
      helpUri: 'https://github.com/yawlabs/ctxlint#mcp-config-linting',
    },
    {
      id: 'ctxlint/session-missing-secret',
      shortDescription: { text: 'GitHub secret set on sibling repos but missing here' },
      helpUri: 'https://github.com/yawlabs/ctxlint#what-it-checks',
    },
    {
      id: 'ctxlint/session-diverged-file',
      shortDescription: { text: 'Canonical file has diverged from sibling repos' },
      helpUri: 'https://github.com/yawlabs/ctxlint#what-it-checks',
    },
    {
      id: 'ctxlint/session-missing-workflow',
      shortDescription: { text: 'GitHub Actions workflow present in siblings but missing here' },
      helpUri: 'https://github.com/yawlabs/ctxlint#what-it-checks',
    },
    {
      id: 'ctxlint/session-stale-memory',
      shortDescription: { text: 'Memory file references paths that no longer exist' },
      helpUri: 'https://github.com/yawlabs/ctxlint#what-it-checks',
    },
    {
      id: 'ctxlint/session-duplicate-memory',
      shortDescription: { text: 'Near-duplicate memory entries across projects' },
      helpUri: 'https://github.com/yawlabs/ctxlint#what-it-checks',
    },
    {
      id: 'ctxlint/session-loop-detection',
      shortDescription: { text: 'Agent looping pattern detected in session history' },
      helpUri: 'https://github.com/yawlabs/ctxlint#what-it-checks',
    },
  ];
}

// SARIF type definitions (minimal, for output only)
interface SarifLog {
  version: string;
  $schema: string;
  runs: SarifRun[];
}

interface SarifRun {
  tool: { driver: SarifDriver };
  results: SarifResult[];
}

interface SarifDriver {
  name: string;
  version: string;
  informationUri: string;
  rules: SarifRule[];
}

interface SarifRule {
  id: string;
  shortDescription: { text: string };
  helpUri: string;
}

interface SarifResult {
  ruleId: string;
  level: string;
  message: { text: string };
  locations: SarifLocation[];
}

interface SarifLocation {
  physicalLocation: {
    artifactLocation: { uri: string; uriBaseId: string };
    region: { startLine: number };
  };
}

function formatIssue(issue: LintIssue): string {
  const icon =
    issue.severity === 'error'
      ? chalk.red('\u2717')
      : issue.severity === 'warning'
        ? chalk.yellow('\u26A0')
        : chalk.blue('\u2139');

  const lineRef = issue.line > 0 ? `Line ${issue.line}: ` : '';
  let line = `  ${icon} ${lineRef}${issue.message}`;

  if (issue.suggestion) {
    line += `\n    ${chalk.dim('\u2192')} ${chalk.dim(issue.suggestion)}`;
  }
  if (issue.detail) {
    line += `\n    ${chalk.dim(issue.detail)}`;
  }

  return line;
}
