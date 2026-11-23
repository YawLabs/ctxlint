import { getClaudeProjectScope } from '../../mcp-parser.js';
import type { ParsedMcpConfig, LintIssue, McpServerEntry } from '../../types.js';

export async function checkMcpRedundancy(configs: ParsedMcpConfig[]): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];

  for (const config of configs) {
    for (const server of config.servers) {
      // disabled-server
      if (server.disabled === true) {
        issues.push({
          severity: 'info',
          check: 'mcp-redundancy',
          ruleId: 'mcp-redundancy/disabled-server',
          line: server.line,
          message: `Server "${server.name}" is disabled — consider removing it if no longer needed`,
        });
      }
    }
  }

  // identical-across-scopes: check project vs global configs
  const projectConfigs = configs.filter((c) => c.scope === 'project');
  const globalConfigs = configs.filter((c) => c.scope === 'user' || c.scope === 'global');

  for (const projectConfig of projectConfigs) {
    for (const projectServer of projectConfig.servers) {
      const projectKey = comparisonKey(projectServer);
      for (const globalConfig of globalConfigs) {
        // A ~/.claude.json per-project block applies only to its own project:
        // another project's block can't be redundant with this one's config.
        const candidates = globalConfig.servers.filter((s) => {
          if (s.name !== projectServer.name) return false;
          const project = getClaudeProjectScope(s);
          return !project || project.isCurrentProject;
        });

        if (candidates.some((globalServer) => comparisonKey(globalServer) === projectKey)) {
          issues.push({
            severity: 'info',
            check: 'mcp-redundancy',
            ruleId: 'mcp-redundancy/identical-across-scopes',
            line: projectServer.line,
            message: `Server "${projectServer.name}" is identically configured in both ${projectConfig.relativePath} and ${globalConfig.relativePath}`,
          });
        }
      }
    }
  }

  return issues;
}

// Compare the meaningful fields. Env is compared as a set of pairs: key order
// in the file means nothing to the client.
function comparisonKey(server: McpServerEntry): string {
  return JSON.stringify({
    command: server.command,
    args: server.args,
    url: server.url,
    env: server.env
      ? Object.entries(server.env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      : undefined,
  });
}
