import * as fs from 'node:fs';
import * as path from 'node:path';
import { countTokens } from '../../utils/tokens.js';
import { getTokenThresholds } from './tokens.js';
import type { ParsedContextFile, LintIssue, Section } from '../types.js';

// Files that Claude Code (and similar agents) load into every session by
// default — the "always-loaded" tier. See docs/research/context-hierarchy.md
// §Q2 for sources (code.claude.com/docs/en/memory).
const ALWAYS_LOADED_BASENAMES = new Set([
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
  'copilot-instructions.md',
  'guidelines.md',
  'instructions.md',
]);

const TOP_SECTIONS_TO_REPORT = 3;

/**
 * Quick frontmatter probe — returns true if the file has YAML frontmatter
 * containing a non-empty `paths:` field. Path-scoped rules files are
 * on-demand (loaded only when a path matches), so should be excluded from
 * always-loaded accounting.
 */
function hasPathsFrontmatter(content: string): boolean {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return false;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') return false;
    // `paths:` can be inline ("paths: '**/*.ts'") or lead a YAML array.
    const match = line.match(/^paths\s*:\s*(.*)$/);
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

export function isAlwaysLoaded(file: ParsedContextFile): boolean {
  const rel = file.relativePath.replace(/\\/g, '/');

  // `.mdc` (Cursor) and `.github/instructions/*` are always path-scoped per their client specs.
  if (rel.endsWith('.mdc')) return false;
  if (rel.startsWith('.github/instructions/')) return false;

  // Rules directories — check frontmatter. Rules *without* a `paths` field
  // are always-loaded (per Anthropic docs). With `paths`, they're scoped.
  if (rel.includes('/rules/')) {
    return !hasPathsFrontmatter(file.content);
  }

  const basename = rel.split('/').pop() ?? '';
  return ALWAYS_LOADED_BASENAMES.has(basename);
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
 * (NEVER / ALWAYS / DO NOT / MUST NOT) paired with a concrete backticked
 * command. These are candidates for hook-based enforcement; without a hook
 * the agent may still run the command anyway (rules are advisory — see
 * code.claude.com/docs/en/memory: "there's no guarantee of strict
 * compliance, especially for vague or conflicting instructions").
 */
const INVIOLABLE_FRAMING = /\b(NEVER|ALWAYS|DON'?T|DO NOT|MUST NOT)\b/i;
const COMMAND_IN_BACKTICKS = /`([^`]+)`/g;

interface Settings {
  permissions?: { deny?: string[]; ask?: string[] };
  hooks?: {
    PreToolUse?: Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>;
  };
}

function loadSettingsSources(projectRoot: string): Settings[] {
  const sources: Settings[] = [];
  const candidates = [
    path.join(projectRoot, '.claude', 'settings.json'),
    path.join(projectRoot, '.claude', 'settings.local.json'),
    path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude', 'settings.json'),
  ];
  for (const p of candidates) {
    try {
      const content = fs.readFileSync(p, 'utf-8');
      sources.push(JSON.parse(content) as Settings);
    } catch {
      // missing or unparseable — skip silently
    }
  }
  return sources;
}

function commandIsEnforced(cmd: string, settings: Settings[]): boolean {
  const lower = cmd.toLowerCase();
  for (const s of settings) {
    for (const entry of s.permissions?.deny ?? []) {
      if (entry.toLowerCase().includes(lower)) return true;
    }
    for (const h of s.hooks?.PreToolUse ?? []) {
      if ((h.matcher || '').toLowerCase().includes(lower)) return true;
      for (const sub of h.hooks ?? []) {
        if ((sub.command || '').toLowerCase().includes(lower)) return true;
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
    if (!INVIOLABLE_FRAMING.test(line)) continue;
    COMMAND_IN_BACKTICKS.lastIndex = 0;
    const matches = [...line.matchAll(COMMAND_IN_BACKTICKS)].map((m) => m[1]);
    // Heuristic: first backticked token on the line that looks like a shell command
    const cmd = matches.find((m) => /^[\w.-][\w\s.-]*/.test(m) && !m.includes('/'));
    if (!cmd) continue;
    if (commandIsEnforced(cmd, settings)) continue;
    issues.push({
      severity: 'info',
      check: 'tier-tokens',
      ruleId: 'tier-tokens/hard-enforcement-missing',
      line: i + 1,
      message: `Inviolable framing ("${line.trim().slice(0, 80)}") without a hook to back it up`,
      suggestion: `Rules in always-loaded files are advisory. For "${cmd}", add a PreToolUse hook (or permissions.deny entry) in .claude/settings.json so the command is physically blocked.`,
    });
  }
  return issues;
}

export async function checkTierTokens(
  file: ParsedContextFile,
  projectRoot: string,
): Promise<LintIssue[]> {
  if (!isAlwaysLoaded(file)) return [];

  const issues: LintIssue[] = [];
  const threshold = getTokenThresholds().tierBreakdown;

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
  const settings = loadSettingsSources(projectRoot);
  issues.push(...checkHardEnforcement(file, settings));

  return issues;
}

/**
 * Cross-file: sum tokens across always-loaded context files.
 * Emits a single warning when the combined budget exceeds the tierAggregate
 * threshold.
 */
export function checkAggregateTierTokens(files: ParsedContextFile[]): LintIssue | null {
  const alwaysLoaded = files.filter(isAlwaysLoaded);
  if (alwaysLoaded.length < 2) return null;

  const total = alwaysLoaded.reduce((sum, f) => sum + f.totalTokens, 0);
  const threshold = getTokenThresholds().tierAggregate;
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
