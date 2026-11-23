import { collectServerSets, getClaudeProjectScope } from '../../mcp-parser.js';
import type { ParsedMcpConfig, LintIssue } from '../../types.js';

export async function checkMcpConsistency(configs: ParsedMcpConfig[]): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];

  if (configs.length < 2) {
    // Cross-file checks need at least 2 files, but we also check for
    // duplicate names within a single file and missing-from-client
    return checkSingleFileIssues(configs).concat(checkMissingFromClient(configs));
  }

  // Build a map of (scope bucket, server name) -> list of (config, server)
  // pairs. Same-scope pairs are compared in EVERY scope; only cross-scope
  // pairs are skipped: a user/global config differing from the project one is
  // documented client precedence (project overrides user), not drift, but two
  // per-user files (e.g. ~/.cursor/mcp.json vs Claude Desktop's config) have
  // no precedence between them -- each client reads only its own file.
  const serverMap = new Map<
    string,
    {
      config: ParsedMcpConfig;
      name: string;
      command?: string;
      url?: string;
      args?: string[];
      line: number;
    }[]
  >();

  for (const config of configs) {
    // 'user' and 'global' configs live at the same per-user level; bucket
    // them together (mirrors mcp-redundancy's user|global handling).
    const bucket = config.scope === 'project' ? 'project' : 'user';
    for (const server of config.servers) {
      // ~/.claude.json's per-project (local-scope) servers override the user
      // scope for that one project -- a difference is precedence, not drift.
      if (getClaudeProjectScope(server)) continue;
      const key = `${bucket}::${server.name}`;
      const existing = serverMap.get(key) || [];
      existing.push({
        config,
        name: server.name,
        command: server.command,
        url: server.url,
        args: server.args,
        line: server.line,
      });
      serverMap.set(key, existing);
    }
  }

  // same-server-different-config
  for (const entries of serverMap.values()) {
    if (entries.length < 2) continue;

    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i];
        const b = entries[j];

        // Compare command/url/args (ignore header differences). Env refs are
        // normalized first: ${K} in .mcp.json and ${env:K} in .cursor/mcp.json
        // are each what mcp-env/wrong-syntax requires of that client, so they
        // are the same reference, not drift.
        const aKey = comparisonKey(a);
        const bKey = comparisonKey(b);

        if (aKey !== bKey) {
          issues.push({
            severity: 'warning',
            check: 'mcp-consistency',
            ruleId: 'mcp-consistency/same-server-different-config',
            line: a.line,
            message: `Server "${a.name}" is configured differently in ${a.config.relativePath} and ${b.config.relativePath}`,
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

  if (primary.parseErrors.length > 0) return issues;

  // Check other project-level configs. One that failed to parse has no
  // servers to compare -- every primary server would read as "missing" --
  // and mcp-schema/invalid-json already reports it.
  const otherConfigs = configs.filter(
    (c) =>
      c !== primary &&
      c.scope === 'project' &&
      c.parseErrors.length === 0 &&
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
    if (config.parseErrors.length > 0) continue;
    // Names are unique per servers object: ~/.claude.json's per-project
    // blocks are separate sets, so two projects both defining `github` is
    // not a duplicate.
    for (const set of collectServerSets(
      config.content,
      config.actualRootKey,
      config.relativePath,
    )) {
      // Count occurrences; a duplicate is any name appearing 2+ times. Track
      // the line of the SECOND occurrence so the finding points at the
      // redefinition.
      const counts = new Map<string, number>();
      const secondLines = new Map<string, number>();
      for (const { name, line } of set.keys) {
        const next = (counts.get(name) ?? 0) + 1;
        counts.set(name, next);
        if (next === 2) secondLines.set(name, line);
      }

      const where =
        set.projectPath !== undefined
          ? `${config.relativePath} (projects[${JSON.stringify(set.projectPath)}])`
          : config.relativePath;
      for (const [name, count] of counts) {
        if (count > 1) {
          issues.push({
            severity: 'warning',
            check: 'mcp-consistency',
            ruleId: 'mcp-consistency/duplicate-server-name',
            line: secondLines.get(name) ?? 1,
            message: `Duplicate server name "${name}" in ${where} — only the last definition is used`,
          });
        }
      }
    }
  }

  return issues;
}

// ${env:K} (Cursor/Windsurf), ${{ secrets.K }} (Continue) and ${K} / ${K:-default}
// (Claude Code) all collapse to ${K}. The default is dropped because the other
// syntaxes cannot express one -- mcp-env's own fix drops it the same way.
function normalizeEnvRefs(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value
    .replace(/\$\{\{\s*secrets\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, '${$1}')
    .replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, '${$1}')
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*):-[^}]*\}/g, '${$1}');
}

function comparisonKey(entry: { command?: string; url?: string; args?: string[] }): string {
  return JSON.stringify({
    cmd: normalizeEnvRefs(entry.command),
    url: normalizeEnvRefs(entry.url),
    args: entry.args?.map((a) => normalizeEnvRefs(a)),
  });
}
