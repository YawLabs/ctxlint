import type { ParsedMcpConfig, LintIssue } from '../../types.js';

export async function checkMcpConsistency(configs: ParsedMcpConfig[]): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];

  if (configs.length < 2) {
    // Cross-file checks need at least 2 files, but we also check for
    // duplicate names within a single file and missing-from-client
    return checkSingleFileIssues(configs).concat(checkMissingFromClient(configs));
  }

  // Build a map of server name -> list of (config, server) pairs
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
            ruleId: 'same-server-different-config',
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
          ruleId: 'missing-from-client',
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
    // duplicate-server-name: check raw content for duplicate keys
    // JSON.parse silently uses last-write-wins, so we need to check the raw content
    const nameCount = new Map<string, number>();
    const lines = config.content.split('\n');

    // Simple heuristic: count occurrences of "serverName": in the content
    for (const server of config.servers) {
      const escaped = server.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`"${escaped}"\\s*:`, 'g');
      let count = 0;
      for (const line of lines) {
        if (pattern.test(line)) count++;
        pattern.lastIndex = 0;
      }
      nameCount.set(server.name, count);
    }

    for (const [name, count] of nameCount) {
      if (count > 1) {
        issues.push({
          severity: 'warning',
          check: 'mcp-consistency',
          ruleId: 'duplicate-server-name',
          line: 1,
          message: `Duplicate server name "${name}" in ${config.relativePath} — only the last definition is used`,
        });
      }
    }
  }

  return issues;
}
