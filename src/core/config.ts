import * as fs from 'node:fs';
import * as path from 'node:path';
import levenshteinPkg from 'fast-levenshtein';
const levenshtein = levenshteinPkg.get;
import { stripBom } from '../utils/fs.js';
import { offsetToPosition } from '../utils/positions.js';
import type { CheckName } from './types.js';
import type { IgnoreRule } from './ignore-rules.js';

export interface CtxlintConfig {
  checks?: CheckName[];
  ignore?: CheckName[];
  ignoreRules?: IgnoreRule[];
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
  session?: boolean;
  sessionOnly?: boolean;
  skills?: boolean;
  skillsOnly?: boolean;
  hooksGlobal?: boolean;
}

// Bidirectional check between this array and `CtxlintConfig`:
// - `satisfies readonly (keyof CtxlintConfig)[]` -- a typo or removed type key
//   becomes a tsc error here (extra-element rejection).
// - `KnownKeys extends keyof CtxlintConfig ? keyof CtxlintConfig extends KnownKeys ? ...`
//   below makes the type unhappy if a new CtxlintConfig key is added without
//   being listed here -- missing-element rejection. The conditional is the
//   structural way to express "every key in CtxlintConfig must appear in this
//   array's element union".
const KNOWN_CONFIG_KEYS = [
  'checks',
  'ignore',
  'ignoreRules',
  'strict',
  'tokenThresholds',
  'contextFiles',
  'mcp',
  'mcpOnly',
  'mcpGlobal',
  'session',
  'sessionOnly',
  'skills',
  'skillsOnly',
  'hooksGlobal',
] as const satisfies readonly (keyof CtxlintConfig)[];

// Missing-element guard: if CtxlintConfig gains a key that isn't in
// KNOWN_CONFIG_KEYS, this assignment fails with "Type X is not assignable to
// type never". Forces the maintainer to add the missing key above.
type _ExhaustiveKnownKeys =
  Exclude<keyof CtxlintConfig, (typeof KNOWN_CONFIG_KEYS)[number]> extends never ? true : never;
const _knownKeysExhaustive: _ExhaustiveKnownKeys = true;
void _knownKeysExhaustive;

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
    // "near": the position comes from a best-effort substring search
    // (findFirstErrorPos), which can land on an earlier identical token, so the
    // line/col is approximate rather than the exact parser-reported site.
    return `${msg} (near ${posToLineCol(content, pos)})`;
  }
  return msg;
}

function posToLineCol(content: string, pos: number): string {
  const { line, column } = offsetToPosition(content, pos);
  return `line ${line}, column ${column}`;
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
  //
  // Threshold: scale by 1/3 of key length for short keys, but CAP at 4. Without
  // the cap, a long key like `tokenThresholds` (15 chars) would accept distance
  // up to 5, which produces surprising "did you mean ...?" hits on genuinely
  // unrelated keys.
  const threshold = Math.min(4, Math.max(2, Math.floor(unknown.length / 3)));
  if (best && bestDist <= threshold) {
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
  const known = new Set<string>(KNOWN_CONFIG_KEYS);
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
  warnIgnoreRulePathPatternMisuse(parsed, source);
  return parsed as CtxlintConfig;
}

/**
 * Warn when an `ignoreRules` entry sets `pathPattern` for any check other
 * than `session-stale-memory`. The apply logic in `ignore-rules.ts:97`
 * short-circuits on the check mismatch -- the rule silently never fires, so
 * the user thinks they've suppressed something they haven't. Surface it at
 * config-load time so the drift is visible immediately.
 */
function warnIgnoreRulePathPatternMisuse(config: unknown, source: string): void {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return;
  const rules = (config as { ignoreRules?: unknown }).ignoreRules;
  if (!Array.isArray(rules)) return;
  for (const r of rules) {
    if (!r || typeof r !== 'object') continue;
    const rec = r as { check?: unknown; pathPattern?: unknown };
    if (typeof rec.pathPattern !== 'string') continue;
    if (rec.check === 'session-stale-memory') continue;
    const checkName = typeof rec.check === 'string' ? rec.check : '<unknown>';
    console.error(
      `Warning: ignoreRule with pathPattern is only honored for "session-stale-memory" (got "${checkName}") in ${source}`,
    );
  }
}

export function loadConfig(projectRoot: string): CtxlintConfig | null {
  for (const filename of CONFIG_FILENAMES) {
    const filePath = path.join(projectRoot, filename);
    let content: string;
    try {
      content = stripBom(fs.readFileSync(filePath, 'utf-8'));
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
    content = stripBom(fs.readFileSync(configPath, 'utf-8'));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`could not load config from ${configPath}: ${detail}`, { cause: err });
  }
  return parseConfigContent(content, configPath);
}
