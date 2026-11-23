import * as fs from 'node:fs';
import * as path from 'node:path';
import { isOutsideRelative } from '../../utils/fs.js';
import type { ParsedContextFile, LintIssue } from '../types.js';

export interface TokenThresholds {
  info: number;
  warning: number;
  error: number;
  aggregate: number;
  tierBreakdown: number;
  tierAggregate: number;
}

export const DEFAULT_TOKEN_THRESHOLDS: TokenThresholds = {
  info: 1000,
  warning: 3000,
  error: 8000,
  aggregate: 5000,
  tierBreakdown: 1000,
  tierAggregate: 4000,
};

const THRESHOLD_KEYS = Object.keys(DEFAULT_TOKEN_THRESHOLDS) as (keyof TokenThresholds)[];

/**
 * Merge user-supplied overrides into DEFAULT_TOKEN_THRESHOLDS.
 *
 * Validation is two-staged so one bad value cannot silently disable a tier:
 *   1. Per key: every supplied value must be a finite, non-negative number. A
 *      string ("2000", which would otherwise compare lexically), NaN, Infinity,
 *      null or a negative number is rejected with a message naming THAT key,
 *      and only that key falls back to its default.
 *   2. Ordering: the resulting per-file tiers must satisfy
 *      info < warning < error; on violation the whole set falls back to
 *      defaults.
 * Config files are shape-checked earlier by config.ts; this guard also covers
 * programmatic callers (runAudit options) that never pass through it.
 *
 * Pure aside from the stderr lines on bad input; safe to call concurrently
 * from independent audit runs.
 *
 * This is the only entry point for resolving thresholds. The previous
 * module-level state (`setTokenThresholds` / `getTokenThresholds`) was
 * removed because long-running hosts (the MCP server) could race on it if
 * audits ever ran concurrently. Threshold resolution now flows through the
 * call chain: caller -> runAudit -> per-check function.
 */
export function resolveTokenThresholds(overrides?: Partial<TokenThresholds>): TokenThresholds {
  if (!overrides) return DEFAULT_TOKEN_THRESHOLDS;
  const merged: TokenThresholds = { ...DEFAULT_TOKEN_THRESHOLDS };
  for (const key of THRESHOLD_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(overrides, key)) continue;
    const value: unknown = overrides[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      const shown = typeof value === 'string' ? `"${value}"` : String(value);
      console.error(
        `Warning: token threshold "${key}" must be a finite non-negative number (got ${shown}) — using the default ${DEFAULT_TOKEN_THRESHOLDS[key]}`,
      );
      continue;
    }
    merged[key] = value;
  }
  if (merged.info >= merged.warning || merged.warning >= merged.error) {
    console.error(
      `Warning: token thresholds should satisfy info < warning < error (got ${merged.info}, ${merged.warning}, ${merged.error}) — using defaults`,
    );
    return DEFAULT_TOKEN_THRESHOLDS;
  }
  return merged;
}

/** Fixed-locale grouping so a finding reads the same on every host ("1,234"). */
function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

export async function checkTokens(
  file: ParsedContextFile,
  _projectRoot: string,
  thresholds: TokenThresholds = DEFAULT_TOKEN_THRESHOLDS,
): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];
  const tokens = file.totalTokens;

  if (tokens >= thresholds.error) {
    issues.push({
      severity: 'error',
      check: 'tokens',
      ruleId: 'tokens/excessive',
      line: 1,
      message: `${fmt(tokens)} tokens — consumes significant context window space`,
      suggestion: 'Consider splitting into focused sections or removing redundant content.',
    });
  } else if (tokens >= thresholds.warning) {
    issues.push({
      severity: 'warning',
      check: 'tokens',
      ruleId: 'tokens/large',
      line: 1,
      message: `${fmt(tokens)} tokens — large context file`,
      suggestion: 'Consider trimming — every token here is loaded into each session.',
    });
  } else if (tokens >= thresholds.info) {
    issues.push({
      severity: 'info',
      check: 'tokens',
      ruleId: 'tokens/info',
      line: 1,
      message: `Uses ~${fmt(tokens)} tokens per session`,
    });
  }

  return issues;
}

export interface AggregateTokenInput {
  path: string;
  tokens: number;
  /** When true and `symlinkTarget` resolves to another counted path, skipped. */
  isSymlink?: boolean;
  /** Raw link target as read by readlink: relative to the link's directory, or absolute. */
  symlinkTarget?: string;
}

/**
 * `files` minus every symlink whose target is another file in the set: the
 * same content under a second name (AGENTS.md -> CLAUDE.md), which would
 * otherwise be counted twice. A relative target is resolved against the
 * link's directory; an ABSOLUTE target (`ln -s "$PWD/CLAUDE.md" AGENTS.md`,
 * `mklink` with a full path) is made project-relative against `projectRoot`
 * as given and its realpath (macOS /tmp -> /private/tmp), so pass the root
 * whenever one is known -- without it only relative targets can be resolved.
 *
 * The single definition behind both summary.totalTokens (audit.ts
 * contextTokenTotal) and tokens/aggregate, so the two never disagree.
 */
export function withoutSymlinkAliases<
  T extends { path: string; isSymlink?: boolean; symlinkTarget?: string },
>(files: ReadonlyArray<T>, projectRoot?: string): T[] {
  // Case-insensitive default filesystems (win32, darwin) fold like the scanner.
  const nocase = process.platform === 'win32' || process.platform === 'darwin';
  const key = (p: string) => {
    const s = p.replace(/\\/g, '/');
    return nocase ? s.toLowerCase() : s;
  };
  const roots = projectRoot ? rootForms(projectRoot) : [];
  const relativeToRoot = (abs: string): string | null => {
    const target = path.resolve(abs.replace(/^\\\\\?\\/, ''));
    for (const r of roots) {
      const rel = path.relative(r, target);
      if (!isOutsideRelative(rel)) return rel.replace(/\\/g, '/');
    }
    return null;
  };
  const counted = new Set(files.map((f) => key(f.path)));
  const kept: T[] = [];
  for (const f of files) {
    if (f.isSymlink && f.symlinkTarget) {
      const target = f.symlinkTarget.replace(/\\/g, '/');
      let resolved: string | null = null;
      if (!path.posix.isAbsolute(target) && !/^[A-Za-z]:/.test(target)) {
        resolved = key(
          path.posix.normalize(
            path.posix.join(path.posix.dirname(f.path.replace(/\\/g, '/')), target),
          ),
        );
      } else {
        const rel = relativeToRoot(f.symlinkTarget);
        if (rel !== null) resolved = key(path.posix.normalize(rel));
      }
      if (resolved !== null && resolved !== key(f.path) && counted.has(resolved)) continue;
    }
    kept.push(f);
  }
  return kept;
}

function rootForms(projectRoot: string): string[] {
  const forms = [path.resolve(projectRoot)];
  try {
    const real = fs.realpathSync(projectRoot);
    if (real !== forms[0]) forms.push(real);
  } catch {
    // root missing (tests pass synthetic roots); the given form is enough
  }
  return forms;
}

export function checkAggregateTokens(
  files: AggregateTokenInput[],
  thresholds: TokenThresholds = DEFAULT_TOKEN_THRESHOLDS,
  projectRoot?: string,
): LintIssue | null {
  const unique = withoutSymlinkAliases(files, projectRoot);
  const total = unique.reduce((sum, f) => sum + f.tokens, 0);
  if (total >= thresholds.aggregate && unique.length > 1) {
    return {
      severity: 'warning',
      check: 'tokens',
      ruleId: 'tokens/aggregate',
      line: 0,
      message: `${unique.length} context files consume ${fmt(total)} tokens combined`,
      suggestion: 'Consider consolidating or trimming to reduce per-session context cost.',
    };
  }
  return null;
}
