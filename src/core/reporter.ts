import chalk from 'chalk';
import type { FileResult, LintResult, LintIssue } from './types.js';

type FileGroup = 'context' | 'mcp' | 'mcph' | 'session';

/**
 * Classify a result row into one of the four output families. Issue-prefix is
 * the strongest signal because audit.ts dispatches checks per-domain (one
 * file's issues are always from a single family). Path is a fallback for
 * empty-issue rows surfaced in --verbose mode.
 *
 * Note on the prefix order: `mcph-` shares the first three characters with
 * `mcp-` but the fourth character (`h` vs `-`) makes them distinct prefixes.
 * Test for `mcph-` BEFORE `mcp-` so a future loosening of either side can't
 * silently route mcph rows into the MCP bucket.
 */
function classifyFile(f: FileResult): FileGroup {
  // Synthetic cross-file buckets (audit.ts emits these with these exact paths).
  if (f.path === '(mcp)') return 'mcp';
  if (f.path.includes('session audit')) return 'session';
  // '(project)' falls through to context.

  for (const issue of f.issues) {
    if (issue.check.startsWith('session-')) return 'session';
    if (issue.check.startsWith('mcph-')) return 'mcph';
    if (issue.check.startsWith('mcp-')) return 'mcp';
  }

  // Empty-issue fallback: classify by path so --verbose still groups correctly.
  const norm = f.path.replace(/\\/g, '/');
  if (norm.endsWith('.mcph.json') || norm.endsWith('.mcph.local.json')) return 'mcph';
  if (
    norm === '.mcp.json' ||
    norm.endsWith('/.mcp.json') ||
    norm.endsWith('/mcp.json') ||
    norm.includes('/mcpServers/') ||
    norm.endsWith('/.claude.json') ||
    norm.endsWith('.claude/settings.json') ||
    norm.endsWith('claude_desktop_config.json')
  ) {
    return 'mcp';
  }

  return 'context';
}

const GROUP_ORDER: FileGroup[] = ['context', 'mcp', 'mcph', 'session'];
const GROUP_LABELS: Record<FileGroup, string> = {
  context: 'Context Files',
  mcp: 'MCP Configs',
  mcph: 'mcph Configs',
  session: 'Session Audit',
};
const GROUP_SUMMARY_NOUNS: Record<FileGroup, string> = {
  context: 'context file',
  mcp: 'MCP config',
  mcph: 'mcph config',
  session: 'session audit',
};

function isSyntheticBucket(p: string): boolean {
  return p.startsWith('(') || p.includes('session audit');
}

export function formatText(result: LintResult, verbose: boolean = false): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(chalk.bold(`ctxlint v${result.version}`));
  lines.push('');
  lines.push(`Scanning ${result.projectRoot}...`);
  lines.push('');

  // Bucket every result row by family.
  const groups: Record<FileGroup, FileResult[]> = {
    context: [],
    mcp: [],
    mcph: [],
    session: [],
  };
  for (const f of result.files) {
    groups[classifyFile(f)].push(f);
  }

  // Top summary: show file lists per non-empty group, hiding the synthetic
  // cross-file buckets ('(project)', '(mcp)', '~/.claude/ (session audit)').
  // Those aren't files the user authored — they appear in the issue listing
  // section below.
  const totalTokens = result.summary.totalTokens;
  let renderedAnySummary = false;

  const contextReal = groups.context.filter((f) => !isSyntheticBucket(f.path));
  if (contextReal.length > 0) {
    lines.push(
      `Found ${contextReal.length} context file${contextReal.length !== 1 ? 's' : ''} (${totalTokens.toLocaleString()} tokens total)`,
    );
    for (const file of contextReal) {
      let desc = `  ${file.path} (${file.tokens.toLocaleString()} tokens, ${file.lines} lines)`;
      if (file.isSymlink && file.symlinkTarget) {
        desc = `  ${file.path} ${chalk.dim(`-> ${file.symlinkTarget} (symlink)`)}`;
      }
      lines.push(desc);
    }
    renderedAnySummary = true;
  }

  for (const g of ['mcp', 'mcph'] as const) {
    const real = groups[g].filter((f) => !isSyntheticBucket(f.path));
    if (real.length === 0) continue;
    if (renderedAnySummary) lines.push('');
    lines.push(`Found ${real.length} ${GROUP_SUMMARY_NOUNS[g]}${real.length !== 1 ? 's' : ''}`);
    for (const file of real) lines.push(`  ${file.path}`);
    renderedAnySummary = true;
  }

  // Session has no real files, only the synthetic audit bucket. Show it as a
  // header (when present) so users see "session was scanned" before the
  // detailed findings.
  if (groups.session.length > 0) {
    if (renderedAnySummary) lines.push('');
    lines.push('Session audit scanned');
    renderedAnySummary = true;
  }

  if (!renderedAnySummary) {
    lines.push(`Found ${result.files.length} file${result.files.length !== 1 ? 's' : ''}`);
  }

  lines.push('');

  // Per-file issues — grouped by family.
  const renderFileGroup = (files: FileResult[]) => {
    for (const file of files) {
      const fileIssues = file.issues;
      if (fileIssues.length === 0 && !verbose) continue;

      lines.push(chalk.underline(file.path));

      if (fileIssues.length === 0) {
        lines.push(chalk.green('  [ok] All checks passed'));
      } else {
        for (const issue of fileIssues) {
          lines.push(formatIssue(issue));
        }
      }

      lines.push('');
    }
  };

  // Show bold group headers whenever 2+ groups have content to render.
  const groupsToRender = GROUP_ORDER.filter((g) =>
    groups[g].some((f) => f.issues.length > 0 || verbose),
  );

  if (groupsToRender.length > 1) {
    for (const g of groupsToRender) {
      lines.push(chalk.bold(GROUP_LABELS[g]));
      renderFileGroup(groups[g]);
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
  lines.push(`  ${'-'.repeat(maxPathLen)}  ${'-'.repeat(8)}  ${'-'.repeat(6)}`);

  for (const file of result.files) {
    const tokenStr = file.tokens.toLocaleString().padStart(8);
    const lineStr = file.lines.toString().padStart(6);
    lines.push(`  ${file.path.padEnd(maxPathLen)}  ${tokenStr}  ${lineStr}`);
  }

  lines.push(`  ${'-'.repeat(maxPathLen)}  ${'-'.repeat(8)}  ${'-'.repeat(6)}`);
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
 * Audit collects cross-file and session-scope findings into synthetic
 * file-result buckets keyed by labels like `(project)`, `(mcp)`, and
 * `~/.claude/ (session audit)` (see audit.ts). Those labels aren't real
 * relative paths and must not flow through to SARIF's
 * `physicalLocation.artifactLocation.uri`, which GitHub Code Scanning
 * interprets as a repo-relative file path. For those buckets we emit a
 * `logicalLocations` entry instead (still valid SARIF 2.1.0) so consumers
 * can display the bucket name without pretending it's a file.
 */
function isSyntheticPath(p: string): boolean {
  return p.startsWith('(') || p.startsWith('~');
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
      const location: SarifLocation = isSyntheticPath(file.path)
        ? {
            logicalLocations: [
              {
                name: file.path,
                kind: 'resource',
              },
            ],
          }
        : {
            physicalLocation: {
              artifactLocation: {
                uri: file.path,
                uriBaseId: '%SRCROOT%',
              },
              region: {
                startLine: Math.max(issue.line, 1),
              },
            },
          };

      const sarifResult: SarifResult = {
        ruleId: `ctxlint/${issue.check}`,
        level: severityToLevel[issue.severity] || 'note',
        message: {
          text: issue.message + (issue.suggestion ? ` (${issue.suggestion})` : ''),
        },
        locations: [location],
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
      id: 'ctxlint/tier-tokens',
      shortDescription: {
        text: 'Tier-aware token accounting for always-loaded context files',
      },
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
      id: 'ctxlint/mcph-token-security',
      shortDescription: { text: 'mcp.hosting PAT leakage or env-var posture' },
      helpUri: 'https://github.com/yawlabs/ctxlint#mcph-config-linting',
    },
    {
      id: 'ctxlint/mcph-apibase',
      shortDescription: { text: 'mcph apiBase URL validation' },
      helpUri: 'https://github.com/yawlabs/ctxlint#mcph-config-linting',
    },
    {
      id: 'ctxlint/mcph-schema-conformance',
      shortDescription: { text: 'mcph config unknown field or stale schema version' },
      helpUri: 'https://github.com/yawlabs/ctxlint#mcph-config-linting',
    },
    {
      id: 'ctxlint/mcph-lists',
      shortDescription: { text: 'mcph allow/deny list conflict or duplicate entry' },
      helpUri: 'https://github.com/yawlabs/ctxlint#mcph-config-linting',
    },
    {
      id: 'ctxlint/mcph-gitignore',
      shortDescription: { text: 'mcph machine-local file not covered by .gitignore' },
      helpUri: 'https://github.com/yawlabs/ctxlint#mcph-config-linting',
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
    {
      id: 'ctxlint/session-memory-index-overflow',
      shortDescription: {
        text: "MEMORY.md exceeds Claude Code's 200-line / 25KB session-load cap",
      },
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
  physicalLocation?: {
    artifactLocation: { uri: string; uriBaseId: string };
    region: { startLine: number };
  };
  logicalLocations?: SarifLogicalLocation[];
}

interface SarifLogicalLocation {
  name: string;
  kind?: string;
}

function formatIssue(issue: LintIssue): string {
  const icon =
    issue.severity === 'error'
      ? chalk.red('x')
      : issue.severity === 'warning'
        ? chalk.yellow('!')
        : chalk.blue('i');

  const lineRef = issue.line > 0 ? `Line ${issue.line}: ` : '';
  let line = `  ${icon} ${lineRef}${issue.message}`;

  if (issue.suggestion) {
    line += `\n    ${chalk.dim('->')} ${chalk.dim(issue.suggestion)}`;
  }
  if (issue.detail) {
    line += `\n    ${chalk.dim(issue.detail)}`;
  }

  return line;
}
