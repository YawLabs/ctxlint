import type { ParsedContextFile, LintIssue } from '../types.js';

/**
 * Detects conflicting directives across multiple context files.
 * For example, one file says "use Jest" and another says "use Vitest".
 */

interface DirectiveCategory {
  name: string;
  options: DirectiveOption[];
}

interface DirectiveOption {
  label: string;
  patterns: RegExp[];
}

// Define mutually exclusive directive categories
const DIRECTIVE_CATEGORIES: DirectiveCategory[] = [
  {
    name: 'testing framework',
    options: [
      {
        label: 'Jest',
        // The third pattern bounds the gap between `test` and `with <fw>` to a
        // few intra-clause chars so prose like "run our test suite and then
        // deploy with jest" no longer matches the framework directive — only
        // tight phrasings like "test with jest" / "tests run with jest" do.
        patterns: [/\buse\s+jest\b/i, /\bjest\s+for\s+test/i, /\btest\w*\s+with\s+jest\b/i],
      },
      {
        label: 'Vitest',
        patterns: [/\buse\s+vitest\b/i, /\bvitest\s+for\s+test/i, /\btest\w*\s+with\s+vitest\b/i],
      },
      {
        label: 'Mocha',
        patterns: [/\buse\s+mocha\b/i, /\bmocha\s+for\s+test/i, /\btest\w*\s+with\s+mocha\b/i],
      },
      {
        label: 'pytest',
        patterns: [/\buse\s+pytest\b/i, /\bpytest\s+for\s+test/i, /\btest\w*\s+with\s+pytest\b/i],
      },
      {
        label: 'Playwright',
        patterns: [/\buse\s+playwright\b/i, /\bplaywright\s+for\s+(?:e2e|test)/i],
      },
      { label: 'Cypress', patterns: [/\buse\s+cypress\b/i, /\bcypress\s+for\s+(?:e2e|test)/i] },
    ],
  },
  {
    name: 'package manager',
    options: [
      {
        label: 'npm',
        patterns: [
          /\buse\s+npm\b/i,
          /\bnpm\s+as\s+(?:the\s+)?package\s+manager/i,
          /\balways\s+use\s+npm\b/i,
        ],
      },
      {
        label: 'pnpm',
        patterns: [
          /\buse\s+pnpm\b/i,
          /\bpnpm\s+as\s+(?:the\s+)?package\s+manager/i,
          /\balways\s+use\s+pnpm\b/i,
        ],
      },
      {
        label: 'yarn',
        patterns: [
          /\buse\s+yarn\b/i,
          /\byarn\s+as\s+(?:the\s+)?package\s+manager/i,
          /\balways\s+use\s+yarn\b/i,
        ],
      },
      {
        label: 'bun',
        patterns: [
          /\buse\s+bun\b/i,
          /\bbun\s+as\s+(?:the\s+)?package\s+manager/i,
          /\balways\s+use\s+bun\b/i,
        ],
      },
    ],
  },
  {
    name: 'indentation style',
    options: [
      {
        label: 'tabs',
        patterns: [/\buse\s+tabs\b/i, /\btab\s+indentation\b/i, /\bindent\s+with\s+tabs\b/i],
      },
      {
        label: '2 spaces',
        patterns: [/\b2[\s-]?space\s+indent/i, /\bindent\s+with\s+2\s+spaces/i],
      },
      {
        label: '4 spaces',
        patterns: [/\b4[\s-]?space\s+indent/i, /\bindent\s+with\s+4\s+spaces/i],
      },
    ],
  },
  {
    name: 'semicolons',
    options: [
      {
        label: 'semicolons',
        patterns: [
          /\buse\s+semicolons\b/i,
          /\balways\s+(?:use\s+)?semicolons\b/i,
          /\bsemicolons:\s*(?:true|yes)\b/i,
        ],
      },
      {
        label: 'no semicolons',
        patterns: [
          /\bno\s+semicolons\b/i,
          /\bavoid\s+semicolons\b/i,
          /\bomit\s+semicolons\b/i,
          /\bsemicolons:\s*(?:false|no)\b/i,
        ],
      },
    ],
  },
  {
    name: 'quote style',
    options: [
      {
        label: 'single quotes',
        patterns: [
          /\b(?:use|prefer|enforce|always)\s+single\s+quotes?\b/i,
          /\bsingle\s+quotes?\s+(?:for|only|everywhere|throughout)\b/i,
        ],
      },
      {
        label: 'double quotes',
        patterns: [
          /\b(?:use|prefer|enforce|always)\s+double\s+quotes?\b/i,
          /\bdouble\s+quotes?\s+(?:for|only|everywhere|throughout)\b/i,
        ],
      },
    ],
  },
  {
    name: 'naming convention',
    options: [
      {
        label: 'camelCase',
        patterns: [
          /\b(?:use|prefer|enforce|default to)\s+camelCase\b/i,
          /\bcamel[\s-]?case\s+(?:for|naming|convention)/i,
        ],
      },
      {
        label: 'snake_case',
        patterns: [
          /\b(?:use|prefer|enforce|default to)\s+snake_case\b/i,
          /\bsnake[\s-]?case\s+(?:for|naming|convention)/i,
        ],
      },
      {
        label: 'PascalCase',
        patterns: [
          /\b(?:use|prefer|enforce|default to)\s+PascalCase\b/i,
          /\bpascal[\s-]?case\s+(?:for|naming|convention)/i,
        ],
      },
      {
        label: 'kebab-case',
        patterns: [
          /\b(?:use|prefer|enforce|default to)\s+kebab-case\b/i,
          /\bkebab[\s-]?case\s+(?:for|naming|convention)/i,
        ],
      },
    ],
  },
  {
    name: 'CSS approach',
    options: [
      { label: 'Tailwind', patterns: [/\buse\s+tailwind/i, /\btailwind\s+for\s+styl/i] },
      {
        label: 'CSS Modules',
        patterns: [/\buse\s+css\s+modules\b/i, /\bcss\s+modules\s+for\s+styl/i],
      },
      {
        label: 'styled-components',
        patterns: [/\buse\s+styled[\s-]?components\b/i, /\bstyled[\s-]?components\s+for\s+styl/i],
      },
      { label: 'CSS-in-JS', patterns: [/\buse\s+css[\s-]?in[\s-]?js\b/i] },
    ],
  },
  {
    name: 'state management',
    options: [
      { label: 'Redux', patterns: [/\buse\s+redux\b/i, /\bredux\s+for\s+state/i] },
      { label: 'Zustand', patterns: [/\buse\s+zustand\b/i, /\bzustand\s+for\s+state/i] },
      { label: 'MobX', patterns: [/\buse\s+mobx\b/i, /\bmobx\s+for\s+state/i] },
      { label: 'Jotai', patterns: [/\buse\s+jotai\b/i, /\bjotai\s+for\s+state/i] },
      { label: 'Recoil', patterns: [/\buse\s+recoil\b/i, /\brecoil\s+for\s+state/i] },
    ],
  },
];

interface DetectedDirective {
  file: string;
  category: string;
  label: string;
  line: number;
  text: string;
}

// A directive mention preceded by a negation ("never use yarn", "don't use
// npm") is a prohibition, not an endorsement. Without this guard the banned
// tool registers as a directive label, which both (a) emits a false conflict
// against a file that actually agrees, and (b) can suppress a real conflict:
// the extra label makes another file's labels a subset of this one's, the
// cluster filter drops that file, and `conflictingFiles` falls below 2.
//
// The window is clause-scoped: it looks back NEGATION_WINDOW chars and the
// negation must not be separated from the match by clause punctuation, so
// "Never use yarn; use pnpm" still registers the pnpm endorsement. `n['’]t`
// covers the contraction family (don't / doesn't / won't / shouldn't).
const NEGATION_BEFORE_MATCH = /(?:\b(?:never|not|avoid|stop|instead\s+of)\b|n['’]t\b)[^.;:,!?]*$/i;
const NEGATION_WINDOW = 20;

function isNegated(line: string, matchIndex: number): boolean {
  const windowStart = Math.max(0, matchIndex - NEGATION_WINDOW);
  return NEGATION_BEFORE_MATCH.test(line.slice(windowStart, matchIndex));
}

// Negation is per-occurrence, not per-line: in "Don't use pnpm in CI, use
// pnpm locally." only the first mention is negated (the comma ends the
// negation's clause), so the second is a live endorsement. A single
// non-global exec stops at the first occurrence — if that one happens to be
// negated, the endorsement is dropped and a real cross-file conflict is
// suppressed. Scan every occurrence; ANY non-negated one registers.
function hasUnnegatedMatch(pattern: RegExp, line: string): boolean {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const global = new RegExp(pattern.source, flags);
  let m: RegExpExecArray | null;
  while ((m = global.exec(line)) !== null) {
    if (!isNegated(line, m.index)) return true;
  }
  return false;
}

function detectDirectives(file: ParsedContextFile): DetectedDirective[] {
  const directives: DetectedDirective[] = [];
  const lines = file.content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    for (const category of DIRECTIVE_CATEGORIES) {
      for (const option of category.options) {
        for (const pattern of option.patterns) {
          if (hasUnnegatedMatch(pattern, line)) {
            directives.push({
              file: file.relativePath,
              category: category.name,
              label: option.label,
              line: i + 1,
              text: line.trim(),
            });
            break; // One match per option per line is enough
          }
        }
      }
    }
  }

  return directives;
}

export function checkContradictions(files: ParsedContextFile[]): LintIssue[] {
  if (files.length < 2) return [];

  const issues: LintIssue[] = [];

  // Collect all directives across all files, indexed by (category, file, label)
  // so look-ups during conflict emission are O(1) instead of O(D) via .find().
  const byCategory = new Map<string, DetectedDirective[]>();
  // directiveIndex: category → `${file}::${label}` → DetectedDirective
  const directiveIndex = new Map<string, Map<string, DetectedDirective>>();
  for (const file of files) {
    for (const d of detectDirectives(file)) {
      let list = byCategory.get(d.category);
      if (!list) {
        list = [];
        byCategory.set(d.category, list);
      }
      list.push(d);

      let idx = directiveIndex.get(d.category);
      if (!idx) {
        idx = new Map();
        directiveIndex.set(d.category, idx);
      }
      // Preserve the first-seen directive per (file, label) so line numbers
      // point at the introductory mention rather than a later restatement.
      const key = `${d.file}::${d.label}`;
      if (!idx.has(key)) idx.set(key, d);
    }
  }

  // Find contradictions: same category, different labels across files. Emit
  // one issue per conflict CLUSTER (not all C(N,2) pairs) when a category has
  // 3+ distinct labels across 3+ files — the old behavior spammed quadratic
  // pair issues for what a reader sees as a single cluster.
  for (const [category, directives] of byCategory) {
    const labels = new Set(directives.map((d) => d.label));
    if (labels.size <= 1) continue;

    const fileLabels = new Map<string, Set<string>>();
    for (const d of directives) {
      let existing = fileLabels.get(d.file);
      if (!existing) {
        existing = new Set();
        fileLabels.set(d.file, existing);
      }
      existing.add(d.label);
    }

    // Only files in a TRUE cross-file disagreement are part of the cluster. A
    // file `f` conflicts with another file only when EACH holds a label the
    // other lacks (mutual disagreement) — a directive in `f` that the other
    // file rejects, and vice versa. Requiring it on both sides means a file
    // that merely LISTS multiple options in one category (e.g. "single quotes
    // in TS, double in JSON" => {single, double}) is a SUPERSET of a file that
    // picks just one of them, not a contradiction: the picker's label is
    // already present in the lister, so there is no label the lister lacks.
    const conflictsWith = (a: Set<string>, b: Set<string>): boolean => {
      let aHasExtra = false;
      let bHasExtra = false;
      for (const l of a) if (!b.has(l)) aHasExtra = true;
      for (const l of b) if (!a.has(l)) bHasExtra = true;
      return aHasExtra && bHasExtra;
    };
    const conflictingFiles = [...fileLabels.keys()].filter((f) => {
      const myLabels = fileLabels.get(f)!;
      for (const [otherFile, otherLabels] of fileLabels) {
        if (otherFile === f) continue;
        if (conflictsWith(myLabels, otherLabels)) return true;
      }
      return false;
    });

    if (conflictingFiles.length < 2) continue;

    const idx = directiveIndex.get(category)!;

    if (conflictingFiles.length === 2) {
      // Pair conflict — keep the original (file, label) × (file, label) shape
      // so existing suggestion text still applies naturally.
      const [fileA, fileB] = conflictingFiles;
      const labelsA = fileLabels.get(fileA)!;
      const labelsB = fileLabels.get(fileB)!;
      for (const labelA of labelsA) {
        for (const labelB of labelsB) {
          if (labelA === labelB) continue;
          const directiveA = idx.get(`${fileA}::${labelA}`)!;
          const directiveB = idx.get(`${fileB}::${labelB}`)!;
          issues.push({
            severity: 'warning',
            check: 'contradictions',
            ruleId: 'contradictions/conflict',
            line: directiveA.line,
            message: `${category} conflict: "${directiveA.label}" in ${fileA} vs "${directiveB.label}" in ${fileB}`,
            suggestion: `Align on one ${category} across all context files`,
            detail: `${fileA}:${directiveA.line} says "${directiveA.text}" but ${fileB}:${directiveB.line} says "${directiveB.text}"`,
          });
        }
      }
    } else {
      // 3+ file cluster — emit ONE issue listing all (file, label) entries so
      // the user sees a coherent disagreement rather than N choose 2 pairs.
      const entries: DetectedDirective[] = [];
      for (const f of conflictingFiles) {
        for (const l of fileLabels.get(f)!) {
          entries.push(idx.get(`${f}::${l}`)!);
        }
      }
      const firstEntry = entries[0];
      const summary = entries.map((e) => `"${e.label}" in ${e.file}`).join(', ');
      const detail = entries.map((e) => `${e.file}:${e.line} says "${e.text}"`).join('\n');
      issues.push({
        severity: 'warning',
        check: 'contradictions',
        ruleId: 'contradictions/conflict',
        line: firstEntry.line,
        message: `${category} conflict across ${conflictingFiles.length} files: ${summary}`,
        suggestion: `Align on one ${category} across all context files`,
        detail,
      });
    }
  }

  return issues;
}
