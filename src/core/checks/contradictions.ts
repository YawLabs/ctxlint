import { nonProseLineMask } from '../../utils/markdown.js';
import type { ParsedContextFile, LintIssue } from '../types.js';

/**
 * Detects conflicting directives across multiple context files.
 * For example, one file says "use Jest" and another says "use Vitest".
 */

interface DirectiveCategory {
  name: string;
  options: DirectiveOption[];
  /**
   * Directives in this category only conflict when they name the same object:
   * "camelCase for variables" and "PascalCase for React components" are
   * complementary, not contradictory. The object is the noun phrase after
   * "for" (see directiveObject); a directive with none is "general". General
   * directives are compared with each other, never with a scoped one: "Use
   * snake_case for Python functions." is an exception to "Use camelCase.",
   * not a contradiction of it, whether both sit in one file or in two (the
   * more specific rule wins either way, and polyglot repos split them).
   */
  scopedByObject?: boolean;
}

interface DirectiveOption {
  label: string;
  patterns: RegExp[];
  /**
   * Label a NEGATED match registers instead of being dropped, for binary
   * categories where "don't X" is itself a choice: "Don't use semicolons"
   * endorses "no semicolons".
   */
  negatedLabel?: string;
}

// Define mutually exclusive directive categories
const DIRECTIVE_CATEGORIES: DirectiveCategory[] = [
  {
    // Unit-test runners. E2E/browser frameworks live in their own category
    // below: "Vitest for unit tests" + "Playwright for e2e" is a normal stack.
    name: 'testing framework',
    options: [
      {
        label: 'Jest',
        // The third pattern allows nothing between `test` and `with <fw>` but
        // the rest of the word (`tests`, `testing`), so prose like "run our
        // test suite and then deploy with jest" does not match the framework
        // directive -- only tight phrasings like "test with jest" / "tests
        // with jest" do ("tests run with jest" does not).
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
    ],
  },
  {
    name: 'e2e testing framework',
    options: [
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
        // A bare "2 spaces" is not enough ("Leave 2 spaces after a sentence"):
        // it needs a directive verb or indentation context.
        label: '2 spaces',
        patterns: [
          /\b2[\s-]?space\s+indent/i,
          /\bindent\s+with\s+2\s+spaces/i,
          /\b(?:use|prefer|enforce)\s+2\s+spaces\b/i,
          /\bindent(?:ation|ed|s)?\s*(?:is|of|by|:|=)?\s*2\s+spaces\b/i,
          /\b2\s+spaces\s+(?:for\s+|of\s+)?(?:indent|per\s+(?:indent|level))/i,
        ],
      },
      {
        label: '4 spaces',
        patterns: [
          /\b4[\s-]?space\s+indent/i,
          /\bindent\s+with\s+4\s+spaces/i,
          /\b(?:use|prefer|enforce)\s+4\s+spaces\b/i,
          /\bindent(?:ation|ed|s)?\s*(?:is|of|by|:|=)?\s*4\s+spaces\b/i,
          /\b4\s+spaces\s+(?:for\s+|of\s+)?(?:indent|per\s+(?:indent|level))/i,
        ],
      },
    ],
  },
  {
    name: 'semicolons',
    options: [
      {
        label: 'semicolons',
        negatedLabel: 'no semicolons',
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
    scopedByObject: true,
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

// Every pattern that ends in `\b` gets `(?![\w-])` instead, so a tool name
// followed by a hyphen is not read as the tool: `use npm-check-updates` is not
// "use npm", `use jest-dom` is not "use jest".
for (const category of DIRECTIVE_CATEGORIES) {
  for (const option of category.options) {
    option.patterns = option.patterns.map((p) =>
      p.source.endsWith('\\b') ? new RegExp(`${p.source.slice(0, -2)}(?![\\w-])`, p.flags) : p,
    );
  }
}

interface DetectedDirective {
  file: string;
  /** Category name, qualified by the directive's object for scoped categories. */
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
// covers the contraction family (don't / doesn't / won't / shouldn't). "no
// longer" is a negation ("We no longer use yarn"), and "never, ever" is one
// negation despite its comma.
const NEGATION_BEFORE_MATCH =
  /(?:\b(?:never(?:\s*,\s*ever)?|not|no\s+longer|avoid|stop|instead\s+of)\b|n['’]t\b)[^.;:,!?]*$/i;
const NEGATION_WINDOW = 24;

function isNegated(line: string, matchIndex: number): boolean {
  const windowStart = Math.max(0, matchIndex - NEGATION_WINDOW);
  return NEGATION_BEFORE_MATCH.test(line.slice(windowStart, matchIndex));
}

interface PatternMatches {
  /** First occurrence that is not negated, if any. */
  plain: RegExpExecArray | null;
  /** First negated occurrence, if any. */
  negated: RegExpExecArray | null;
}

// Negation is per-occurrence, not per-line: in "Don't use pnpm in CI, use
// pnpm locally." only the first mention is negated (the comma ends the
// negation's clause), so the second is a live endorsement. A single
// non-global exec stops at the first occurrence — if that one happens to be
// negated, the endorsement is dropped and a real cross-file conflict is
// suppressed. Scan every occurrence; ANY non-negated one registers.
function scanMatches(pattern: RegExp, line: string): PatternMatches {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const global = new RegExp(pattern.source, flags);
  const out: PatternMatches = { plain: null, negated: null };
  let m: RegExpExecArray | null;
  while ((m = global.exec(line)) !== null) {
    if (!isNegated(line, m.index)) {
      out.plain = m;
      return out;
    }
    out.negated ??= m;
  }
  return out;
}

// The object of a naming directive: "camelCase for variable names" ->
// "variable". Read from the case token onward, so it works whichever pattern
// matched ("use camelCase for ..." / "camelCase naming for ...").
const NAMING_OBJECT =
  /(?:camel|snake|pascal|kebab)[\s_-]?case\b(?:\s+(?:naming|conventions?))?\s+for\s+([^.;:,!?()]+)/i;
const OBJECT_STOP_WORDS = new Set([
  'and',
  'or',
  'in',
  'when',
  'unless',
  'except',
  'where',
  'but',
  'with',
  'to',
  'that',
  'which',
  'across',
  'throughout',
  'everywhere',
]);
const OBJECT_LEADING_WORDS = new Set([
  'all',
  'the',
  'a',
  'an',
  'any',
  'every',
  'our',
  'your',
  'new',
]);
const OBJECT_TRAILING_WORDS = new Set(['name', 'names', 'naming', 'identifier', 'identifiers']);

function singular(word: string): string {
  if (word === 'filenames' || word === 'filename') return 'file';
  if (/(?:ss|sh|ch|x)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** Normalised object of a naming directive, or '' when it names none. */
function directiveObject(line: string, matchIndex: number): string {
  const m = NAMING_OBJECT.exec(line.slice(matchIndex));
  if (!m) return '';
  const words: string[] = [];
  for (const w of m[1].toLowerCase().split(/\s+/).filter(Boolean)) {
    if (OBJECT_STOP_WORDS.has(w)) break;
    if (words.length === 0 && OBJECT_LEADING_WORDS.has(w)) continue;
    words.push(w);
    if (words.length === 3) break;
  }
  while (words.length > 1 && OBJECT_TRAILING_WORDS.has(words[words.length - 1])) words.pop();
  return words.map(singular).join(' ');
}

function detectDirectives(file: ParsedContextFile): DetectedDirective[] {
  const directives: DetectedDirective[] = [];
  const lines = file.content.split('\n');
  // Fenced code and HTML comments are illustrations/commentary, not the
  // file's own policy: a ```markdown fence SHOWING "Always use yarn" must not
  // register a yarn directive.
  const nonProse = nonProseLineMask(lines);

  for (let i = 0; i < lines.length; i++) {
    if (nonProse[i]) continue;
    const line = lines[i];
    const seen = new Set<string>(); // `${category}::${label}` already registered on this line

    const register = (category: string, label: string): void => {
      const key = `${category}::${label}`;
      if (seen.has(key)) return;
      seen.add(key);
      directives.push({
        file: file.relativePath,
        category,
        label,
        line: i + 1,
        text: line.trim(),
      });
    };

    for (const category of DIRECTIVE_CATEGORIES) {
      for (const option of category.options) {
        let negatedFallback: RegExpExecArray | null = null;
        let registered = false;
        for (const pattern of option.patterns) {
          const { plain, negated } = scanMatches(pattern, line);
          if (plain) {
            register(qualifiedCategory(category, line, plain.index), option.label);
            registered = true;
            break; // One match per option per line is enough
          }
          negatedFallback ??= negated;
        }
        if (!registered && negatedFallback && option.negatedLabel) {
          register(qualifiedCategory(category, line, negatedFallback.index), option.negatedLabel);
        }
      }
    }
  }

  return directives;
}

function qualifiedCategory(category: DirectiveCategory, line: string, matchIndex: number): string {
  if (!category.scopedByObject) return category.name;
  const object = directiveObject(line, matchIndex);
  return object ? `${category.name} (${object})` : category.name;
}

/**
 * The directory a context file governs, as a forward-slash path ('' = project
 * root). A file inside a tool-config directory (`.cursor/rules/x.mdc`,
 * `.github/copilot-instructions.md`, `.claude/rules/x.md`) governs the
 * directory that holds that config dir, not the config dir itself.
 */
function governedDir(relativePath: string): string {
  const segments = relativePath.replace(/\\/g, '/').split('/');
  segments.pop();
  const dot = segments.findIndex((seg) => seg.startsWith('.') && seg !== '.' && seg !== '..');
  const kept = dot === -1 ? segments : segments.slice(0, dot);
  return kept.filter((seg) => seg !== '.').join('/');
}

/**
 * Two files can only contradict each other when both apply to the same code:
 * one's directory is an ancestor of (or equal to) the other's. Sibling
 * packages (`packages/a/CLAUDE.md` with Jest, `packages/b/CLAUDE.md` with
 * Vitest) legitimately make different choices.
 */
function sameScope(dirA: string, dirB: string): boolean {
  if (dirA === dirB || dirA === '' || dirB === '') return true;
  return dirB.startsWith(`${dirA}/`) || dirA.startsWith(`${dirB}/`);
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
    //
    // Files are only compared when one's directory contains the other's (see
    // sameScope).
    const conflictsWith = (fileA: string, fileB: string): boolean => {
      if (!sameScope(governedDir(fileA), governedDir(fileB))) return false;
      const a = fileLabels.get(fileA)!;
      const b = fileLabels.get(fileB)!;
      let aHasExtra = false;
      let bHasExtra = false;
      for (const l of a) if (!b.has(l)) aHasExtra = true;
      for (const l of b) if (!a.has(l)) bHasExtra = true;
      return aHasExtra && bHasExtra;
    };
    const conflictingFiles = [...fileLabels.keys()].filter((f) => {
      for (const otherFile of fileLabels.keys()) {
        if (otherFile === f) continue;
        if (conflictsWith(f, otherFile)) return true;
      }
      return false;
    });

    if (conflictingFiles.length < 2) continue;

    const idx = directiveIndex.get(category)!;

    if (conflictingFiles.length === 2) {
      const [fileA, fileB] = conflictingFiles;
      issues.push(
        ...pairIssues(
          category,
          { file: fileA, labels: fileLabels.get(fileA)!, index: idx },
          { file: fileB, labels: fileLabels.get(fileB)!, index: idx },
        ),
      );
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

interface PairSide {
  file: string;
  labels: Set<string>;
  /** `${file}::${label}` -> directive, for this side's category bucket. */
  index: Map<string, DetectedDirective>;
}

/**
 * Pair conflict -- the (file, label) x (file, label) shape. Only labels one
 * file holds and the other lacks can disagree: a label both files share is
 * common ground, so pairing it with the other side's extra label would report
 * a "conflict" the first file itself agrees with.
 */
function pairIssues(category: string, a: PairSide, b: PairSide): LintIssue[] {
  const out: LintIssue[] = [];
  for (const labelA of a.labels) {
    if (b.labels.has(labelA)) continue;
    for (const labelB of b.labels) {
      if (a.labels.has(labelB)) continue;
      const directiveA = a.index.get(`${a.file}::${labelA}`)!;
      const directiveB = b.index.get(`${b.file}::${labelB}`)!;
      out.push({
        severity: 'warning',
        check: 'contradictions',
        ruleId: 'contradictions/conflict',
        line: directiveA.line,
        message: `${category} conflict: "${directiveA.label}" in ${a.file} vs "${directiveB.label}" in ${b.file}`,
        suggestion: `Align on one ${category} across all context files`,
        detail: `${a.file}:${directiveA.line} says "${directiveA.text}" but ${b.file}:${directiveB.line} says "${directiveB.text}"`,
      });
    }
  }
  return out;
}
