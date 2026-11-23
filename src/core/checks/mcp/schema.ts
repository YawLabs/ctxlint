import { collectServerSets, isClaudeStateFile } from '../../mcp-parser.js';
import type { ParsedMcpConfig, LintIssue } from '../../types.js';

export async function checkMcpSchema(
  config: ParsedMcpConfig,
  _projectRoot: string,
): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];

  // invalid-json: parse errors
  if (config.parseErrors.length > 0) {
    for (const err of config.parseErrors) {
      issues.push({
        severity: 'error',
        check: 'mcp-schema',
        ruleId: 'mcp-schema/invalid-json',
        line: 1,
        message: `MCP config is not valid JSON: ${err}`,
      });
    }
    return issues; // can't check further
  }

  // missing-root-key. ~/.claude.json is Claude Code's general state file:
  // its MCP servers may live only in per-project `projects["<path>"].mcpServers`
  // blocks (the default for `claude mcp add`), so it has no required key.
  if (!config.actualRootKey && !isClaudeStateFile(config.relativePath)) {
    issues.push({
      severity: 'error',
      check: 'mcp-schema',
      ruleId: 'mcp-schema/missing-root-key',
      line: 1,
      message: `MCP config has no "${config.expectedRootKey}" key`,
    });
    return issues;
  }

  // wrong-root-key
  if (config.actualRootKey && config.actualRootKey !== config.expectedRootKey) {
    const line = findKeyLine(config.content, config.actualRootKey);
    const issue: LintIssue = {
      severity: 'error',
      check: 'mcp-schema',
      ruleId: 'mcp-schema/wrong-root-key',
      line,
      message: `${config.relativePath} must use "${config.expectedRootKey}" as root key, not "${config.actualRootKey}"`,
    };
    // Suppress the autofix when the expected key ALSO appears in the file:
    // renaming the wrong key to the expected one would create a duplicate
    // key, and JSON.parse silently keeps only the last -- dropping a whole
    // server block. Report it as a non-fixable error (no fix field) so the
    // user resolves the collision by hand.
    if (!expectedKeyAlreadyPresent(config.content, config.expectedRootKey)) {
      // Anchor oldText to the located root-key line. The fixer locates oldText
      // against that single line, so a `"<key>"` here can't match the same
      // token deeper in the file (e.g. a server literally named after the key).
      issue.fix = {
        file: config.filePath,
        line,
        oldText: `"${config.actualRootKey}"`,
        newText: `"${config.expectedRootKey}"`,
      };
    }
    issues.push(issue);
  }

  // Entries whose value is not an object (`"srv": "npx -y pkg"`): the parser
  // has no server to build, and every client ignores them, so report each one
  // here instead of letting it vanish. Only a name's LAST occurrence is live
  // (JSON.parse keeps the last duplicate).
  const invalidEntries: { name: string; line: number; valueType: string }[] = [];
  for (const set of collectServerSets(config.content, config.actualRootKey, config.relativePath)) {
    const last = new Map<string, (typeof set.keys)[number]>();
    for (const key of set.keys) last.set(key.name, key);
    for (const key of last.values()) {
      if (key.valueType !== 'object') invalidEntries.push(key);
    }
  }
  for (const entry of invalidEntries) {
    issues.push({
      severity: 'warning',
      check: 'mcp-schema',
      ruleId: 'mcp-schema/unknown-transport',
      line: entry.line,
      message: `Server "${entry.name}" must be an object, not ${describeType(entry.valueType)} — the client ignores this entry`,
    });
  }

  // empty-servers (a top-level root key exists here only; ~/.claude.json
  // without one has nothing to call empty)
  if (config.actualRootKey && config.servers.length === 0 && invalidEntries.length === 0) {
    issues.push({
      severity: 'info',
      check: 'mcp-schema',
      ruleId: 'mcp-schema/empty-servers',
      line: 1,
      message: 'MCP config has no server entries',
    });
    return issues;
  }

  // Per-server checks
  for (const server of config.servers) {
    // no-name-field (empty key)
    if (!server.name) {
      issues.push({
        severity: 'error',
        check: 'mcp-schema',
        ruleId: 'mcp-schema/no-name-field',
        line: server.line,
        message: 'Server name cannot be empty',
      });
      continue;
    }

    // unknown-transport: fires for ANY server the parser couldn't classify,
    // not just a string "type" it didn't recognize. missing-command /
    // missing-url are transport-conditional, so without this branch an empty
    // `{}` server (or one with a non-string "type") lints completely clean.
    if (server.transport === 'unknown') {
      const typeVal = server.raw.type;
      issues.push({
        severity: 'warning',
        check: 'mcp-schema',
        ruleId: 'mcp-schema/unknown-transport',
        line: server.line,
        message:
          typeof typeVal === 'string'
            ? `Server "${server.name}" has unknown transport type "${typeVal}"`
            : `Server "${server.name}" has no recognizable transport — expected "command", "url", or a valid "type"`,
      });
    }

    // ambiguous-transport: has both command and url
    if (server.command && server.url) {
      issues.push({
        severity: 'warning',
        check: 'mcp-schema',
        ruleId: 'mcp-schema/ambiguous-transport',
        line: server.line,
        message: `Server "${server.name}" has both "command" and "url" — transport is ambiguous`,
      });
    }

    // missing-command: stdio server without a (string) command. A present
    // but non-string command (`["npx", "-y", "pkg"]`) gets its own message:
    // "has no command field" would send the user looking for a missing key.
    if (server.transport === 'stdio' && !server.command) {
      const present = 'command' in server.raw && server.raw.command !== undefined;
      issues.push({
        severity: 'error',
        check: 'mcp-schema',
        ruleId: 'mcp-schema/missing-command',
        line: server.line,
        message: present
          ? `Server "${server.name}": "command" must be a string, not ${describeType(jsonTypeOf(server.raw.command))}`
          : `Server "${server.name}" has no "command" field`,
      });
    }

    // missing-url: http/sse server without url
    if ((server.transport === 'http' || server.transport === 'sse') && !server.url) {
      issues.push({
        severity: 'error',
        check: 'mcp-schema',
        ruleId: 'mcp-schema/missing-url',
        line: server.line,
        message: `Server "${server.name}" has no "url" field`,
      });
    }
  }

  return issues;
}

function jsonTypeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function describeType(type: string): string {
  if (type === 'null') return 'null';
  return /^[aeiou]/.test(type) ? `an ${type}` : `a ${type}`;
}

function findKeyLine(content: string, key: string): number {
  const lines = content.split('\n');
  const pattern = keyPattern(key);
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) {
      return i + 1;
    }
  }
  return 1;
}

/**
 * True when `key` appears as a JSON object key (`"key":`) anywhere in the
 * content. Used to detect that the expected root key already exists before
 * autofixing a wrong root key into it -- swapping the wrong key to one that's
 * already present would produce a duplicate key, which JSON.parse resolves by
 * keeping only the last occurrence, silently dropping a server block.
 */
function expectedKeyAlreadyPresent(content: string, key: string): boolean {
  return keyPattern(key).test(content);
}

function keyPattern(key: string): RegExp {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`"${escaped}"\\s*:`);
}
