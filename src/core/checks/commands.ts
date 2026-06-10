import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadPackageJson, stripBom } from '../../utils/fs.js';
import type { ParsedContextFile, LintIssue } from '../types.js';

// Match npm/pnpm/yarn/bun script invocations. `run` is required for npm
// (bare `npm install` is never a script reference), optional for
// pnpm/yarn/bun. Groups: [1] the non-npm manager, [2] an explicit `run`,
// [3] the candidate script name — [1] and [2] let scriptNameFromMatch
// exempt builtin subcommands (`pnpm install`, `yarn add`, ...) from
// script-name validation.
const NPM_SCRIPT_PATTERN = /^(?:npm\s+run|(pnpm|yarn|bun)(?:\s+(run))?)\s+(\S+)/;
const MAKE_PATTERN = /^make\s+\S/;

// Subcommands that are package-manager builtins when invoked WITHOUT an
// explicit `run` (e.g. `pnpm install`, `yarn dlx foo`, `bun add zod`).
// These are not package.json script names and must not produce
// commands/script-not-found. Script-mapped shorthands (`pnpm test`,
// `yarn build`, ...) are deliberately absent — those DO resolve to
// scripts and stay validated.
const PM_BUILTIN_SUBCOMMANDS = new Set([
  'add',
  'approve-builds',
  'audit',
  'bin',
  'cache',
  'ci',
  'config',
  'create',
  'dedupe',
  'dlx',
  'doctor',
  'env',
  'exec',
  'fetch',
  'global',
  'help',
  'i',
  'import',
  'info',
  'init',
  'install',
  'licenses',
  'link',
  'list',
  'login',
  'logout',
  'ls',
  'node',
  'npm',
  'outdated',
  'pack',
  'patch',
  'patch-commit',
  'prune',
  'publish',
  'rebuild',
  'remove',
  'rm',
  'root',
  'run',
  'self-update',
  'set',
  'setup',
  'store',
  'team',
  'un',
  'uninstall',
  'unlink',
  'up',
  'update',
  'upgrade',
  'version',
  'whoami',
  'why',
  'workspace',
  'workspaces',
  'x',
]);

/**
 * Resolve the script name from an NPM_SCRIPT_PATTERN match, or null when the
 * captured token is not actually a script name: a flag (`pnpm -r build` —
 * the real script is unknowable without parsing pnpm's flag table), or a
 * package-manager builtin invoked without an explicit `run`.
 */
function scriptNameFromMatch(match: RegExpMatchArray): string | null {
  const [, manager, explicitRun, name] = match;
  if (name.startsWith('-')) return null;
  if (manager && !explicitRun && PM_BUILTIN_SUBCOMMANDS.has(name)) return null;
  return name;
}

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

// Patterns whose validation branch is gated on a parsed package.json. When
// package.json is missing/unparseable every one of these branches silently
// no-ops, so we track whether any reference WOULD have been checked and emit a
// single info diagnostic (asymmetric otherwise with the make-target branch,
// which has its own no-makefile error).
const PKG_DEPENDENT_TOOL_PATTERN = /^(vitest|jest|pytest|mocha|eslint|prettier|tsc)\b/;
const PKG_SHORTHAND_PATTERN =
  /^(npm|pnpm|yarn|bun)\s+(test|start|build|dev|lint|format|check|typecheck|clean|serve|preview|e2e)\b/;

function wouldNeedPackageJson(cmd: string): boolean {
  // Builtin subcommands / flag-first invocations are never validated, so
  // they must not trigger the package-json-missing info either.
  const scriptMatch = cmd.match(NPM_SCRIPT_PATTERN);
  if (scriptMatch && scriptNameFromMatch(scriptMatch) !== null) return true;
  return (
    PKG_SHORTHAND_PATTERN.test(cmd) || /^npx\b/.test(cmd) || PKG_DEPENDENT_TOOL_PATTERN.test(cmd)
  );
}

export async function checkCommands(
  file: ParsedContextFile,
  projectRoot: string,
): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];
  const pkgJson = loadPackageJson(projectRoot);
  const makefile = loadMakefile(projectRoot);

  // When package.json can't be loaded, all the script/shorthand/npx/tool
  // branches below silently skip. Surface that ONCE if any reference would
  // otherwise have been validated, so the skip isn't invisible.
  if (!pkgJson) {
    const skipped = file.references.commands.find((ref) => wouldNeedPackageJson(ref.value));
    if (skipped) {
      issues.push({
        severity: 'info',
        check: 'commands',
        ruleId: 'commands/package-json-missing',
        line: skipped.line,
        message: 'package.json missing or unparseable — command checks skipped',
        suggestion:
          'Add a parseable package.json at the project root so script, npx, and tool references can be validated.',
      });
    }
  }

  for (const ref of file.references.commands) {
    const cmd = ref.value;

    // Check npm/pnpm/yarn script references
    const scriptMatch = cmd.match(NPM_SCRIPT_PATTERN);
    if (scriptMatch && pkgJson) {
      const scriptName = scriptNameFromMatch(scriptMatch);
      if (scriptName && pkgJson.scripts && !(scriptName in pkgJson.scripts)) {
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
    const shorthandMatch = cmd.match(PKG_SHORTHAND_PATTERN);
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
    if (MAKE_PATTERN.test(cmd)) {
      if (!makefile) {
        issues.push({
          severity: 'error',
          check: 'commands',
          ruleId: 'commands/no-makefile',
          line: ref.line,
          message: `"${cmd}" — no Makefile found in project`,
        });
      } else {
        const target = extractMakeTarget(cmd);
        if (target && !hasMakeTarget(makefile, target)) {
          issues.push({
            severity: 'error',
            check: 'commands',
            ruleId: 'commands/make-target-not-found',
            line: ref.line,
            message: `"${cmd}" — target "${target}" not found in Makefile`,
          });
        }
      }
      continue;
    }

    // Check common tool availability
    const toolMatch = cmd.match(PKG_DEPENDENT_TOOL_PATTERN);
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

/**
 * Extract the target of a `make` invocation. `NAME=value` overrides are
 * skipped (they don't consume the next token). Any flag token bails out
 * entirely: flags like `-C dir` / `-f file` take a value, so the first
 * non-flag token may be a flag's argument rather than a target — a skipped
 * validation is safer than reporting a flag (or its value) as missing.
 */
function extractMakeTarget(cmd: string): string | null {
  for (const token of cmd.split(/\s+/).slice(1)) {
    if (token.startsWith('-')) return null;
    if (token.includes('=')) continue;
    return token;
  }
  return null;
}

function hasMakeTarget(makefile: string, target: string): boolean {
  // Match "target:" at the start of a line (standard rule syntax, including
  // double-colon rules). The (?!:?=) lookahead keeps `target := value` /
  // `target ::= value` variable assignments from counting as rules. `.PHONY:
  // target` lines deliberately do NOT count — .PHONY only marks phony-ness;
  // without its own rule line the target is still unrunnable.
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escaped}\\s*:(?!:?=)`, 'm');
  return pattern.test(makefile);
}
