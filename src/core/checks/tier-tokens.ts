import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse as parseJsonc, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { countTokens } from '../../utils/tokens.js';
import { stripBom } from '../../utils/fs.js';
import { DEFAULT_TOKEN_THRESHOLDS, type TokenThresholds } from './tokens.js';
import type { ParsedContextFile, LintIssue, Section } from '../types.js';

// Files that Claude Code (and similar agents) load into every session by
// default -- the "always-loaded" tier. See docs/research/context-hierarchy.md
// Q2 for sources (code.claude.com/docs/en/memory).
//
// Two match shapes:
//   bare basename -- matches at any depth (e.g. "CLAUDE.md" anywhere)
//   "parent/basename" suffix -- only matches when the file actually lives
//                                under that parent dir (handles generic names
//                                like "instructions.md" / "guidelines.md"
//                                that are tool-specific only inside .goose/ /
//                                .junie/, NOT in arbitrary docs/api/ paths)
const ALWAYS_LOADED_NAMES: readonly string[] = [
  'CLAUDE.md',
  'CLAUDE.local.md',
  'AGENTS.md',
  'AGENTS.override.md',
  'AGENT.md',
  'GEMINI.md',
  '.cursorrules',
  '.windsurfrules',
  '.clinerules',
  '.aiderules',
  '.continuerules',
  '.rules',
  '.goosehints',
  'replit.md',
  '.github/copilot-instructions.md',
  '.junie/guidelines.md',
  '.junie/AGENTS.md',
  '.goose/instructions.md',
];

const TOP_SECTIONS_TO_REPORT = 3;

/**
 * Quick frontmatter probe — returns true if the file has YAML frontmatter
 * containing a non-empty list-valued field. `paths:` is the .claude/rules
 * scoping convention; `globs:` is the Cursor/Windsurf one. Scoped rules
 * files are on-demand (loaded only when a path matches), so should be
 * excluded from always-loaded accounting.
 */
function hasFrontmatterList(content: string, field: string): boolean {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return false;
  const fieldPattern = new RegExp(`^${field}\\s*:\\s*(.*)$`);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') return false;
    // The field can be inline ("paths: '**/*.ts'") or lead a YAML array.
    const match = line.match(fieldPattern);
    if (match) {
      const val = match[1].trim();
      if (val && val !== '[]') return true;
      // Empty inline — check the next non-blank line for a `- item` array entry.
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j];
        if (next.trim() === '---') return false;
        if (next.trim() === '') continue;
        if (next.trim().startsWith('- ')) return true;
        break;
      }
    }
  }
  return false;
}

/**
 * Inline scalar frontmatter field value (e.g. `trigger: glob` -> "glob"),
 * stripped of surrounding quotes. Null when the frontmatter or field is
 * absent or the value is empty.
 */
function frontmatterScalar(content: string, field: string): string | null {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return null;
  const fieldPattern = new RegExp(`^${field}\\s*:\\s*(.*)$`);
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') return null;
    const match = lines[i].match(fieldPattern);
    if (match) return match[1].trim().replace(/^['"]|['"]$/g, '') || null;
  }
  return null;
}

export function isAlwaysLoaded(file: ParsedContextFile): boolean {
  const rel = file.relativePath.replace(/\\/g, '/');

  // `.mdc` (Cursor) and `.github/instructions/*` are always path-scoped per their client specs.
  if (rel.endsWith('.mdc')) return false;
  if (rel.startsWith('.github/instructions/')) return false;

  // Rules directories — check frontmatter. Rules *without* a scoping field
  // are always-loaded (per Anthropic docs). Path/glob-scoped rules load on
  // demand whatever the host: `paths:` is the .claude/rules convention,
  // `globs:` the Cursor/Windsurf one.
  if (rel.includes('/rules/')) {
    if (hasFrontmatterList(file.content, 'paths')) return false;
    if (hasFrontmatterList(file.content, 'globs')) return false;
    // Windsurf rules carry an explicit activation mode; only always_on loads
    // every session (glob / manual / model_decision are on-demand).
    if (rel.includes('.windsurf/rules/')) {
      const trigger = frontmatterScalar(file.content, 'trigger');
      if (trigger && trigger.toLowerCase() !== 'always_on') return false;
    }
    return true;
  }

  const basename = rel.split('/').pop() ?? '';
  for (const name of ALWAYS_LOADED_NAMES) {
    if (name.includes('/')) {
      // Suffix match -- the file's parent dir must match the required parent.
      if (rel === name || rel.endsWith('/' + name)) return true;
    } else if (basename === name) {
      return true;
    }
  }
  return false;
}

interface SectionCost {
  title: string;
  line: number;
  tokens: number;
}

function computeSectionCosts(file: ParsedContextFile): SectionCost[] {
  if (file.sections.length === 0) return [];
  const hasH2 = file.sections.some((s: Section) => s.level === 2);
  const topLevel = hasH2 ? 2 : 1;
  const lines = file.content.split('\n');
  return file.sections
    .filter((s) => s.level === topLevel)
    .map((s) => {
      const body = lines.slice(s.startLine - 1, s.endLine).join('\n');
      return { title: s.title, line: s.startLine, tokens: countTokens(body) };
    })
    .sort((a, b) => b.tokens - a.tokens);
}

/**
 * Detect lines in always-loaded files that use inviolable framing
 * (NEVER / ALWAYS / DO NOT / MUST NOT) paired — in the same sentence — with
 * a concrete backticked command. These are candidates for hook-based
 * enforcement; without a hook the agent may still run the command anyway
 * (rules are advisory — see code.claude.com/docs/en/memory: "there's no
 * guarantee of strict compliance, especially for vague or conflicting
 * instructions").
 *
 * Same-sentence scoping is critical. An earlier version of this rule fired
 * on "Run `npm test`. Do not commit with failing tests" because both tokens
 * appeared on the same line — but `npm test` was not the object of `Do not`.
 * The sentence boundary (period/exclamation/question mark) eliminates that
 * class of false positive.
 */
const INVIOLABLE_WITH_COMMAND = /\b(NEVER|ALWAYS|DON'?T|DO NOT|MUST NOT)\b[^.!?`]{0,80}`([^`]+)`/i;

interface Settings {
  permissions?: { deny?: string[]; ask?: string[] };
  hooks?: {
    PreToolUse?: Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>;
  };
}

// Cache parsed settings per projectRoot. checkTierTokens runs once PER
// always-loaded file, so without this the read+parse (and, crucially, the
// malformed-settings console.warn) would fire N times for one settings.json.
// Caching collapses that to one parse + at most one warn per (root, audit
// run). The cache key includes a stat fingerprint of the candidate files so
// a long-running process (MCP server, --watch) that edits settings.json
// between audits is never served pre-edit results — without it, adding the
// suggested deny entry and re-auditing in the same session would still
// report hard-enforcement-missing. Resettable for tests.
let settingsCache: {
  root: string;
  includeGlobal: boolean;
  fingerprint: string;
  data: Settings[];
} | null = null;

function fingerprintFiles(paths: string[]): string {
  return paths
    .map((p) => {
      try {
        const st = fs.statSync(p);
        return `${st.mtimeMs}:${st.size}`;
      } catch {
        return 'absent';
      }
    })
    .join('|');
}

function loadSettingsSources(projectRoot: string, includeGlobal: boolean): Settings[] {
  const candidates = [
    path.join(projectRoot, '.claude', 'settings.json'),
    path.join(projectRoot, '.claude', 'settings.local.json'),
  ];
  // The user-global ~/.claude/settings.json is opt-in (includeGlobal), mirroring
  // hook-coverage's --hooks-global gate and its os.homedir() resolution (the
  // two checks must agree on which file "the user-global settings" means). On
  // a default project-scoped run we do NOT consult personal global settings,
  // so a teammate's private deny/hook can't silently suppress a
  // hard-enforcement-missing finding that wouldn't reproduce for anyone else.
  if (includeGlobal) {
    candidates.push(path.join(os.homedir(), '.claude', 'settings.json'));
  }

  const fingerprint = fingerprintFiles(candidates);
  if (
    settingsCache?.root === projectRoot &&
    settingsCache.includeGlobal === includeGlobal &&
    settingsCache.fingerprint === fingerprint
  ) {
    return settingsCache.data;
  }

  const sources: Settings[] = [];
  for (const p of candidates) {
    let content: string;
    try {
      content = stripBom(fs.readFileSync(p, 'utf-8'));
    } catch {
      // Missing file is expected — not every repo has .claude/settings.json.
      continue;
    }
    // Parse with the same leniency hook-coverage uses (jsonc, trailing commas
    // allowed) so the two settings consumers never disagree about whether the
    // same file is readable. Genuinely malformed settings silently skipped
    // would mean tier-tokens reports "no hook enforcement" even when there is
    // one — surface the parse failure on stderr so it's fixable.
    const errors: ParseError[] = [];
    const data = parseJsonc(content, errors, { allowTrailingComma: true }) as Settings | undefined;
    if (errors.length > 0) {
      console.warn(
        `ctxlint: could not parse ${p}: ${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}`,
      );
      continue;
    }
    if (!data || typeof data !== 'object') continue;
    sources.push(data);
  }
  settingsCache = { root: projectRoot, includeGlobal, fingerprint, data: sources };
  return sources;
}

/** Clear the per-root settings cache. Call between audit runs / in tests. */
export function resetSettingsCache(): void {
  settingsCache = null;
}

/**
 * Strip flags after a `--` delimiter and normalize whitespace so we compare
 * "the command" regardless of trailing flag variations. E.g. `npm publish
 * --access public` reduces to `npm publish`.
 */
function canonicalizeCommand(backticked: string): string {
  const beforeFlags = backticked.trim().split(/\s+--?/, 1)[0];
  return beforeFlags.replace(/\s+/g, ' ');
}

/**
 * Build a regex that matches a command against settings entries tolerantly.
 *
 * The trick is that `\b` treats `_` and digits as word chars but `-` as a
 * non-word char. That asymmetry means naive `\b`-anchored matching is
 * wrong in both directions:
 *
 *  - For multi-token commands: `\bnpm login\b` does not match
 *    `block_npm_login.py` (no boundary between `_` and `n`) AND does not
 *    match `block-npm-login.sh` (the literal space between tokens is
 *    missing). Both are real hook script naming styles we want to credit.
 *  - For single-token commands: `\brm\b` falsely matches
 *    `npm run rm-old-logs` (boundary on each side of `rm`, since `-` is
 *    non-word), silently suppressing a real enforcement-missing warning.
 *
 * Strategy:
 *
 *  - Tokens of multi-token commands are joined with `[\s\-_]+` so the
 *    body matches all three forms (`npm login`, `npm-login`, `npm_login`).
 *  - Boundary on each end is a manual lookaround `(?<![A-Za-z0-9])` /
 *    `(?![A-Za-z0-9])`. Letters and digits flanking the match still kill
 *    it (so `pnpm` still doesn't match `npm`, `loginx` doesn't match
 *    `login`), but `_` and `-` are *allowed* on the boundary, which lets
 *    `block_npm_login.py` and `block-npm-login.sh` match.
 *  - For single-token commands, we additionally exclude `_` and `-` from
 *    the boundary class so `rm` stays out of `rm-old-logs` / `block_rm`.
 *    We give up on matching `block-rm.sh` (a hook script for `rm`) — those
 *    are rare in practice (deny-list entries are the common form) and the
 *    `rm-old-logs` false negative is the higher-cost bug.
 */
function buildCommandPattern(cmd: string): RegExp {
  const tokens = cmd.split(/\s+/).filter(Boolean);
  const escaped = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (tokens.length === 1) {
    return new RegExp(`(?<![A-Za-z0-9_\\-])${escaped[0]}(?![A-Za-z0-9_\\-])`, 'i');
  }
  const body = escaped.join('[\\s\\-_]+');
  return new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, 'i');
}

function commandIsEnforced(cmd: string, settings: Settings[]): boolean {
  const pattern = buildCommandPattern(cmd);
  for (const s of settings) {
    // deny physically blocks; ask gates behind a human prompt. Both are
    // non-advisory (the agent can't just proceed), so both count as
    // enforcement — ask is the weaker form but still a hard gate.
    for (const entry of [...(s.permissions?.deny ?? []), ...(s.permissions?.ask ?? [])]) {
      if (pattern.test(entry)) return true;
    }
    for (const h of s.hooks?.PreToolUse ?? []) {
      if (pattern.test(h.matcher || '')) return true;
      for (const sub of h.hooks ?? []) {
        if (pattern.test(sub.command || '')) return true;
      }
    }
  }
  return false;
}

function checkHardEnforcement(file: ParsedContextFile, settings: Settings[]): LintIssue[] {
  const issues: LintIssue[] = [];
  const lines = file.content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match inviolable framing + backticked command within the same sentence
    // (no .!? between them). Limits false positives and scans the full
    // command content — no `/`-exclusion that previously dropped `./release.sh`.
    const match = line.match(INVIOLABLE_WITH_COMMAND);
    if (!match) continue;
    const cmd = canonicalizeCommand(match[2]);
    if (!cmd) continue;
    if (commandIsEnforced(cmd, settings)) continue;
    // Blocking only makes sense for prohibitive framing (NEVER / DO NOT /
    // MUST NOT). An ALWAYS rule wants the inverse: a hook that runs or
    // verifies the command, not one that denies it.
    const suggestion =
      match[1].toUpperCase() === 'ALWAYS'
        ? `Rules in always-loaded files are advisory. For \`${cmd}\`, add a hook in .claude/settings.json (e.g. a PreToolUse or Stop hook that runs or verifies \`${cmd}\`) so the requirement doesn't depend on the agent remembering.`
        : `Rules in always-loaded files are advisory. For \`${cmd}\`, add a PreToolUse hook (or permissions.deny entry) in .claude/settings.json so the command is physically blocked.`;
    issues.push({
      severity: 'info',
      check: 'tier-tokens',
      ruleId: 'tier-tokens/hard-enforcement-missing',
      line: i + 1,
      message: `Inviolable framing ("${line.trim().slice(0, 80)}") without a hook to back it up`,
      suggestion,
    });
  }
  return issues;
}

export async function checkTierTokens(
  file: ParsedContextFile,
  projectRoot: string,
  thresholds: TokenThresholds = DEFAULT_TOKEN_THRESHOLDS,
  includeGlobal = false,
): Promise<LintIssue[]> {
  if (!isAlwaysLoaded(file)) return [];

  const issues: LintIssue[] = [];
  const threshold = thresholds.tierBreakdown;

  // Rule 1: section-breakdown — heaviest top-level sections for large files.
  if (file.totalTokens >= threshold) {
    const sectionCosts = computeSectionCosts(file);
    if (sectionCosts.length > 0) {
      const top = sectionCosts.slice(0, TOP_SECTIONS_TO_REPORT);
      const heaviest = top[0];
      const pct = Math.round((heaviest.tokens / file.totalTokens) * 100);
      const detail = top
        .map((s) => `  - "${s.title}" (L${s.line}): ~${s.tokens.toLocaleString()} tokens`)
        .join('\n');
      issues.push({
        severity: 'info',
        check: 'tier-tokens',
        ruleId: 'tier-tokens/section-breakdown',
        line: heaviest.line,
        message: `${file.totalTokens.toLocaleString()} tokens loaded every session — heaviest top-level section${top.length === 1 ? '' : 's'}:`,
        detail,
        suggestion: `"${heaviest.title}" is ~${heaviest.tokens.toLocaleString()} tokens (${pct}% of file). Consider demoting to an on-demand tier (skill, subagent, or memory) so it loads only when relevant.`,
      });
    }
  }

  // Rule 2: hard-enforcement-missing — inviolable framing without a hook.
  const settings = loadSettingsSources(projectRoot, includeGlobal);
  issues.push(...checkHardEnforcement(file, settings));

  return issues;
}

/**
 * Cross-file: sum tokens across always-loaded context files.
 * Emits a single warning when the combined budget exceeds the tierAggregate
 * threshold.
 */
export function checkAggregateTierTokens(
  files: ParsedContextFile[],
  thresholds: TokenThresholds = DEFAULT_TOKEN_THRESHOLDS,
): LintIssue | null {
  const alwaysLoaded = files.filter(isAlwaysLoaded);
  if (alwaysLoaded.length < 2) return null;

  const total = alwaysLoaded.reduce((sum, f) => sum + f.totalTokens, 0);
  const threshold = thresholds.tierAggregate;
  if (total < threshold) return null;

  const breakdown = alwaysLoaded
    .slice()
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, 5)
    .map((f) => `  - ${f.relativePath}: ~${f.totalTokens.toLocaleString()} tokens`)
    .join('\n');

  return {
    severity: 'warning',
    check: 'tier-tokens',
    ruleId: 'tier-tokens/aggregate',
    line: 0,
    message: `${alwaysLoaded.length} always-loaded files total ${total.toLocaleString()} tokens — loaded every session`,
    detail: breakdown,
    suggestion:
      'Consider moving the largest files or their heaviest sections to on-demand tiers (skills, subagents, memory).',
  };
}
