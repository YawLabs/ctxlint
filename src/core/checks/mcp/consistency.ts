import { collectServerNameKeys } from '../../mcp-parser.js';
import type { ParsedMcpConfig, LintIssue } from '../../types.js';

export async function checkMcpConsistency(configs: ParsedMcpConfig[]): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];

  if (configs.length < 2) {
    // Cross-file checks need at least 2 files, but we also check for
    // duplicate names within a single file and missing-from-client
    return checkSingleFileIssues(configs).concat(checkMissingFromClient(configs));
  }

  // Build a map of server name -> list of (config, server) pairs.
  // Project-scope configs only: a user/global config differing from the
  // project one is documented client precedence (project overrides user),
  // not drift, so cross-scope pairs must not enter the comparison.
  const serverMap = new Map<
    string,
    {
      config: ParsedMcpConfig;
      command?: string;
      url?: string;
      args?: string[];
      line: number;
    }[]
  >();

  for (const config of configs) {
    if (config.scope !== 'project') continue;
    for (const server of config.servers) {
      const existing = serverMap.get(server.name) || [];
      existing.push({
        config,
        command: server.command,
        url: server.url,
        args: server.args,
        line: server.line,
      });
      serverMap.set(server.name, existing);
    }
  }

  // same-server-different-config
  for (const [name, entries] of serverMap) {
    if (entries.length < 2) continue;

    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i];
        const b = entries[j];

        // Compare command/url/args (ignore header differences)
        const aKey = JSON.stringify({ cmd: a.command, url: a.url, args: a.args });
        const bKey = JSON.stringify({ cmd: b.command, url: b.url, args: b.args });

        if (aKey !== bKey) {
          issues.push({
            severity: 'warning',
            check: 'mcp-consistency',
            ruleId: 'mcp-consistency/same-server-different-config',
            line: a.line,
            message: `Server "${name}" is configured differently in ${a.config.relativePath} and ${b.config.relativePath}`,
          });
        }
      }
    }
  }

  // missing-from-client
  issues.push(...checkMissingFromClient(configs));

  // duplicate-server-name within single files
  issues.push(...checkSingleFileIssues(configs));

  return issues;
}

function checkMissingFromClient(configs: ParsedMcpConfig[]): LintIssue[] {
  const issues: LintIssue[] = [];

  // Find the primary config (.mcp.json)
  const primary = configs.find((c) => c.relativePath === '.mcp.json' && c.scope === 'project');
  if (!primary) return issues;

  // Check other project-level configs
  const otherConfigs = configs.filter(
    (c) =>
      c !== primary &&
      c.scope === 'project' &&
      (c.relativePath.includes('.cursor/') ||
        c.relativePath.includes('.vscode/') ||
        c.relativePath.includes('.amazonq/')),
  );

  for (const other of otherConfigs) {
    const otherNames = new Set(other.servers.map((s) => s.name));
    for (const primaryServer of primary.servers) {
      if (!otherNames.has(primaryServer.name)) {
        issues.push({
          severity: 'info',
          check: 'mcp-consistency',
          ruleId: 'mcp-consistency/missing-from-client',
          line: primaryServer.line,
          message: `Server "${primaryServer.name}" is in .mcp.json but missing from ${other.relativePath}`,
        });
      }
    }
  }

  return issues;
}

function checkSingleFileIssues(configs: ParsedMcpConfig[]): LintIssue[] {
  const issues: LintIssue[] = [];

  for (const config of configs) {
    if (!config.actualRootKey) continue;
    const serverKeys = collectServerNameKeys(config.content, config.actualRootKey);

    // Count occurrences; a duplicate is any name appearing 2+ times. Track the
    // line of the SECOND occurrence so the finding points at the redefinition.
    const counts = new Map<string, number>();
    const secondLines = new Map<string, number>();
    for (const { name, line } of serverKeys) {
      const next = (counts.get(name) ?? 0) + 1;
      counts.set(name, next);
      if (next === 2) secondLines.set(name, line);
    }

    for (const [name, count] of counts) {
      if (count > 1) {
        issues.push({
          severity: 'warning',
          check: 'mcp-consistency',
          ruleId: 'mcp-consistency/duplicate-server-name',
          line: secondLines.get(name) ?? 1,
          message: `Duplicate server name "${name}" in ${config.relativePath} — only the last definition is used`,
        });
      }
    }
  }

  return issues;
}
