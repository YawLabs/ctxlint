import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadPackageJson, stripBom } from '../../utils/fs.js';
import type { ParsedContextFile, LintIssue } from '../types.js';

// Match npm/pnpm/yarn/bun run/script commands
const NPM_SCRIPT_PATTERN = /^(?:npm\s+run|pnpm(?:\s+run)?|yarn(?:\s+run)?|bun(?:\s+run)?)\s+(\S+)/;
const MAKE_PATTERN = /^make\s+(\S+)/;

/**
 * Extract the package name from an `npx` command. Walks past leading flags
 * (`-y`, `--yes`, `--silent`, ...) and honors `-p` / `--package` overrides.
 * Returns null when no package can be identified.
 *
 * Earlier behavior only inspected the first whitespace-delimited token after
 * `npx`, so `npx -y @scope/typo` skipped validation entirely (the `-y` was
 * captured, then `startsWith('-')` short-circuited).
 */
function extractNpxPackage(cmd: string): string | null {
  if (!/^npx\b/.test(cmd)) return null;
  const tokens = cmd.split(/\s+/).slice(1);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-p' || t === '--package') {
      const v = tokens[i + 1];
      if (v && !v.startsWith('-')) return v;
      continue;
    }
    if (t.startsWith('-p=') || t.startsWith('--package=')) {
      return t.slice(t.indexOf('=') + 1) || null;
    }
    if (t.startsWith('-')) continue;
    return t;
  }
  return null;
}

export async function checkCommands(
  file: ParsedContextFile,
  projectRoot: string,
): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];
  const pkgJson = loadPackageJson(projectRoot);
  const makefile = loadMakefile(projectRoot);

  for (const ref of file.references.commands) {
    const cmd = ref.value;

    // Check npm/pnpm/yarn script references
    const scriptMatch = cmd.match(NPM_SCRIPT_PATTERN);
    if (scriptMatch && pkgJson) {
      const scriptName = scriptMatch[1];
      if (pkgJson.scripts && !(scriptName in pkgJson.scripts)) {
        const available = Object.keys(pkgJson.scripts).join(', ');
        issues.push({
          severity: 'error',
          check: 'commands',
          ruleId: 'commands/script-not-found',
          line: ref.line,
          message: `"${cmd}" — script "${scriptName}" not found in package.json`,
          suggestion: available ? `Available scripts: ${available}` : undefined,
        });
      }
      continue;
    }

    // Check shorthand npm/pnpm/yarn/bun commands that map to scripts
    const shorthandMatch = cmd.match(
      /^(npm|pnpm|yarn|bun)\s+(test|start|build|dev|lint|format|check|typecheck|clean|serve|preview|e2e)\b/,
    );
    if (shorthandMatch && pkgJson) {
      const scriptName = shorthandMatch[2];
      if (pkgJson.scripts && !(scriptName in pkgJson.scripts)) {
        issues.push({
          severity: 'error',
          check: 'commands',
          ruleId: 'commands/script-not-found',
          line: ref.line,
          message: `"${cmd}" — script "${scriptName}" not found in package.json`,
        });
      }
      continue;
    }

    // Check npx package references
    if (/^npx\b/.test(cmd) && pkgJson) {
      const pkgName = extractNpxPackage(cmd);
      if (!pkgName) continue;

      const allDeps = {
        ...pkgJson.dependencies,
        ...pkgJson.devDependencies,
        ...pkgJson.peerDependencies,
        ...pkgJson.optionalDependencies,
      };

      // Normalize: npx packages may be invoked by bin name which differs from package name
      // Common mappings: tsc -> typescript, prettier -> prettier, etc.
      // Only warn if the package isn't in deps AND isn't in node_modules/.bin
      if (!(pkgName in allDeps)) {
        const binPath = path.join(projectRoot, 'node_modules', '.bin', pkgName);
        try {
          fs.accessSync(binPath);
        } catch {
          issues.push({
            severity: 'warning',
            check: 'commands',
            ruleId: 'commands/npx-not-in-deps',
            line: ref.line,
            message: `"${cmd}" — "${pkgName}" not found in dependencies`,
            suggestion:
              'If this is a global tool, consider adding it to devDependencies for reproducibility',
          });
        }
      }
      continue;
    }

    // Check Makefile targets
    const makeMatch = cmd.match(MAKE_PATTERN);
    if (makeMatch) {
      const target = makeMatch[1];
      if (makefile && !hasMakeTarget(makefile, target)) {
        issues.push({
          severity: 'error',
          check: 'commands',
          ruleId: 'commands/make-target-not-found',
          line: ref.line,
          message: `"${cmd}" — target "${target}" not found in Makefile`,
        });
      } else if (!makefile) {
        issues.push({
          severity: 'error',
          check: 'commands',
          ruleId: 'commands/no-makefile',
          line: ref.line,
          message: `"${cmd}" — no Makefile found in project`,
        });
      }
      continue;
    }

    // Check common tool availability
    const toolMatch = cmd.match(/^(vitest|jest|pytest|mocha|eslint|prettier|tsc)\b/);
    if (toolMatch && pkgJson) {
      const tool = toolMatch[1];
      const allDeps = {
        ...pkgJson.dependencies,
        ...pkgJson.devDependencies,
        ...pkgJson.peerDependencies,
        ...pkgJson.optionalDependencies,
      };
      if (!(tool in allDeps)) {
        // Check node_modules/.bin
        const binPath = path.join(projectRoot, 'node_modules', '.bin', tool);
        try {
          fs.accessSync(binPath);
        } catch {
          issues.push({
            severity: 'warning',
            check: 'commands',
            ruleId: 'commands/tool-not-found',
            line: ref.line,
            message: `"${cmd}" — "${tool}" not found in dependencies or node_modules/.bin`,
          });
        }
      }
    }
  }

  return issues;
}

function loadMakefile(projectRoot: string): string | null {
  try {
    return stripBom(fs.readFileSync(path.join(projectRoot, 'Makefile'), 'utf-8'));
  } catch {
    return null;
  }
}

function hasMakeTarget(makefile: string, target: string): boolean {
  // Match "target:" at the start of a line (standard Makefile target syntax)
  // Also matches .PHONY declarations
  const pattern = new RegExp(`^${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`, 'm');
  return pattern.test(makefile);
}
