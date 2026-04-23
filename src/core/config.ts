import * as fs from 'node:fs';
import * as path from 'node:path';
import levenshteinPkg from 'fast-levenshtein';
const levenshtein = levenshteinPkg.get;
import type { CheckName } from './types.js';

export interface CtxlintConfig {
  checks?: CheckName[];
  ignore?: CheckName[];
  strict?: boolean;
  tokenThresholds?: {
    info?: number;
    warning?: number;
    error?: number;
    aggregate?: number;
    tierBreakdown?: number;
    tierAggregate?: number;
  };
  contextFiles?: string[];
  mcp?: boolean;
  mcpOnly?: boolean;
  mcpGlobal?: boolean;
  mcph?: boolean;
  mcphOnly?: boolean;
  mcphGlobal?: boolean;
  mcphStrictEnvToken?: boolean;
  session?: boolean;
  sessionOnly?: boolean;
}

const KNOWN_CONFIG_KEYS: Array<keyof CtxlintConfig> = [
  'checks',
  'ignore',
  'strict',
  'tokenThresholds',
  'contextFiles',
  'mcp',
  'mcpOnly',
  'mcpGlobal',
  'mcph',
  'mcphOnly',
  'mcphGlobal',
  'mcphStrictEnvToken',
  'session',
  'sessionOnly',
];

const CONFIG_FILENAMES = ['.ctxlintrc', '.ctxlintrc.json'];

/**
 * Produce a more actionable error from JSON.parse. Tries in order:
 *  1. If the error message has "position N" (older Node), convert to line/col.
 *  2. If Node 21+ format ("line L column C" already baked in), pass through.
 *  3. Otherwise attempt a binary-search narrow-down to find the first char
 *     that breaks parsing, and report that position as line/col.
 */
function formatJsonError(content: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);

  // Case 1: explicit "position N" in the message.
  const posMatch = msg.match(/position (\d+)/);
  if (posMatch) {
    return `${msg} (${posToLineCol(content, Number(posMatch[1]))})`;
  }

  // Case 2: message already contains line/col.
  if (/line \d+/.test(msg)) return msg;

  // Case 3: extract the error-context snippet from Node's message and find it
  // in the source to derive an approximate line/col.
  const pos = findFirstErrorPos(content, msg);
  if (pos !== null) {
    return `${msg} (${posToLineCol(content, pos)})`;
  }
  return msg;
}

function posToLineCol(content: string, pos: number): string {
  let line = 1;
  let col = 1;
  for (let i = 0; i < pos && i < content.length; i++) {
    if (content[i] === '\n') {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return `line ${line}, column ${col}`;
}

function findFirstErrorPos(content: string, errMsg: string): number | null {
  // Node 22's JSON.parse error format: "Unexpected token X, "...snippet..."
  // is not valid JSON". Extract the snippet and locate it in the source.
  const snippetMatch = errMsg.match(/\.\.\."([^"]+(?:"[^"]*)*?)"\s+is not valid JSON/);
  if (snippetMatch) {
    const snippet = snippetMatch[1];
    // The snippet may contain escaped quotes; take the first distinctive run
    // of non-whitespace chars and find it in content.
    const needle = snippet.split(/\s/).find((s) => s.length > 1);
    if (needle) {
      const idx = content.indexOf(needle);
      if (idx !== -1) return idx;
    }
  }
  // Fallback: if Node reports the unexpected token directly, find it.
  const tokenMatch = errMsg.match(/Unexpected token\s+['"]?([^'",]+?)['"]?,/);
  if (tokenMatch) {
    const tok = tokenMatch[1];
    const idx = content.indexOf(tok);
    if (idx !== -1) return idx;
  }
  return null;
}

/**
 * Return a nearest-match suggestion from the known-key list for an unknown
 * key, if the Levenshtein distance is low enough to be a plausible typo.
 */
function suggestKey(unknown: string): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const known of KNOWN_CONFIG_KEYS) {
    const d = levenshtein(unknown, known);
    if (d < bestDist) {
      bestDist = d;
      best = known;
    }
  }
  // Only suggest when the typo distance is small relative to the key length —
  // avoids "did you mean checks?" for completely unrelated junk like `license`.
  if (best && bestDist <= Math.max(2, Math.floor(unknown.length / 3))) {
    return best;
  }
  return null;
}

/**
 * Warn about unknown top-level keys in a parsed config. Goes to stderr so it
 * doesn't pollute JSON / SARIF output on stdout.
 */
function warnUnknownKeys(config: unknown, source: string): void {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return;
  const keys = Object.keys(config as Record<string, unknown>);
  const known = new Set<string>(KNOWN_CONFIG_KEYS as string[]);
  for (const k of keys) {
    if (known.has(k)) continue;
    const hint = suggestKey(k);
    const suggestion = hint ? ` — did you mean "${hint}"?` : '';
    console.error(`Warning: unknown config key "${k}" in ${source}${suggestion}`);
  }
}

function parseConfigContent(content: string, source: string): CtxlintConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`Invalid JSON in ${source}: ${formatJsonError(content, err)}`, {
      cause: err,
    });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `Invalid config in ${source}: expected a JSON object at the root, got ${Array.isArray(parsed) ? 'an array' : typeof parsed}`,
    );
  }
  warnUnknownKeys(parsed, source);
  return parsed as CtxlintConfig;
}

export function loadConfig(projectRoot: string): CtxlintConfig | null {
  for (const filename of CONFIG_FILENAMES) {
    const filePath = path.join(projectRoot, filename);
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue; // file doesn't exist, try next
    }
    return parseConfigContent(content, filePath);
  }
  return null;
}

/**
 * Load a config from an explicit `--config <path>`. Shares the same
 * JSON-error reporting + unknown-key warnings as the auto-discovered path.
 */
export function loadConfigFromExplicitPath(configPath: string): CtxlintConfig {
  let content: string;
  try {
    content = fs.readFileSync(configPath, 'utf-8');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`could not load config from ${configPath}: ${detail}`, { cause: err });
  }
  return parseConfigContent(content, configPath);
}
