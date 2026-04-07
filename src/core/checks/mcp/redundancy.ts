import type { ParsedMcpConfig, LintIssue } from '../../types.js';

export async function checkMcpRedundancy(configs: ParsedMcpConfig[]): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];

  for (const config of configs) {
    for (const server of config.servers) {
      // disabled-server
      if (server.disabled === true) {
        issues.push({
          severity: 'info',
          check: 'mcp-redundancy',
          ruleId: 'disabled-server',
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
      for (const globalConfig of globalConfigs) {
        const globalServer = globalConfig.servers.find((s) => s.name === projectServer.name);
        if (!globalServer) continue;

        // Compare meaningful fields
        const projectKey = JSON.stringify({
          command: projectServer.command,
          args: projectServer.args,
          url: projectServer.url,
          env: projectServer.env,
        });
        const globalKey = JSON.stringify({
          command: globalServer.command,
          args: globalServer.args,
          url: globalServer.url,
          env: globalServer.env,
        });

        if (projectKey === globalKey) {
          issues.push({
            severity: 'info',
            check: 'mcp-redundancy',
            ruleId: 'identical-across-scopes',
            line: projectServer.line,
            message: `Server "${projectServer.name}" is identically configured in both ${projectConfig.relativePath} and ${globalConfig.relativePath}`,
          });
        }
      }
    }
  }

  return issues;
}
