import type { ParsedContextFile, LintIssue } from '../types.js';
import { isFrontmatterFence } from '../../utils/markdown.js';

/**
 * Validates YAML frontmatter in context files that require it:
 * - Cursor .mdc files: description, globs, alwaysApply
 * - Copilot .github/instructions/*.instructions.md: applyTo
 * - Windsurf .windsurf/rules/*.md: trigger
 */

interface FrontmatterResult {
  found: boolean;
  fields: Record<string, string>;
  endLine: number;
  /**
   * True when the file opens with `---` but never has a matching closing
   * `---`. The whole file body then gets pulled into the YAML parse, which
   * is almost always a typo (closing fence miswritten as `--` or `___`).
   * Callers surface this as its own error so users get a useful diagnostic
   * instead of "no frontmatter" (which is false — the user clearly tried).
   */
  unclosed: boolean;
}

// LIMITATION: this is a shallow, hand-rolled scanner, NOT a real YAML parser.
// It understands top-level `key: value` lines plus the few value forms rule
// files actually use:
//   - trailing `# comments` (a `#` after whitespace, outside quotes) are
//     stripped, and a whole-line comment is skipped;
//   - a fully quoted scalar is unquoted (`"true"` -> `true`);
//   - `- item` entries under an empty-valued key are JOINED into a single
//     ', '-delimited STRING (`globs:\n  - a\n  - b` becomes `"a, b"`);
//   - a flow sequence spread over several lines (`globs: [` ... `]`) is joined
//     into one line until its brackets balance (never balancing leaves the
//     partial value, which the globs check then reports as malformed);
//   - indented continuation lines of a plain or block scalar (`description:`
//     / `description: >-` followed by indented text) are folded into the
//     value with single spaces. An indented line that itself looks like
//     `key: value` is still read as a key, as before.
// Consequences callers must keep in mind:
//   - Duplicate keys silently OVERWRITE (last write wins) -- no error/warning.
//   - Nested maps, anchors, and escape sequences inside quotes are IGNORED.
// Anything needing true YAML semantics must not rely on this function.

/** Drop a trailing YAML comment: a `#` preceded by whitespace, outside quotes. */
function stripYamlComment(value: string): string {
  let quote: string | null = null;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(value[i - 1]))) {
      return value.slice(0, i).trimEnd();
    }
  }
  return value;
}

/** Unquote a scalar that is wholly wrapped in one matching pair of quotes. */
function unquoteScalar(value: string): string {
  // The inner text may not close the quote early: `"a", "b"` is two scalars,
  // not one, and is left as written.
  const dq = /^"([^"]*)"$/.exec(value);
  if (dq) return dq[1];
  const sq = /^'((?:[^']|'')*)'$/.exec(value);
  return sq ? sq[1].replace(/''/g, "'") : value;
}

/** A `|` / `>` block-scalar header, with optional chomping/indent indicators. */
const BLOCK_SCALAR_HEADER = /^[|>][+-]?\d*$/;

function flowDepth(value: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (const ch of value) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth--;
  }
  return depth;
}

function parseFrontmatter(content: string): FrontmatterResult {
  // Split on CRLF too: content arrives un-normalized, and on a CRLF file every
  // line would otherwise end in `\r` -- the closing fence would never match
  // and every parsed value would carry the `\r`.
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    return { found: false, fields: {}, endLine: 0, unclosed: false };
  }

  const fields: Record<string, string> = {};
  let endLine = 0;
  let arrayKey = ''; // a key whose (empty) value may be followed by `- item` lines
  let scalarKey = ''; // a key whose scalar value may continue on indented lines
  let flowKey = ''; // a key whose flow sequence/map is still open

  for (let i = 1; i < lines.length; i++) {
    // Shared closing-fence rule (isFrontmatterFence): column 0, trailing
    // whitespace allowed. An indented `   ---` does NOT close the frontmatter
    // (gray-matter / Cursor agree), so the file parses as unclosed, which the
    // suggestion text for frontmatter/unclosed explicitly warns about.
    if (isFrontmatterFence(lines[i])) {
      endLine = i + 1; // 1-indexed
      break;
    }
    const raw = lines[i];
    const line = stripYamlComment(raw.trim());
    if (line === '') continue; // blank or comment-only line

    if (flowKey) {
      fields[flowKey] = `${fields[flowKey]} ${line}`;
      if (flowDepth(fields[flowKey]) <= 0) flowKey = '';
      continue;
    }

    // Collect YAML array items (- "value") into the preceding key
    if (line.startsWith('- ') && arrayKey) {
      const item = unquoteScalar(line.slice(2).trim());
      const prev = fields[arrayKey];
      fields[arrayKey] = prev ? `${prev}, ${item}` : item;
      scalarKey = '';
      continue;
    }

    const match = line.match(/^(\w+)\s*:\s*(.*)$/);

    // Indented continuation of a scalar: fold it into the value.
    if (scalarKey && /^\s/.test(raw) && !match) {
      const prev = fields[scalarKey];
      fields[scalarKey] = prev ? `${prev} ${line}` : line;
      arrayKey = '';
      continue;
    }
    arrayKey = '';
    scalarKey = '';

    // Parse simple key: value pairs
    if (match) {
      const key = match[1];
      let value = match[2].trim();
      if (BLOCK_SCALAR_HEADER.test(value)) value = '';
      fields[key] = unquoteScalar(value);
      if (!value) {
        // The next lines may be YAML array items or an indented scalar.
        arrayKey = key;
        scalarKey = key;
      } else if (/^[[{]/.test(value) && flowDepth(value) > 0) {
        flowKey = key;
      } else {
        scalarKey = key;
      }
    }
  }

  if (endLine === 0) {
    return { found: true, fields, endLine: lines.length, unclosed: true };
  }

  return { found: true, fields, endLine, unclosed: false };
}

function isCursorMdc(file: ParsedContextFile): boolean {
  return file.relativePath.endsWith('.mdc');
}

function isCopilotInstructions(file: ParsedContextFile): boolean {
  // Copilot only loads path-specific instructions named `NAME.instructions.md`;
  // any other markdown there (a README.md) is not an instructions file.
  return (
    file.relativePath.includes('.github/instructions/') &&
    file.relativePath.endsWith('.instructions.md')
  );
}

function isWindsurfRule(file: ParsedContextFile): boolean {
  return file.relativePath.includes('.windsurf/rules/') && file.relativePath.endsWith('.md');
}

// Windsurf's rules docs (docs.windsurf.com, now served from docs.devin.ai,
// checked 2026-11-22) document exactly these four; `model` is not one of them.
const VALID_WINDSURF_TRIGGERS = ['always_on', 'glob', 'manual', 'model_decision'];

/**
 * Detects unmistakably malformed YAML scalar values: unmatched brackets or quotes.
 * Used to flag genuinely broken `globs:` values without false-positiving on bare
 * strings like `globs: src` (which Cursor accepts).
 */
function hasUnbalancedBracketsOrQuotes(val: string): boolean {
  let square = 0;
  let curly = 0;
  for (const ch of val) {
    if (ch === '[') square++;
    else if (ch === ']') square--;
    else if (ch === '{') curly++;
    else if (ch === '}') curly--;
    if (square < 0 || curly < 0) return true;
  }
  if (square !== 0 || curly !== 0) return true;

  // Quotes only act as YAML quoting when the value STARTS with a quote char.
  // A quote appearing mid-value is a literal (e.g. `globs: src/don't/**` has a
  // lone apostrophe that is part of the path, not an unbalanced YAML quote),
  // so only the leading-quote case can be unbalanced.
  const quoteChar = val[0];
  if (quoteChar === '"' || quoteChar === "'") {
    const count = (val.match(quoteChar === '"' ? /"/g : /'/g) || []).length;
    if (count % 2 !== 0) return true;
  }

  return false;
}

export async function checkFrontmatter(
  file: ParsedContextFile,
  _projectRoot: string,
): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];

  if (isCursorMdc(file)) {
    issues.push(...validateCursorMdc(file));
  } else if (isCopilotInstructions(file)) {
    issues.push(...validateCopilotInstructions(file));
  } else if (isWindsurfRule(file)) {
    issues.push(...validateWindsurfRule(file));
  }

  return issues;
}

function unclosedFrontmatterIssue(): LintIssue {
  // Severity is `error` because once frontmatter is unclosed, every field
  // we parsed is suspect — the host (Cursor / Copilot / Windsurf) loads the
  // file with no frontmatter at all and the rule silently fails to apply.
  // A typo'd close marker (`--` instead of `---`, or stray indentation
  // before the fence) is the typical cause.
  return {
    severity: 'error',
    check: 'frontmatter',
    ruleId: 'frontmatter/unclosed',
    line: 1,
    message: 'Frontmatter opens with `---` but is never closed',
    suggestion:
      'Add a matching `---` line (with no leading whitespace) after the last frontmatter field',
  };
}

function validateCursorMdc(file: ParsedContextFile): LintIssue[] {
  const issues: LintIssue[] = [];
  const fm = parseFrontmatter(file.content);

  if (fm.unclosed) {
    issues.push(unclosedFrontmatterIssue());
    return issues;
  }

  if (!fm.found) {
    issues.push({
      severity: 'warning',
      check: 'frontmatter',
      ruleId: 'frontmatter/missing',
      line: 1,
      message: 'Cursor .mdc file is missing frontmatter',
      suggestion: 'Add YAML frontmatter with description, globs, and alwaysApply fields',
    });
    return issues;
  }

  // Validate required/recommended fields
  if (!fm.fields['description']) {
    issues.push({
      severity: 'warning',
      check: 'frontmatter',
      ruleId: 'frontmatter/missing-field',
      line: 1,
      message: 'Missing "description" field in Cursor .mdc frontmatter',
      suggestion: 'Add a description so Cursor knows when to apply this rule',
    });
  }

  // Check for alwaysApply field
  if (!('alwaysApply' in fm.fields) && !('globs' in fm.fields)) {
    issues.push({
      severity: 'info',
      check: 'frontmatter',
      ruleId: 'frontmatter/no-activation',
      line: 1,
      message: 'No "alwaysApply" or "globs" field — rule may not be applied automatically',
      suggestion: 'Set alwaysApply: true or specify globs for targeted activation',
    });
  }

  // Validate alwaysApply is a boolean-like value
  if ('alwaysApply' in fm.fields) {
    const val = fm.fields['alwaysApply'].toLowerCase();
    if (!['true', 'false'].includes(val)) {
      issues.push({
        severity: 'error',
        check: 'frontmatter',
        ruleId: 'frontmatter/invalid-value',
        line: 1,
        message: `Invalid alwaysApply value: "${fm.fields['alwaysApply']}"`,
        suggestion: 'alwaysApply must be true or false',
      });
    }
  }

  // Validate globs field for unmistakable malformations only.
  // Cursor accepts bare directory names (e.g., `globs: src`) and bare extensions
  // (e.g., `globs: ts`), so we don't flag values just because they lack `*` or `/`.
  // Only catch genuinely malformed YAML: unmatched brackets or unmatched quotes.
  if ('globs' in fm.fields) {
    const val = fm.fields['globs'];
    if (val && hasUnbalancedBracketsOrQuotes(val)) {
      issues.push({
        severity: 'warning',
        check: 'frontmatter',
        ruleId: 'frontmatter/invalid-value',
        line: 1,
        message: `Possibly malformed globs value: "${val}"`,
        suggestion:
          'globs should be a glob pattern like "src/**/*.ts" or an array like ["*.ts", "*.tsx"]',
      });
    }
  }

  return issues;
}

function validateCopilotInstructions(file: ParsedContextFile): LintIssue[] {
  const issues: LintIssue[] = [];
  const fm = parseFrontmatter(file.content);

  if (fm.unclosed) {
    issues.push(unclosedFrontmatterIssue());
    return issues;
  }

  if (!fm.found) {
    issues.push({
      severity: 'info',
      check: 'frontmatter',
      ruleId: 'frontmatter/missing',
      line: 1,
      message: 'Copilot instructions file has no frontmatter',
      suggestion: 'Add applyTo frontmatter to target specific file patterns',
    });
    return issues;
  }

  if (!fm.fields['applyTo']) {
    issues.push({
      severity: 'warning',
      check: 'frontmatter',
      ruleId: 'frontmatter/missing-field',
      line: 1,
      message: 'Missing "applyTo" field in Copilot instructions frontmatter',
      suggestion:
        'Add applyTo to specify which files this instruction applies to (e.g., applyTo: "**/*.ts")',
    });
  }

  return issues;
}

function validateWindsurfRule(file: ParsedContextFile): LintIssue[] {
  const issues: LintIssue[] = [];
  const fm = parseFrontmatter(file.content);

  if (fm.unclosed) {
    issues.push(unclosedFrontmatterIssue());
    return issues;
  }

  if (!fm.found) {
    issues.push({
      severity: 'info',
      check: 'frontmatter',
      ruleId: 'frontmatter/missing',
      line: 1,
      message: 'Windsurf rule file has no frontmatter',
      suggestion: `Add YAML frontmatter with a trigger field (${VALID_WINDSURF_TRIGGERS.join(', ')})`,
    });
    return issues;
  }

  if (!fm.fields['trigger']) {
    issues.push({
      severity: 'warning',
      check: 'frontmatter',
      ruleId: 'frontmatter/missing-field',
      line: 1,
      message: 'Missing "trigger" field in Windsurf rule frontmatter',
      suggestion: `Set trigger to one of: ${VALID_WINDSURF_TRIGGERS.join(', ')}`,
    });
  } else {
    const trigger = fm.fields['trigger'].replace(/['"]/g, '');
    if (!VALID_WINDSURF_TRIGGERS.includes(trigger)) {
      issues.push({
        severity: 'error',
        check: 'frontmatter',
        ruleId: 'frontmatter/invalid-value',
        line: 1,
        message: `Invalid trigger value: "${trigger}"`,
        suggestion: `Valid triggers: ${VALID_WINDSURF_TRIGGERS.join(', ')}`,
      });
    }
  }

  return issues;
}
