import { execSync } from 'node:child_process';
import { readFileContent } from '../utils/fs.js';
import type {
  ParsedMcpConfig,
  McpServerEntry,
  McpClient,
  McpConfigScope,
  McpTransport,
} from './types.js';
import type { DiscoveredFile } from './scanner.js';

export function parseMcpConfig(
  file: DiscoveredFile,
  projectRoot: string,
  scopeOverride?: McpConfigScope,
): ParsedMcpConfig {
  const content = readFileContent(file.absolutePath);
  const client = detectClient(file.relativePath);
  const scope = scopeOverride ?? detectScope(file.relativePath);
  const expectedRootKey = client === 'vscode' ? 'servers' : 'mcpServers';
  const isGitTracked = checkGitTracked(file.absolutePath, projectRoot);

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
  for (const [name, value] of Object.entries(serversObj as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      continue;
    }

    const raw = value as Record<string, unknown>;
    const line = findServerLine(lines, name);
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
    if (typeof raw.oauth === 'object' && raw.oauth !== null)
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

function detectScope(_relativePath: string): McpConfigScope {
  // Default fallback; callers should pass scopeOverride for accuracy
  return 'project';
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

function findServerLine(lines: string[], serverName: string): number {
  const escaped = serverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`"${escaped}"\\s*:`);
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) {
      return i + 1; // 1-indexed
    }
  }
  return 1;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((v) => typeof v === 'string');
}

function checkGitTracked(filePath: string, projectRoot: string): boolean {
  try {
    execSync(`git ls-files --error-unmatch "${filePath}"`, {
      cwd: projectRoot,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}
