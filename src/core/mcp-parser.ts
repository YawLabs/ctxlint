import * as path from 'node:path';
import {
  parse as parseJsonc,
  parseTree,
  printParseErrorCode,
  type Node,
  type ParseError,
} from 'jsonc-parser';
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
  const gitTracked = await checkGitTracked(file.absolutePath, projectRoot);
  return parseMcpContent(content, {
    filePath: file.absolutePath,
    relativePath: file.relativePath,
    scope,
    projectRoot,
    gitTracked,
  });
}

/**
 * The synchronous half of parseMcpConfig: everything except reading the file
 * and asking git. Exported so check tests can build a ParsedMcpConfig (with
 * real server lines) straight from JSON text.
 */
export function parseMcpContent(
  content: string,
  opts: {
    filePath: string;
    relativePath: string;
    scope: McpConfigScope;
    projectRoot?: string;
    gitTracked?: GitTrackedStatus;
  },
): ParsedMcpConfig {
  const client = detectClient(opts.relativePath);
  const expectedRootKey = client === 'vscode' ? 'servers' : 'mcpServers';
  const gitTracked = opts.gitTracked ?? 'untracked';

  const result: ParsedMcpConfig = {
    filePath: opts.filePath,
    relativePath: opts.relativePath,
    client,
    scope: opts.scope,
    expectedRootKey,
    actualRootKey: null,
    servers: [],
    parseErrors: [],
    content,
    isGitTracked: gitTracked === 'tracked',
    ...(gitTracked === 'unknown' ? { gitTrackedUnknown: true } : {}),
  };

  const outcome = parseConfigText(content, client);
  if ('error' in outcome) {
    result.parseErrors.push(outcome.error);
    return result;
  }
  const parsed = outcome.value;

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    result.parseErrors.push('MCP config must be a JSON object');
    return result;
  }
  const root = parsed as Record<string, unknown>;

  // Detect root key
  const rootKey = findRootKey(root);
  result.actualRootKey = rootKey;

  if (rootKey) {
    const serversObj = root[rootKey];
    if (!isPlainObject(serversObj)) {
      result.parseErrors.push(`"${rootKey}" must be an object`);
      return result;
    }
  }

  // Server sets come from the location-aware tree scan (top-level root key,
  // plus ~/.claude.json's per-project blocks); values come from the parsed
  // object so duplicate-key semantics match JSON.parse (last one wins).
  const normalizedProjectRoot = opts.projectRoot ? normalizeProjectPath(opts.projectRoot) : null;
  for (const set of collectServerSets(content, rootKey, opts.relativePath)) {
    const serversObj = getAtPath(root, set.rootPath);
    if (!isPlainObject(serversObj)) continue;

    // Authoritative name -> line map. Last occurrence wins because the parsed
    // object keeps only the last duplicate.
    const nameLines = new Map<string, number>();
    for (const { name, line } of set.keys) nameLines.set(name, line);

    for (const [name, value] of Object.entries(serversObj)) {
      // Non-object entries are reported by mcp-schema (collectServerSets
      // records each key's value type); there is no server to build here.
      if (!isPlainObject(value)) continue;

      const entry = buildServerEntry(name, value, nameLines.get(name) ?? 1, client);
      serverMeta.set(entry, {
        jsonPath: [...set.rootPath, name],
        ...(set.projectPath !== undefined
          ? {
              project: {
                projectPath: set.projectPath,
                isCurrentProject:
                  normalizedProjectRoot !== null &&
                  normalizeProjectPath(set.projectPath) === normalizedProjectRoot,
              },
            }
          : {}),
      });
      result.servers.push(entry);
    }
  }

  return result;
}

function buildServerEntry(
  name: string,
  raw: Record<string, unknown>,
  line: number,
  client: McpClient,
): McpServerEntry {
  const url = readUrl(raw, client);
  const entry: McpServerEntry = {
    name,
    transport: inferTransport(raw, url),
    line,
    raw,
  };

  if (typeof raw.command === 'string') entry.command = raw.command;
  if (Array.isArray(raw.args)) entry.args = raw.args.map(String);
  const env = pickStringEntries(raw.env);
  if (env) entry.env = env;
  if (url !== undefined) entry.url = url;
  const headers = pickStringEntries(raw.headers);
  if (headers) entry.headers = headers;
  if (typeof raw.disabled === 'boolean') entry.disabled = raw.disabled;
  if (Array.isArray(raw.autoApprove)) entry.autoApprove = raw.autoApprove.map(String);
  if (typeof raw.timeout === 'number') entry.timeout = raw.timeout;
  if (isPlainObject(raw.oauth)) entry.oauth = raw.oauth;
  if (typeof raw.headersHelper === 'string') entry.headersHelper = raw.headersHelper;
  return entry;
}

/**
 * Windsurf spells a remote server's endpoint `serverUrl` (its docs use it for
 * every remote example); `url` still wins when both are present.
 */
function readUrl(raw: Record<string, unknown>, client: McpClient): string | undefined {
  if (typeof raw.url === 'string') return raw.url;
  if (client === 'windsurf' && typeof raw.serverUrl === 'string') return raw.serverUrl;
  return undefined;
}

/**
 * The key that holds a server's URL in the raw object, for callers that need
 * to locate it in the source (see locateServerValue).
 */
export function urlKeyOf(server: McpServerEntry): 'url' | 'serverUrl' {
  return typeof server.raw.url !== 'string' && typeof server.raw.serverUrl === 'string'
    ? 'serverUrl'
    : 'url';
}

/**
 * Parse with the strictness of the client that reads the file. VS Code reads
 * `.vscode/mcp.json` as JSONC (comments and trailing commas are fine there);
 * every other client this linter knows parses strict JSON, so a comment in
 * `.mcp.json` really does break Claude Code and must stay an error.
 *
 */
function parseConfigText(
  content: string,
  client: McpClient,
): { value: unknown } | { error: string } {
  if (client === 'vscode') {
    const errors: ParseError[] = [];
    const value = parseJsonc(content, errors, { allowTrailingComma: true });
    if (errors.length > 0) {
      const first = errors[0];
      const { line, column } = offsetToLineColumn(lineStartsOf(content), first.offset);
      return { error: `${printParseErrorCode(first.error)} at line ${line} column ${column}` };
    }
    return { value };
  }
  try {
    return { value: JSON.parse(content) as unknown };
  } catch {
    // Never pass V8's message through: it quotes ~10 characters of source
    // around the bad token, and when that token is an unquoted secret the
    // finding leaks its start. Report the position only, as the JSONC branch
    // does, located by a strict (no comments, no trailing commas) re-parse.
    const errors: ParseError[] = [];
    parseJsonc(content, errors, { disallowComments: true, allowTrailingComma: false });
    const first = errors[0];
    if (!first) return { error: 'Invalid JSON' };
    const { line, column } = offsetToLineColumn(lineStartsOf(content), first.offset);
    return { error: `${printParseErrorCode(first.error)} at line ${line} column ${column}` };
  }
}

function detectClient(relativePath: string): McpClient {
  const normalized = relativePath.replace(/\\/g, '/');

  // Cline, first: its VS Code globalStorage path would otherwise be taken
  // for something else, and CLINE_MCP_SETTINGS_PATH can point anywhere but
  // keeps the file name.
  if (
    normalized.includes('saoudrizwan.claude-dev/') ||
    /(^|\/)cline_mcp_settings\.json$/.test(normalized)
  ) {
    return 'cline';
  }
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

function inferTransport(raw: Record<string, unknown>, url: string | undefined): McpTransport {
  if (typeof raw.type === 'string') {
    if (raw.type === 'stdio' || raw.type === 'http' || raw.type === 'sse') {
      return raw.type;
    }
    return 'unknown';
  }
  if ('command' in raw) return 'stdio';
  if ('url' in raw || url !== undefined) return 'http';
  return 'unknown';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getAtPath(root: Record<string, unknown>, keys: string[]): unknown {
  let cur: unknown = root;
  for (const key of keys) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
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
  if (!isPlainObject(value)) return undefined;
  const entries = Object.entries(value).filter(
    (kv): kv is [string, string] => typeof kv[1] === 'string',
  );
  if (entries.length === 0 && Object.keys(value).length > 0) return undefined;
  return Object.fromEntries(entries);
}

// ---------------------------------------------------------------------------
// Location-aware scanning (jsonc-parser tree: string-aware, comment-aware,
// keeps duplicate keys with their offsets).
// ---------------------------------------------------------------------------

export interface ServerKey {
  name: string;
  /** 1-indexed line of the key's opening quote. */
  line: number;
  /** jsonc-parser node type of the value ('object' for a real server entry). */
  valueType: Node['type'];
}

export interface ServerSet {
  /** Key path from the document root to the servers object. */
  rootPath: string[];
  /** Set for a `projects["<path>"].mcpServers` block in ~/.claude.json. */
  projectPath?: string;
  /** Every key directly inside the servers object, in document order, duplicates included. */
  keys: ServerKey[];
}

/**
 * True for Claude Code's state file (`~/.claude.json`). Besides an optional
 * top-level `mcpServers` (user scope), Claude Code writes local-scope servers
 * to `projects["<abs path>"].mcpServers` -- by default, for every
 * `claude mcp add` without `--scope`. Those are real config and are linted.
 */
export function isClaudeStateFile(relativePath: string): boolean {
  return /(^|[\\/])\.claude\.json$/.test(relativePath);
}

/**
 * Every server object in the file: the top-level root key's object (only at
 * depth 1 -- a nested `mcpServers` is not the root key), plus, for
 * ~/.claude.json, each `projects.*.mcpServers` object as its own set. Names
 * are only unique within a set; two projects both defining `github` is not a
 * duplicate.
 */
export function collectServerSets(
  content: string,
  rootKey: string | null,
  relativePath: string,
): ServerSet[] {
  const { tree, lineStarts } = treeOf(content);
  if (!tree || tree.type !== 'object') return [];
  const sets: ServerSet[] = [];

  if (rootKey) {
    const serversNode = lastPropertyValue(tree, rootKey);
    if (serversNode?.type === 'object') {
      sets.push({ rootPath: [rootKey], keys: keysOf(serversNode, lineStarts) });
    }
  }

  if (isClaudeStateFile(relativePath)) {
    const projects = lastPropertyValue(tree, 'projects');
    if (projects?.type === 'object') {
      // A duplicated project key: JSON.parse keeps the last, so only the last
      // block is live config.
      const lastByKey = new Map<string, Node>();
      for (const prop of projects.children ?? []) {
        const key = prop.children?.[0]?.value;
        const value = prop.children?.[1];
        if (typeof key === 'string' && value) lastByKey.set(key, value);
      }
      for (const [projectPath, projectNode] of lastByKey) {
        if (projectNode.type !== 'object') continue;
        const serversNode = lastPropertyValue(projectNode, 'mcpServers');
        if (serversNode?.type !== 'object') continue;
        sets.push({
          rootPath: ['projects', projectPath, 'mcpServers'],
          projectPath,
          keys: keysOf(serversNode, lineStarts),
        });
      }
    }
  }

  return sets;
}

/**
 * Keys defined directly inside the top-level root-key object
 * (`"mcpServers": {...}` / `"servers": {...}`), in document order with their
 * 1-indexed lines. Only a depth-1 root key counts, and collection stops when
 * its object closes -- a nested `mcpServers` (e.g. ~/.claude.json's
 * per-project blocks) and keys of later sibling objects are never collected.
 * Duplicate names appear once per occurrence (JSON.parse keeps only the last
 * value, so callers interested in "the" line should take the last entry; the
 * duplicate-name check counts all of them).
 */
export function collectServerNameKeys(
  content: string,
  rootKey: string,
): { name: string; line: number }[] {
  const { tree, lineStarts } = treeOf(content);
  if (!tree || tree.type !== 'object') return [];
  const serversNode = lastPropertyValue(tree, rootKey);
  if (serversNode?.type !== 'object') return [];
  return keysOf(serversNode, lineStarts).map(({ name, line }) => ({ name, line }));
}

export interface ValueLocation {
  /** 1-indexed line of the value's first character. */
  line: number;
  /** 1-indexed column of the value's first character (a string's opening quote). */
  column: number;
  /** The value's verbatim source text (for a string: quotes and escapes included). */
  text: string;
}

/**
 * Locate a value inside one server's object in the source text, e.g.
 * `['env', 'API_KEY']`, `['args', 2]`, `['type']`. Fixes must anchor on the
 * value's own line: on pretty-printed JSON it sits below the server's
 * `"name": {` line, which is all McpServerEntry.line records.
 *
 * Duplicate keys resolve to the LAST occurrence (the one JSON.parse keeps).
 * Returns null when the path doesn't exist in the source -- callers should
 * then omit the fix rather than aim it at a guessed line.
 */
export function locateServerValue(
  config: Pick<ParsedMcpConfig, 'content' | 'actualRootKey' | 'expectedRootKey'>,
  server: McpServerEntry,
  valuePath: (string | number)[],
): ValueLocation | null {
  const { tree, lineStarts } = treeOf(config.content);
  if (!tree) return null;
  const serverPath = serverMeta.get(server)?.jsonPath ?? [
    config.actualRootKey ?? config.expectedRootKey,
    server.name,
  ];
  let node: Node | undefined = tree;
  for (const segment of [...serverPath, ...valuePath]) {
    if (!node) return null;
    if (typeof segment === 'number') {
      node = node.type === 'array' ? node.children?.[segment] : undefined;
    } else {
      node = node.type === 'object' ? lastPropertyValue(node, segment) : undefined;
    }
  }
  if (!node) return null;
  const { line, column } = offsetToLineColumn(lineStarts, node.offset);
  return { line, column, text: config.content.slice(node.offset, node.offset + node.length) };
}

export interface ClaudeProjectScope {
  /** The `projects` key the server sits under, verbatim. */
  projectPath: string;
  /** True when that project path is the project being linted (local scope for it). */
  isCurrentProject: boolean;
}

/**
 * For a server parsed from `projects["<path>"].mcpServers` in ~/.claude.json,
 * the project it belongs to; undefined for every other server.
 */
export function getClaudeProjectScope(server: McpServerEntry): ClaudeProjectScope | undefined {
  return serverMeta.get(server)?.project;
}

interface ServerMeta {
  jsonPath: string[];
  project?: ClaudeProjectScope;
}

// Side table rather than new McpServerEntry fields: entries built by hand (as
// check tests do) simply have no metadata and are treated as top-level.
const serverMeta = new WeakMap<McpServerEntry, ServerMeta>();

function normalizeProjectPath(p: string): string {
  const resolved = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function keysOf(objectNode: Node, lineStarts: number[]): ServerKey[] {
  const keys: ServerKey[] = [];
  for (const prop of objectNode.children ?? []) {
    const keyNode = prop.children?.[0];
    if (!keyNode || typeof keyNode.value !== 'string') continue;
    keys.push({
      name: keyNode.value,
      line: offsetToLineColumn(lineStarts, keyNode.offset).line,
      valueType: prop.children?.[1]?.type ?? 'null',
    });
  }
  return keys;
}

function lastPropertyValue(objectNode: Node, key: string): Node | undefined {
  let found: Node | undefined;
  for (const prop of objectNode.children ?? []) {
    if (prop.children?.[0]?.value === key) found = prop.children[1];
  }
  return found;
}

// One-entry cache: every check on a config re-locates against the same
// content, and ~/.claude.json can run to megabytes.
let treeCache: { content: string; tree: Node | undefined; lineStarts: number[] } | null = null;

function treeOf(content: string): { tree: Node | undefined; lineStarts: number[] } {
  if (treeCache?.content !== content) {
    treeCache = {
      content,
      // Tolerant on purpose: strictness is decided by parseConfigText; by the
      // time anything locates, the content was accepted for its client.
      tree: parseTree(content, [], { allowTrailingComma: true }),
      lineStarts: lineStartsOf(content),
    };
  }
  return treeCache;
}

function lineStartsOf(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function offsetToLineColumn(
  lineStarts: number[],
  offset: number,
): { line: number; column: number } {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - lineStarts[lo] + 1 };
}

export type GitTrackedStatus = 'tracked' | 'untracked' | 'unknown';

/**
 * Distinguishes "git answered: not tracked" from "git could not answer".
 * `ls-files --error-unmatch` exits 1 with a pathspec message for untracked
 * files, a repo-less directory has no tracking at all, and a file outside the
 * repository (a global config linted from inside a repo) cannot be tracked by
 * it -- all three are DETERMINED untracked. Anything else (git binary
 * missing, permissions, timeouts) is 'unknown': the secret rules still skip,
 * but the caller can surface that the gate was skipped blind rather than
 * answered.
 */
export function classifyGitTrackedError(message: string): 'untracked' | 'unknown' {
  if (/did not match any file/i.test(message)) return 'untracked';
  if (/not a git repository/i.test(message)) return 'untracked';
  if (/is outside repository/i.test(message)) return 'untracked';
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
