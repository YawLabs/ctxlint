import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadPackageJson } from '../../utils/fs.js';
import type { ParsedContextFile, LintIssue } from '../types.js';

// Match npm/pnpm/yarn/bun run/script commands
const NPM_SCRIPT_PATTERN = /^(?:npm\s+run|pnpm(?:\s+run)?|yarn(?:\s+run)?|bun(?:\s+run)?)\s+(\S+)/;
const MAKE_PATTERN = /^make\s+(\S+)/;
const NPX_PATTERN = /^npx\s+(\S+)/;

// npm write operations that require 2FA-authenticated sessions. When a user's
// 2FA is WebAuthn-only (no TOTP authenticator), CLI-authenticated sessions
// cannot satisfy the 2FA-for-writes check and the registry returns 422.
// Documented behavior:
//   https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification
// Observed failure mode: `npm deprecate`, `npm unpublish`, etc. return
// "[email protected] cannot be republished until 24 hours have passed" or a
// generic 422 even with a valid granular token. The website UI at
// npmjs.com/package/<pkg>/settings uses the user's already-WebAuthn-verified
// browser session and completes the write without the 2FA gap.
const NPM_WRITE_OP_PATTERN =
  /^npm\s+(publish|deprecate|unpublish|access\s+(grant|revoke|2fa)|dist-tag\s+(add|rm|set)|owner\s+(add|rm))\b/;

export async function checkCommands(
  file: ParsedContextFile,
  projectRoot: string,
): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];
  const pkgJson = loadPackageJson(projectRoot);
  const makefile = loadMakefile(projectRoot);

  for (const ref of file.references.commands) {
    const cmd = ref.value;

    // Check npm write ops that may 422 under WebAuthn-only auth. Info-level
    // because the rule is opinionated (only bites users whose 2FA is WebAuthn
    // without a TOTP fallback) — we inform, not error. Skip `publish` since
    // most projects already route that through CI (tokens/aggregate-style
    // advice lives elsewhere).
    const writeMatch = cmd.match(NPM_WRITE_OP_PATTERN);
    if (writeMatch) {
      const op = writeMatch[1].split(/\s+/)[0];
      if (op !== 'publish') {
        issues.push({
          severity: 'info',
          check: 'commands',
          ruleId: 'commands/npm-auth-trap',
          line: ref.line,
          message: `"${cmd}" — npm ${op} requires a 2FA-authenticated session; CLI returns 422 under WebAuthn-only auth`,
          suggestion:
            'Under WebAuthn 2FA without a TOTP fallback, the npm website UI (npmjs.com/package/<pkg>/settings) is the only path that works. For recurring writes, prefer a CI-driven workflow using a granular NPM_TOKEN secret.',
          detail:
            'npm treats CLI web-auth tokens as not-2FA-authenticated for writes; WebAuthn yields no TOTP code to satisfy the check.',
        });
      }
    }

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
    const npxMatch = cmd.match(NPX_PATTERN);
    if (npxMatch && pkgJson) {
      const pkgName = npxMatch[1];
      // Skip scoped packages (just check the base name) and flags
      if (pkgName.startsWith('-')) continue;

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
    return fs.readFileSync(path.join(projectRoot, 'Makefile'), 'utf-8');
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
