import { locateServerValue, urlKeyOf } from '../../mcp-parser.js';
import type {
  FixAction,
  ParsedMcpConfig,
  LintIssue,
  McpClient,
  McpServerEntry,
} from '../../types.js';

// Bare identifier refs: ${VAR} and ${VAR:-default}. The optional default tail
// must be [^}]* (not .*): a greedy tail matches across `}` and swallows
// everything up to the LAST brace in the value, so `${A:-x} and ${B}` would
// read as one reference.
const BARE_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(:-[^}]*)?\}/g;
const CURSOR_REF = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;
const HAS_CURSOR_SYNTAX = /\$\{env:[^}]+\}/;

// Any env var reference — matches ${VAR}, ${env:VAR}, and ${{ secrets.VAR }}
const ANY_ENV_REF = /\$\{\{[^}]*\}\}|\$\{[^}]+\}/g;

/**
 * Variables a client resolves itself in MCP config values. In those clients
 * a bare `${name}` is not an env reference: not wrong syntax, not "unset",
 * and must never be rewritten to `${env:name}`.
 *
 * - Cursor (docs: Config interpolation): userHome, workspaceFolder,
 *   workspaceFolderBasename, pathSeparator (and `${/}`, which no identifier
 *   pattern here matches).
 * - VS Code: its predefined-variables reference, which mcp.json supports.
 *
 * Windsurf has no documented built-in variables this linter knows of, so it
 * gets none.
 */
const CLIENT_BUILTIN_VARS: Partial<Record<McpClient, ReadonlySet<string>>> = {
  cursor: new Set(['userHome', 'workspaceFolder', 'workspaceFolderBasename', 'pathSeparator']),
  vscode: new Set([
    'userHome',
    'workspaceFolder',
    'workspaceFolderBasename',
    'file',
    'fileWorkspaceFolder',
    'relativeFile',
    'relativeFileDirname',
    'fileBasename',
    'fileBasenameNoExtension',
    'fileExtname',
    'fileDirname',
    'fileDirnameBasename',
    'cwd',
    'lineNumber',
    'selectedText',
    'execPath',
    'pathSeparator',
    'defaultBuildTask',
  ]),
};

function isBuiltin(client: McpClient, name: string): boolean {
  return CLIENT_BUILTIN_VARS[client]?.has(name) ?? false;
}

/**
 * The env-var reference syntax a client expands, for producers that write a
 * reference into a config (mcp-env's own fixes, mcp-security's
 * replace-the-secret fixes). Returns null for clients that do not interpolate
 * env references at all (Claude Desktop, Amazon Q, Cline): a fix there would
 * replace a working value with a literal string.
 */
export function formatEnvRef(client: McpClient, varName: string): string | null {
  switch (client) {
    case 'claude-code':
      return `\${${varName}}`;
    case 'cursor':
    case 'windsurf':
    case 'vscode':
      return `\${env:${varName}}`;
    case 'continue':
      return `\${{ secrets.${varName} }}`;
    default:
      return null;
  }
}

interface EnvVarRef {
  varName: string;
  fullMatch: string;
  hasDefault: boolean;
}

function extractEnvVarRefs(value: string): EnvVarRef[] {
  const refs: EnvVarRef[] = [];
  let match;

  ANY_ENV_REF.lastIndex = 0;
  while ((match = ANY_ENV_REF.exec(value)) !== null) {
    const full = match[0];
    // Parse out the variable name from various syntaxes
    let varName: string | null = null;
    let hasDefault = false;

    const cursorMatch = full.match(/^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/);
    if (cursorMatch) {
      varName = cursorMatch[1];
    }

    const continueMatch = full.match(/^\$\{\{\s*secrets\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/);
    if (continueMatch) {
      varName = continueMatch[1];
    }

    const claudeMatch = full.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)(:-[^}]*)?\}$/);
    if (!varName && claudeMatch) {
      varName = claudeMatch[1];
      hasDefault = claudeMatch[2] !== undefined;
    }

    if (varName) {
      refs.push({ varName, fullMatch: full, hasDefault });
    }
  }

  return refs;
}

interface LocatedValue {
  value: string;
  /** Path of the value inside the server object, for locateServerValue. */
  path: (string | number)[];
}

function collectAllStringValues(server: McpServerEntry): LocatedValue[] {
  const values: LocatedValue[] = [];
  if (server.command) values.push({ value: server.command, path: ['command'] });
  server.args?.forEach((value, i) => values.push({ value, path: ['args', i] }));
  if (server.url) values.push({ value: server.url, path: [urlKeyOf(server)] });
  for (const [k, value] of Object.entries(server.headers ?? {})) {
    values.push({ value, path: ['headers', k] });
  }
  for (const [k, value] of Object.entries(server.env ?? {})) {
    values.push({ value, path: ['env', k] });
  }
  return values;
}

/** True when the value holds a bare ${VAR} that is not one of the client's own variables. */
function hasForeignBareRef(value: string, client: McpClient): boolean {
  BARE_REF.lastIndex = 0;
  let m;
  while ((m = BARE_REF.exec(value)) !== null) {
    if (!isBuiltin(client, m[1])) return true;
  }
  return false;
}

export async function checkMcpEnv(
  config: ParsedMcpConfig,
  _projectRoot: string,
): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];

  if (config.parseErrors.length > 0) return issues;

  for (const server of config.servers) {
    const allValues = collectAllStringValues(server);

    // wrong-syntax: check for wrong env var syntax for the client
    for (const located of allValues) {
      const { value } = located;
      let message: string | null = null;

      if (config.client === 'claude-code') {
        // Claude Code expects ${VAR}, flag ${env:VAR}
        if (HAS_CURSOR_SYNTAX.test(value)) {
          message = `Server "${server.name}": Claude Code uses \${VAR}, not \${env:VAR}`;
        }
      }

      if (config.client === 'cursor' || config.client === 'windsurf') {
        // Cursor and Windsurf expect ${env:VAR}, flag bare ${VAR} -- except
        // the client's own built-in variables (${workspaceFolder}, ...).
        // Per-reference: one correct ref elsewhere in the value must not
        // suppress flagging an incorrect one next to it.
        if (hasForeignBareRef(value, config.client)) {
          const clientName = config.client === 'cursor' ? 'Cursor' : 'Windsurf';
          message = `Server "${server.name}": ${clientName} uses \${env:VAR}, not \${VAR}`;
        }
      }

      if (config.client === 'continue') {
        // Continue expects ${{ secrets.VAR }}, flag other syntaxes.
        // Per-reference for the same reason as above: a correct
        // ${{ secrets.VAR }} in the value must not mask a bare ${VAR}.
        if (hasForeignBareRef(value, config.client) || HAS_CURSOR_SYNTAX.test(value)) {
          message = `Server "${server.name}": Continue uses \${{ secrets.VAR }}, not \${VAR}`;
        }
      }

      if (message) {
        const loc = locateServerValue(config, server, located.path);
        const fixes = loc ? buildSyntaxFixes(config, loc) : [];
        if (fixes.length === 0) {
          issues.push({
            severity: 'error',
            check: 'mcp-env',
            ruleId: 'mcp-env/wrong-syntax',
            line: loc?.line ?? server.line,
            message,
          });
        }
        // One issue per wrong reference, each fix touching only that ref: a
        // whole-value fix carried every literal beside the refs (a key in a
        // query param, a header prefix) in its oldText.
        for (const fix of fixes) {
          issues.push({
            severity: 'error',
            check: 'mcp-env',
            ruleId: 'mcp-env/wrong-syntax',
            line: fix.line,
            message: `${message} (${fix.oldText})`,
            fix,
          });
        }
      }
    }

    // unset-variable: check if referenced env vars are set.
    // Skip for Continue — its ${{ secrets.VAR }} refs resolve from Continue's
    // own secrets store (Hub / local .env), not this shell's process.env, so
    // every correct Continue config would false-positive here.
    //
    // NOTE (host-state-dependent, intentional): this tests `ref.varName in
    // process.env` of the machine running the linter, so a project .mcp.json
    // referencing an unexported var emits this for everyone who hasn't set it
    // locally — that is the normal state, which is why the finding stays at
    // `info` severity. It also scans ALL collected string values (env, url,
    // command, args, headers via collectAllStringValues), so a ${VAR} embedded
    // in a url or command is treated as an env reference too. Both are
    // deliberate. A ${VAR:-default} is satisfied by its default, and a
    // client's built-in variable is not an env var at all.
    if (config.client !== 'continue') {
      for (const { value } of allValues) {
        for (const ref of extractEnvVarRefs(value)) {
          if (ref.hasDefault) continue;
          if (!ref.fullMatch.startsWith('${env:') && isBuiltin(config.client, ref.varName)) {
            continue;
          }
          if (!(ref.varName in process.env)) {
            issues.push({
              severity: 'info',
              check: 'mcp-env',
              ruleId: 'mcp-env/unset-variable',
              line: server.line,
              message: `Server "${server.name}": environment variable "${ref.varName}" is not set`,
            });
          }
        }
      }
    }

    // empty-env-block
    if (server.env && Object.keys(server.env).length === 0) {
      issues.push({
        severity: 'info',
        check: 'mcp-env',
        ruleId: 'mcp-env/empty-env-block',
        line: server.line,
        message: `Server "${server.name}": empty "env" block can be removed`,
      });
    }
  }

  return issues;
}

/**
 * One fix per reference in the located string literal that is not in the
 * client's own syntax, each rewriting ONLY that reference: oldText is the ref
 * itself (`${WORKSPACE}`), never the whole value, so a literal credential
 * beside it (`?api_key=<literal>&ws=${WORKSPACE}`) is never carried in a fix.
 *
 * Offsets are taken in the literal's raw source text (between the quotes), so
 * oldText matches the file byte for byte even when the value contains JSON
 * escapes. `loc.column` is the 1-based column of the opening quote, and the
 * fixer's column is 1-based too, so a ref at raw offset `i` sits at column
 * `loc.column + 1 + i` -- on the value's own line, which on pretty-printed
 * JSON is below the server's `"name": {` line.
 *
 * The default tail in the ref regexes is [^}]* so a `:-default` can never
 * span past its own closing brace -- greedy `.*` turned `${A:-x} and ${B}`
 * into the single replacement `${env:A}`, destroying the literal text and the
 * second reference. A `:-default` is dropped from the converted ref: neither
 * ${env:VAR} nor ${{ secrets.VAR }} has a default form. A client's built-in
 * variables are left alone.
 */
function buildSyntaxFixes(
  config: ParsedMcpConfig,
  loc: { line: number; column: number; text: string },
): FixAction[] {
  if (loc.text.length < 2 || !loc.text.startsWith('"')) return [];
  const raw = loc.text.slice(1, -1);
  const client = config.client;
  const patterns: RegExp[] = [];

  if (client === 'claude-code') {
    // Convert ${env:VAR} to ${VAR}
    patterns.push(CURSOR_REF);
  } else if (client === 'cursor' || client === 'windsurf' || client === 'continue') {
    if (client === 'continue') patterns.push(CURSOR_REF);
    // Convert ${VAR} to the client's syntax (the pattern can't match an
    // existing ${env:VAR} -- 'env:' fails the var-name character class)
    patterns.push(BARE_REF);
  } else {
    return [];
  }

  const fixes: FixAction[] = [];
  for (const re of patterns) {
    // matchAll starts at the shared regex's lastIndex, which an early return
    // in hasForeignBareRef leaves mid-string -- that skipped the first ref.
    re.lastIndex = 0;
    for (const m of raw.matchAll(re)) {
      const name = m[1];
      if (re === BARE_REF && isBuiltin(client, name)) continue;
      const newText = formatEnvRef(client, name)!;
      if (newText === m[0]) continue;
      fixes.push({
        file: config.filePath,
        line: loc.line,
        column: loc.column + 1 + m.index,
        oldText: m[0],
        newText,
      });
    }
  }
  return fixes.sort((a, b) => a.column! - b.column!);
}
