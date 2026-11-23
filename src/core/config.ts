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
  /**
   * Globs of context files to drop from the corpus before any check runs.
   * The counterpart to `contextFiles`, which ADDS discovery patterns.
   *
   * Unlike `ignore` / `ignoreRules` / `.ctxlintignore` -- all of which suppress
   * FINDINGS after the fact -- this removes the FILES, so an excluded file is
   * also invisible to the cross-file checks (contradictions, duplicate-content)
   * that compare the discovered set. Those report against the literal
   * `(project)` path and so cannot be silenced by any per-file suppression.
   *
   * The motivating case is a repo whose fixtures are deliberately-broken
   * context files: linting them is noise, but they are not this project's
   * agent context in the first place.
   */
  exclude?: string[];
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
// Exported for the README Config Reference drift test (config.test.ts).
export const KNOWN_CONFIG_KEYS = [
  'checks',
  'ignore',
  'ignoreRules',
  'strict',
  'tokenThresholds',
  'contextFiles',
  'exclude',
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
 *  1. If the message already carries a line/column (current V8 appends
 *     "at position N (line L column C)"), pass it through unchanged --
 *     appending our own would print the location twice.
 *  2. If the message has only "position N" (older Node), convert to line/col.
 *  3. Otherwise locate the error-context snippet Node quotes in the message
 *     and report that position as an approximate line/col.
 */
function formatJsonError(content: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);

  // Case 1: message already contains line/col.
  if (/line \d+,? column \d+/.test(msg)) return msg;

  // Case 2: explicit "position N" in the message.
  const posMatch = msg.match(/position (\d+)/);
  if (posMatch) {
    return `${msg} (${posToLineCol(content, Number(posMatch[1]))})`;
  }

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
  validateConfigShape(parsed as Record<string, unknown>, source);
  warnIgnoreRulePathPatternMisuse(parsed, source);
  return parsed as CtxlintConfig;
}

const STRING_ARRAY_KEYS = ['checks', 'ignore', 'contextFiles', 'exclude'] as const;
const BOOLEAN_KEYS = [
  'strict',
  'mcp',
  'mcpOnly',
  'mcpGlobal',
  'session',
  'sessionOnly',
  'skills',
  'skillsOnly',
  'hooksGlobal',
] as const;
const TOKEN_THRESHOLD_KEYS = [
  'info',
  'warning',
  'error',
  'aggregate',
  'tierBreakdown',
  'tierAggregate',
] as const;
const IGNORE_RULE_STRING_FIELDS = ['match', 'pathPattern', 'reason'] as const;

/**
 * Per-key shape validation. Every value is otherwise cast straight to
 * CtxlintConfig, so a wrong JSON type surfaced far from the config file:
 * `"exclude": "fixtures/**"` crashed with "exclude.some is not a function",
 * `"contextFiles": "DOCS.md"` was spread into single-character globs, and
 * `"ignoreRules": [null]` dereferenced null. Throw here instead, naming the
 * source and the key.
 *
 * Shape only: token threshold SEMANTICS (non-negative, info < warning < error)
 * live in resolveTokenThresholds, which also guards programmatic callers.
 * Check names are not validated against the known set here -- that is
 * left to the consumers that already report unknown check names.
 */
function validateConfigShape(config: Record<string, unknown>, source: string): void {
  const fail = (what: string): never => {
    throw new Error(`Invalid config in ${source}: ${what}`);
  };
  const has = (key: string) => Object.prototype.hasOwnProperty.call(config, key);

  for (const key of STRING_ARRAY_KEYS) {
    if (!has(key)) continue;
    const v = config[key];
    if (!Array.isArray(v) || v.some((item) => typeof item !== 'string')) {
      fail(`"${key}" must be an array of strings`);
    }
  }
  for (const key of BOOLEAN_KEYS) {
    if (has(key) && typeof config[key] !== 'boolean') fail(`"${key}" must be a boolean`);
  }
  if (has('tokenThresholds')) {
    const t = config.tokenThresholds;
    if (t === null || typeof t !== 'object' || Array.isArray(t)) {
      fail('"tokenThresholds" must be an object');
    }
    const known = new Set<string>(TOKEN_THRESHOLD_KEYS);
    for (const [k, v] of Object.entries(t as Record<string, unknown>)) {
      if (!known.has(k)) {
        console.error(`Warning: unknown tokenThresholds key "${k}" in ${source}`);
        continue;
      }
      if (typeof v !== 'number') fail(`"tokenThresholds.${k}" must be a number`);
    }
  }
  if (has('ignoreRules')) {
    const rules = config.ignoreRules;
    if (!Array.isArray(rules)) fail('"ignoreRules" must be an array');
    (rules as unknown[]).forEach((r, i) => {
      if (r === null || typeof r !== 'object' || Array.isArray(r)) {
        fail(`"ignoreRules[${i}]" must be an object`);
      }
      const rec = r as Record<string, unknown>;
      if (typeof rec.check !== 'string') fail(`"ignoreRules[${i}].check" must be a string`);
      for (const field of IGNORE_RULE_STRING_FIELDS) {
        if (rec[field] !== undefined && typeof rec[field] !== 'string') {
          fail(`"ignoreRules[${i}].${field}" must be a string`);
        }
      }
    });
  }
}

/**
 * Warn when an `ignoreRules` entry sets `pathPattern` for any check other
 * than `session-stale-memory`. The apply logic in `applyIgnoreRules`
 * (ignore-rules.ts, the `pathPattern` branch) short-circuits on the check mismatch -- the rule silently never fires, so
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
    } catch (err) {
      // Only "not there" means "try the next name". Anything else (EACCES, an
      // EISDIR directory named .ctxlintrc, EIO) is a config the user meant to
      // apply that we cannot read -- silently linting with defaults would hide
      // it.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`could not read config ${filePath}: ${detail}`, { cause: err });
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
