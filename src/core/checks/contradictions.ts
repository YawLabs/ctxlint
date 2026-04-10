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
        patterns: [/\buse\s+jest\b/i, /\bjest\s+for\s+test/i, /\btest.*with\s+jest\b/i],
      },
      {
        label: 'Vitest',
        patterns: [/\buse\s+vitest\b/i, /\bvitest\s+for\s+test/i, /\btest.*with\s+vitest\b/i],
      },
      {
        label: 'Mocha',
        patterns: [/\buse\s+mocha\b/i, /\bmocha\s+for\s+test/i, /\btest.*with\s+mocha\b/i],
      },
      {
        label: 'pytest',
        patterns: [/\buse\s+pytest\b/i, /\bpytest\s+for\s+test/i, /\btest.*with\s+pytest\b/i],
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
        patterns: [
          /\b2[\s-]?space\s+indent/i,
          /\bindent\s+with\s+2\s+spaces/i,
          /\b2[\s-]?space\s+tabs?\b/i,
        ],
      },
      {
        label: '4 spaces',
        patterns: [
          /\b4[\s-]?space\s+indent/i,
          /\bindent\s+with\s+4\s+spaces/i,
          /\b4[\s-]?space\s+tabs?\b/i,
        ],
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

function detectDirectives(file: ParsedContextFile): DetectedDirective[] {
  const directives: DetectedDirective[] = [];
  const lines = file.content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    for (const category of DIRECTIVE_CATEGORIES) {
      for (const option of category.options) {
        for (const pattern of option.patterns) {
          if (pattern.test(line)) {
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

  // Collect all directives across all files
  const allDirectives: DetectedDirective[] = [];
  for (const file of files) {
    allDirectives.push(...detectDirectives(file));
  }

  // Group by category
  const byCategory = new Map<string, DetectedDirective[]>();
  for (const d of allDirectives) {
    const existing = byCategory.get(d.category) || [];
    existing.push(d);
    byCategory.set(d.category, existing);
  }

  // Find contradictions: same category, different labels, different files
  for (const [category, directives] of byCategory) {
    const byFile = new Map<string, DetectedDirective[]>();
    for (const d of directives) {
      const existing = byFile.get(d.file) || [];
      existing.push(d);
      byFile.set(d.file, existing);
    }

    // Get unique labels across all files
    const labels = new Set(directives.map((d) => d.label));
    if (labels.size <= 1) continue;

    // Check if different files specify different options
    const fileLabels = new Map<string, Set<string>>();
    for (const d of directives) {
      const existing = fileLabels.get(d.file) || new Set();
      existing.add(d.label);
      fileLabels.set(d.file, existing);
    }

    // Build conflict pairs
    const fileEntries = [...fileLabels.entries()];
    for (let i = 0; i < fileEntries.length; i++) {
      for (let j = i + 1; j < fileEntries.length; j++) {
        const [fileA, labelsA] = fileEntries[i];
        const [fileB, labelsB] = fileEntries[j];

        // Check for conflicting labels between the two files
        for (const labelA of labelsA) {
          for (const labelB of labelsB) {
            if (labelA !== labelB) {
              const directiveA = directives.find((d) => d.file === fileA && d.label === labelA)!;
              const directiveB = directives.find((d) => d.file === fileB && d.label === labelB)!;

              issues.push({
                severity: 'warning',
                check: 'contradictions',
                line: directiveA.line,
                message: `${category} conflict: "${directiveA.label}" in ${fileA} vs "${directiveB.label}" in ${fileB}`,
                suggestion: `Align on one ${category} across all context files`,
                detail: `${fileA}:${directiveA.line} says "${directiveA.text}" but ${fileB}:${directiveB.line} says "${directiveB.text}"`,
              });
            }
          }
        }
      }
    }
  }

  return issues;
}
