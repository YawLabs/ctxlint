import type { ParsedMcpConfig, LintIssue } from '../../types.js';

// Detect wrong syntax patterns
const HAS_CURSOR_SYNTAX = /\$\{env:[^}]+\}/;
const HAS_CLAUDE_SYNTAX = /\$\{[A-Za-z_][A-Za-z0-9_]*(?::-.*)?\}/;
const HAS_CONTINUE_SYNTAX = /\$\{\{\s*secrets\.[^}]+\}\}/;

// Any env var reference — matches ${VAR}, ${env:VAR}, and ${{ secrets.VAR }}
const ANY_ENV_REF = /\$\{\{[^}]*\}\}|\$\{[^}]+\}/g;

interface EnvVarRef {
  varName: string;
  fullMatch: string;
}

function extractEnvVarRefs(value: string): EnvVarRef[] {
  const refs: EnvVarRef[] = [];
  let match;

  ANY_ENV_REF.lastIndex = 0;
  while ((match = ANY_ENV_REF.exec(value)) !== null) {
    const full = match[0];
    // Parse out the variable name from various syntaxes
    let varName: string | null = null;

    const cursorMatch = full.match(/^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/);
    if (cursorMatch) {
      varName = cursorMatch[1];
    }

    const continueMatch = full.match(/^\$\{\{\s*secrets\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/);
    if (continueMatch) {
      varName = continueMatch[1];
    }

    const claudeMatch = full.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-.*)?\}$/);
    if (!varName && claudeMatch) {
      varName = claudeMatch[1];
    }

    if (varName) {
      refs.push({ varName, fullMatch: full });
    }
  }

  return refs;
}

function collectAllStringValues(server: {
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}): string[] {
  const values: string[] = [];
  if (server.command) values.push(server.command);
  if (server.args) values.push(...server.args);
  if (server.url) values.push(server.url);
  if (server.headers) values.push(...Object.values(server.headers));
  if (server.env) values.push(...Object.values(server.env));
  return values;
}

export async function checkMcpEnv(
  config: ParsedMcpConfig,
  _projectRoot: string,
): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];

  if (config.parseErrors.length > 0) return issues;

  for (const server of config.servers) {
    const allValues = collectAllStringValues(server);

    // wrong-syntax: check for wrong env var syntax for the client
    for (const value of allValues) {
      if (config.client === 'claude-code') {
        // Claude Code expects ${VAR}, flag ${env:VAR}
        if (HAS_CURSOR_SYNTAX.test(value)) {
          issues.push({
            severity: 'error',
            check: 'mcp-env',
            ruleId: 'wrong-syntax',
            line: server.line,
            message: `Server "${server.name}": Claude Code uses \${VAR}, not \${env:VAR}`,
            fix: buildSyntaxFix(config, server.line, value, 'claude-code'),
          });
        }
      }

      if (config.client === 'cursor') {
        // Cursor expects ${env:VAR}, flag bare ${VAR}
        if (
          HAS_CLAUDE_SYNTAX.test(value) &&
          !HAS_CURSOR_SYNTAX.test(value) &&
          !HAS_CONTINUE_SYNTAX.test(value)
        ) {
          issues.push({
            severity: 'error',
            check: 'mcp-env',
            ruleId: 'wrong-syntax',
            line: server.line,
            message: `Server "${server.name}": Cursor uses \${env:VAR}, not \${VAR}`,
            fix: buildSyntaxFix(config, server.line, value, 'cursor'),
          });
        }
      }

      if (config.client === 'continue') {
        // Continue expects ${{ secrets.VAR }}, flag other syntaxes
        if (
          (HAS_CLAUDE_SYNTAX.test(value) || HAS_CURSOR_SYNTAX.test(value)) &&
          !HAS_CONTINUE_SYNTAX.test(value)
        ) {
          issues.push({
            severity: 'error',
            check: 'mcp-env',
            ruleId: 'wrong-syntax',
            line: server.line,
            message: `Server "${server.name}": Continue uses \${{ secrets.VAR }}, not \${VAR}`,
            fix: buildSyntaxFix(config, server.line, value, 'continue'),
          });
        }
      }
    }

    // unset-variable: check if referenced env vars are set.
    // Skip for Continue — its ${{ secrets.VAR }} refs resolve from GitHub
    // Actions secrets, not process.env, so every correct Continue config
    // would false-positive here.
    if (config.client !== 'continue') {
      for (const value of allValues) {
        const refs = extractEnvVarRefs(value);
        for (const ref of refs) {
          if (!(ref.varName in process.env)) {
            issues.push({
              severity: 'info',
              check: 'mcp-env',
              ruleId: 'unset-variable',
              line: server.line,
              message: `Server "${server.name}": environment variable "${ref.varName}" is not set`,
            });
          }
        }
      }
    }

    // empty-env-block
    if (server.env && Object.keys(server.env).length === 0) {
      issues.push({
        severity: 'info',
        check: 'mcp-env',
        ruleId: 'empty-env-block',
        line: server.line,
        message: `Server "${server.name}": empty "env" block can be removed`,
      });
    }
  }

  return issues;
}

function buildSyntaxFix(
  config: ParsedMcpConfig,
  line: number,
  value: string,
  targetClient: 'claude-code' | 'cursor' | 'continue',
): LintIssue['fix'] {
  if (targetClient === 'claude-code') {
    // Convert ${env:VAR} to ${VAR}
    const fixed = value.replace(/\$\{env:([^}]+)\}/g, '${$1}');
    return { file: config.filePath, line, oldText: value, newText: fixed };
  }
  if (targetClient === 'cursor') {
    // Convert ${VAR} to ${env:VAR} (but not ${env:VAR} which is already correct)
    const fixed = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-.*)?\}/g, (match, varName) => {
      if (match.startsWith('${env:')) return match;
      return `\${env:${varName}}`;
    });
    return { file: config.filePath, line, oldText: value, newText: fixed };
  }
  if (targetClient === 'continue') {
    // Convert ${VAR} or ${env:VAR} to ${{ secrets.VAR }}
    let fixed = value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, '${{ secrets.$1 }}');
    fixed = fixed.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-.*)?\}/g, (match) => {
      if (match.includes('secrets.')) return match;
      const varMatch = match.match(/\$\{([A-Za-z_][A-Za-z0-9_]*)/);
      return varMatch ? `\${{ secrets.${varMatch[1]} }}` : match;
    });
    return { file: config.filePath, line, oldText: value, newText: fixed };
  }
  return undefined;
}
