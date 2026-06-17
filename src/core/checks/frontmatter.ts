import type { ParsedContextFile, LintIssue } from '../types.js';

/**
 * Validates YAML frontmatter in context files that require it:
 * - Cursor .mdc files: description, globs, alwaysApply
 * - Copilot .instructions.md: applyTo
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
// It only understands top-level `key: value` lines and a single level of
// `- item` array entries. Consequences callers must keep in mind:
//   - Duplicate keys silently OVERWRITE (last write wins) -- no error/warning.
//   - Array values are JOINED into a single ', '-delimited STRING (e.g.
//     `globs:\n  - a\n  - b` becomes `"a, b"`), not preserved as a list.
//   - Nested maps, multi-line/block scalars, flow collections, anchors,
//     comments, and quoting subtleties are all IGNORED.
// Anything needing true YAML semantics must not rely on this function.
function parseFrontmatter(content: string): FrontmatterResult {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') {
    return { found: false, fields: {}, endLine: 0, unclosed: false };
  }

  const fields: Record<string, string> = {};
  let endLine = 0;
  let arrayKey = ''; // tracks a key whose value is a YAML array

  for (let i = 1; i < lines.length; i++) {
    // The closing fence must be at column 0 to match the host loaders
    // (gray-matter / Cursor): an indented `   ---` does NOT close the
    // frontmatter, so the file parses as unclosed (which the suggestion text
    // for frontmatter/unclosed explicitly warns about). Compare un-trimmed.
    if (lines[i] === '---') {
      endLine = i + 1; // 1-indexed
      break;
    }
    const line = lines[i].trim();

    // Collect YAML array items (- "value") into the preceding key
    if (line.startsWith('- ') && arrayKey) {
      const item = line
        .slice(2)
        .trim()
        .replace(/^["']|["']$/g, '');
      const prev = fields[arrayKey];
      fields[arrayKey] = prev ? `${prev}, ${item}` : item;
      continue;
    }
    arrayKey = '';

    // Parse simple key: value pairs
    const match = line.match(/^(\w+)\s*:\s*(.*)$/);
    if (match) {
      fields[match[1]] = match[2].trim();
      // If value is empty, the next lines may be YAML array items
      if (!match[2].trim()) {
        arrayKey = match[1];
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
  return file.relativePath.includes('.github/instructions/') && file.relativePath.endsWith('.md');
}

function isWindsurfRule(file: ParsedContextFile): boolean {
  return file.relativePath.includes('.windsurf/rules/') && file.relativePath.endsWith('.md');
}

const VALID_WINDSURF_TRIGGERS = ['always_on', 'glob', 'manual', 'model', 'model_decision'];

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
