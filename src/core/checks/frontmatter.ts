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
}

function parseFrontmatter(content: string): FrontmatterResult {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') {
    return { found: false, fields: {}, endLine: 0 };
  }

  const fields: Record<string, string> = {};
  let endLine = 0;
  let arrayKey = ''; // tracks a key whose value is a YAML array

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '---') {
      endLine = i + 1; // 1-indexed
      break;
    }

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
    // Unclosed frontmatter
    return { found: true, fields, endLine: lines.length };
  }

  return { found: true, fields, endLine };
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

function validateCursorMdc(file: ParsedContextFile): LintIssue[] {
  const issues: LintIssue[] = [];
  const fm = parseFrontmatter(file.content);

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

  // Validate globs field looks like an array or string
  if ('globs' in fm.fields) {
    const val = fm.fields['globs'];
    if (
      val &&
      !val.startsWith('[') &&
      !val.startsWith('"') &&
      !val.includes('*') &&
      !val.includes('/')
    ) {
      issues.push({
        severity: 'warning',
        check: 'frontmatter',
        ruleId: 'frontmatter/invalid-value',
        line: 1,
        message: `Possibly invalid globs value: "${val}"`,
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

  if (!fm.found) {
    issues.push({
      severity: 'info',
      check: 'frontmatter',
      ruleId: 'frontmatter/missing',
      line: 1,
      message: 'Windsurf rule file has no frontmatter',
      suggestion: 'Add YAML frontmatter with a trigger field (always_on, glob, manual, model)',
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
