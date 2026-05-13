import { readFileContent } from '../utils/fs.js';
import { getGit } from '../utils/git.js';
import type {
  ParsedMcpConfig,
  McpServerEntry,
  McpClient,
  McpConfigScope,
  McpTransport,
} from './types.js';
import type { DiscoveredFile } from './scanner.js';

export async function parseMcpConfig(
  file: DiscoveredFile,
  projectRoot: string,
  scope: McpConfigScope,
): Promise<ParsedMcpConfig> {
  const content = readFileContent(file.absolutePath);
  const client = detectClient(file.relativePath);
  const expectedRootKey = client === 'vscode' ? 'servers' : 'mcpServers';
  const isGitTracked = await checkGitTracked(file.absolutePath, projectRoot);

  const result: ParsedMcpConfig = {
    filePath: file.absolutePath,
    relativePath: file.relativePath,
    client,
    scope,
    expectedRootKey,
    actualRootKey: null,
    servers: [],
    parseErrors: [],
    content,
    isGitTracked,
  };

  // Parse JSON
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.parseErrors.push(message);
    return result;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    result.parseErrors.push('MCP config must be a JSON object');
    return result;
  }

  // Detect root key
  const rootKey = findRootKey(parsed);
  result.actualRootKey = rootKey;

  if (!rootKey) {
    return result;
  }

  const serversObj = parsed[rootKey];
  if (typeof serversObj !== 'object' || serversObj === null || Array.isArray(serversObj)) {
    result.parseErrors.push(`"${rootKey}" must be an object`);
    return result;
  }

  // Parse server entries
  const lines = content.split('\n');
  const rootKeyLine = findRootKeyLine(lines, rootKey);
  for (const [name, value] of Object.entries(serversObj as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      continue;
    }

    const raw = value as Record<string, unknown>;
    const line = findServerLine(lines, name, rootKeyLine);
    const transport = inferTransport(raw);

    const entry: McpServerEntry = {
      name,
      transport,
      line,
      raw,
    };

    if (typeof raw.command === 'string') entry.command = raw.command;
    if (Array.isArray(raw.args)) entry.args = raw.args.map(String);
    if (isStringRecord(raw.env)) entry.env = raw.env as Record<string, string>;
    if (typeof raw.url === 'string') entry.url = raw.url;
    if (isStringRecord(raw.headers)) entry.headers = raw.headers as Record<string, string>;
    if (typeof raw.disabled === 'boolean') entry.disabled = raw.disabled;
    if (Array.isArray(raw.autoApprove)) entry.autoApprove = raw.autoApprove.map(String);
    if (typeof raw.timeout === 'number') entry.timeout = raw.timeout;
    if (typeof raw.oauth === 'object' && raw.oauth !== null && !Array.isArray(raw.oauth))
      entry.oauth = raw.oauth as Record<string, unknown>;
    if (typeof raw.headersHelper === 'string') entry.headersHelper = raw.headersHelper;

    result.servers.push(entry);
  }

  return result;
}

function detectClient(relativePath: string): McpClient {
  const normalized = relativePath.replace(/\\/g, '/');

  if (normalized.includes('.vscode/')) return 'vscode';
  if (normalized.includes('.cursor/')) return 'cursor';
  if (normalized.includes('.amazonq/') || normalized.includes('.aws/amazonq/')) return 'amazonq';
  if (normalized.includes('.continue/')) return 'continue';
  if (normalized.includes('.codeium/windsurf/')) return 'windsurf';

  // Claude Desktop config paths
  if (
    normalized.includes('Claude/claude_desktop_config.json') ||
    normalized.includes('Application Support/Claude/')
  ) {
    return 'claude-desktop';
  }

  // .mcp.json, .claude.json, .claude/settings.json → claude-code
  return 'claude-code';
}

function findRootKey(parsed: Record<string, unknown>): string | null {
  if ('mcpServers' in parsed) return 'mcpServers';
  if ('servers' in parsed) return 'servers';
  return null;
}

function inferTransport(raw: Record<string, unknown>): McpTransport {
  if (typeof raw.type === 'string') {
    if (raw.type === 'stdio' || raw.type === 'http' || raw.type === 'sse') {
      return raw.type;
    }
    return 'unknown';
  }
  if ('command' in raw) return 'stdio';
  if ('url' in raw) return 'http';
  return 'unknown';
}

/**
 * Find the line index (0-based) of the root key ("mcpServers" / "servers").
 * Returns -1 if not found textually (the parser only calls this AFTER
 * confirming the key is present in the parsed object, but JSON comments /
 * unusual formatting could still defeat the regex -- in that case callers
 * fall back to scanning from line 0).
 */
function findRootKeyLine(lines: string[], rootKey: string): number {
  const escaped = rootKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`"${escaped}"\\s*:`);
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) return i;
  }
  return -1;
}

/**
 * Find the 1-indexed line of a server entry by name. Search starts AFTER the
 * root key line so a top-level key colliding with a server name (e.g. a
 * server actually named "version" alongside a top-level "version" field)
 * doesn't get reported at line 1.
 *
 * Fallbacks (in order):
 *  - If no match is found after the root key: return the root key line + 1
 *    so diagnostics still point inside the relevant block.
 *  - If the root key wasn't located textually: return 1.
 */
function findServerLine(lines: string[], serverName: string, rootKeyLine: number): number {
  const escaped = serverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`"${escaped}"\\s*:`);
  const start = rootKeyLine >= 0 ? rootKeyLine + 1 : 0;
  for (let i = start; i < lines.length; i++) {
    if (pattern.test(lines[i])) {
      return i + 1; // 1-indexed
    }
  }
  return rootKeyLine >= 0 ? rootKeyLine + 1 : 1;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((v) => typeof v === 'string');
}

async function checkGitTracked(filePath: string, projectRoot: string): Promise<boolean> {
  try {
    const git = getGit(projectRoot);
    const result = await git.raw(['ls-files', '--error-unmatch', filePath]);
    return result.trim().length > 0;
  } catch {
    return false;
  }
}
