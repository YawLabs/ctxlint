import { countTokens } from '../../utils/tokens.js';
import type { ParsedContextFile, LintIssue, Section } from '../types.js';

// Files that Claude Code (and similar agents) load into every session by
// default — the "always-loaded" tier. Rules files in `rules/` directories,
// `.mdc` files, and `.github/instructions/*` are path-scoped on-demand and
// excluded below. See docs/research/context-hierarchy.md §Q2 for sources.
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

const DEFAULT_SECTION_BREAKDOWN_THRESHOLD = 1000;
const TOP_SECTIONS_TO_REPORT = 3;

function isAlwaysLoaded(file: ParsedContextFile): boolean {
  const rel = file.relativePath.replace(/\\/g, '/');
  if (rel.includes('/rules/')) return false;
  if (rel.endsWith('.mdc')) return false;
  if (rel.startsWith('.github/instructions/')) return false;

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

  // Prefer H2 as the demotion unit (most common heading level for top-level
  // sections in CLAUDE.md / AGENTS.md). Fall back to H1 if no H2 exists.
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

export async function checkTierTokens(file: ParsedContextFile): Promise<LintIssue[]> {
  if (!isAlwaysLoaded(file)) return [];
  if (file.totalTokens < DEFAULT_SECTION_BREAKDOWN_THRESHOLD) return [];

  const sectionCosts = computeSectionCosts(file);
  if (sectionCosts.length === 0) return [];

  const top = sectionCosts.slice(0, TOP_SECTIONS_TO_REPORT);
  const heaviest = top[0];
  const pct = Math.round((heaviest.tokens / file.totalTokens) * 100);

  const detail = top
    .map((s) => `  - "${s.title}" (L${s.line}): ~${s.tokens.toLocaleString()} tokens`)
    .join('\n');

  return [
    {
      severity: 'info',
      check: 'tier-tokens',
      ruleId: 'tier-tokens/section-breakdown',
      line: heaviest.line,
      message: `${file.totalTokens.toLocaleString()} tokens loaded every session — heaviest top-level section${top.length === 1 ? '' : 's'}:`,
      detail,
      suggestion: `"${heaviest.title}" is ~${heaviest.tokens.toLocaleString()} tokens (${pct}% of file). Consider demoting to an on-demand tier (skill, subagent, or memory) so it loads only when relevant.`,
    },
  ];
}
