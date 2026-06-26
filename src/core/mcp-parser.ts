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
  const gitTracked = await checkGitTracked(file.absolutePath, projectRoot);

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
    isGitTracked: gitTracked === 'tracked',
    ...(gitTracked === 'unknown' ? { gitTrackedUnknown: true } : {}),
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
  // Authoritative name -> line map from the depth-aware scan. A flat regex
  // scan mis-attributes a server named after a common field key ("env",
  // "command", ...) to an earlier server's nested key; the depth-aware scan
  // only sees keys directly inside the root-key object. Last occurrence wins
  // because JSON.parse keeps only the last duplicate.
  const nameLines = new Map<string, number>();
  for (const { name, line } of collectServerNameKeys(content, rootKey)) {
    nameLines.set(name, line);
  }
  for (const [name, value] of Object.entries(serversObj as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      continue;
    }

    const raw = value as Record<string, unknown>;
    const line = nameLines.get(name) ?? findServerLine(lines, name, rootKeyLine);
    const transport = inferTransport(raw);

    const entry: McpServerEntry = {
      name,
      transport,
      line,
      raw,
    };

    if (typeof raw.command === 'string') entry.command = raw.command;
    if (Array.isArray(raw.args)) entry.args = raw.args.map(String);
    const env = pickStringEntries(raw.env);
    if (env) entry.env = env;
    if (typeof raw.url === 'string') entry.url = raw.url;
    const headers = pickStringEntries(raw.headers);
    if (headers) entry.headers = headers;
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
 * Flat-scan fallback for when the depth-aware scan didn't surface a name
 * (e.g. formatting the character scan can't track). Search starts AFTER the
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

/**
 * Narrow an env/headers-shaped value to its string entries. All-or-nothing
 * narrowing would let one stray non-string value (`"PORT": 3000`) silently
 * drop the whole block -- including a real token sitting next to it -- from
 * secret scanning. Keep the string values; drop only the non-strings.
 *
 * Returns undefined when the value isn't an object, or when a non-empty
 * block has NO string values left (surfacing `{}` there would false-trigger
 * mcp-env/empty-env-block). A genuinely empty `{}` passes through so
 * empty-env-block still fires on it.
 */
function pickStringEntries(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).filter(
    (kv): kv is [string, string] => typeof kv[1] === 'string',
  );
  if (entries.length === 0 && Object.keys(value).length > 0) return undefined;
  return Object.fromEntries(entries);
}

/**
 * Depth-aware scan for keys defined directly inside the root-key object
 * (`"mcpServers": {...}` / `"servers": {...}`), in document order with their
 * 1-indexed lines. Unlike a flat regex scan this cannot confuse a server
 * named `env` with the `"env":` key nested inside another server's config.
 * Duplicate names appear once per occurrence (JSON.parse keeps only the last
 * value, so callers interested in "the" line should take the last entry;
 * the duplicate-name check counts all of them).
 *
 * Only call on content that is known-valid JSON -- brace tracking assumes
 * balanced syntax.
 */
export function collectServerNameKeys(
  content: string,
  rootKey: string,
): { name: string; line: number }[] {
  const names: { name: string; line: number }[] = [];
  let i = 0;
  let keyStart = -1; // index where the current key's opening quote sits
  let depth = 0;
  let inString = false;
  let escape = false;
  let rootKeyDepth = -1; // depth at which we saw the root key; server names are at rootKeyDepth+1
  let pendingKey = ''; // key being collected
  let collectingKey = false;

  while (i < content.length) {
    const c = content[i];
    if (escape) {
      escape = false;
      if (collectingKey) pendingKey += c;
      i++;
      continue;
    }
    if (c === '\\' && inString) {
      escape = true;
      if (collectingKey) pendingKey += c;
      i++;
      continue;
    }
    if (c === '"') {
      if (!inString) {
        inString = true;
        collectingKey = true;
        pendingKey = '';
        keyStart = i;
      } else {
        inString = false;
        // Was this a key? A key is a string followed by optional whitespace then `:`.
        let j = i + 1;
        while (j < content.length && /\s/.test(content[j])) j++;
        if (content[j] === ':') {
          // This string was a key at current depth.
          if (pendingKey === rootKey && rootKeyDepth === -1) {
            rootKeyDepth = depth;
          } else if (rootKeyDepth !== -1 && depth === rootKeyDepth + 1) {
            // 1-indexed line = number of newlines before the key's opening quote, +1.
            let line = 1;
            for (let k = 0; k < keyStart; k++) {
              if (content[k] === '\n') line++;
            }
            names.push({ name: decodeJsonKey(pendingKey), line });
          }
        }
        collectingKey = false;
        pendingKey = '';
      }
      i++;
      continue;
    }
    if (inString) {
      if (collectingKey) pendingKey += c;
      i++;
      continue;
    }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    i++;
  }

  return names;
}

/**
 * The scan above collects raw source characters, so an escaped key
 * (`"a\"b"`) carries its backslashes; decode so names compare equal to the
 * keys JSON.parse produces.
 */
function decodeJsonKey(raw: string): string {
  if (!raw.includes('\\')) return raw;
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

export type GitTrackedStatus = 'tracked' | 'untracked' | 'unknown';

/**
 * Distinguishes "git answered: not tracked" from "git could not answer".
 * `ls-files --error-unmatch` exits 1 with a pathspec message for untracked
 * files, and a repo-less directory has no tracking at all -- both are
 * DETERMINED untracked. Anything else (git binary missing, permissions,
 * timeouts) is 'unknown': the secret rules still skip, but the caller can
 * surface that the gate was skipped blind rather than answered.
 */
export function classifyGitTrackedError(message: string): 'untracked' | 'unknown' {
  if (/did not match any file/i.test(message)) return 'untracked';
  if (/not a git repository/i.test(message)) return 'untracked';
  return 'unknown';
}

async function checkGitTracked(filePath: string, projectRoot: string): Promise<GitTrackedStatus> {
  try {
    const git = getGit(projectRoot);
    const result = await git.raw(['ls-files', '--error-unmatch', filePath]);
    return result.trim().length > 0 ? 'tracked' : 'untracked';
  } catch (err) {
    return classifyGitTrackedError(err instanceof Error ? err.message : String(err));
  }
}
